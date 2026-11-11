// workflow/disturbance-flow.mts — 扰动处置流程定义（任务 3.2-partB）。
//
// 节点序列 = docs/Agent化架构优化方案.md 3.2 结构图的代码化：
//   接收事件 → 登记事件（写）→ 加载真实上下文（只读）→ 检索经验（只读）→ Agent 建议模式/权重 → 校验建议
//   → 创建重调度任务（写）→ 轮询任务结果 →［full-retry：INFEASIBLE/FAILED 异常分支］
//   → 对比方案（只读）→ Agent 生成评审材料 → 提交评审（写）→ 挂起待人工决策。
// 异常分支（在相关节点内判定，返回对应 action）：
//   - 任务 FAILED / 结果 INFEASIBLE → 解释冲突后按 ALLOW_FULL_RESCHEDULE_ONCE 升级
//     FULL_RESCHEDULE 重试一次（full-retry 节点），再失败 suspend(needs-human)；
//   - fjsp_task_status 超时返回 RUNNING 快照（非终态）→ retry 继续轮询（runner 限次兜底）；
//     可行终态口径 = status ∈ {SUCCESS, TIME_LIMIT} 且 resultStatus=FEASIBLE；
//   - E_EVENT_IN_PROCESS → suspend(needs-human)，严禁自动移动真实事件时间；
//   - E_VERSION_STALE（乐观锁）→ 节点内重读最新 version 后 retry（限次由 runner maxAttempts 兜底）；
//   - 其余错误 envelope 原样交 runner 按 fjsp-tools 错误分类路由（terminal → terminate 等）。
// 写节点的幂等键一律取自 ctx.checkpoint.current.idempotencyKey（wfId:node:seq），
// 重试复用同键由 runner/checkpoint 保证。tools 与 agent 均为注入接口，本模块不接真实服务/LLM。
// 公共件（工具面契约、judgeTask 终态判定、提交评审节点体等）在 flow-common.mts（任务 5.2 抽取）。
import type { NodeContext, NodeAction, WorkflowNode, ErrorEnvelope } from './runner.mts'
import {
  envError,
  isErr,
  judgeTask,
  pickDefined,
  runSubmitReview,
  stepResult,
  toolsOf,
} from './flow-common.mts'
import {
  ALLOW_FULL_RESCHEDULE_ONCE,
  buildReviewMaterial,
  defaultExplainConflicts,
  validateStrategySuggestion,
  type DisturbanceAgent,
  type DisturbanceContext,
  type RescheduleMode,
  type ReviewMaterialInput,
  type StrategyInput,
  type StrategySuggestion,
} from './agent-nodes.mts'

// 工具面契约与公共助手已抽到 flow-common.mts；此处 re-export 保持既有 import 路径不变。
export type { ToolStructured, FlowTools } from './flow-common.mts'

// 触发输入：checkpoint.trigger.detail 的契约形状。BREAKDOWN = 设备故障，NEW_ORDER = 插单。
export interface DisturbanceEventInput {
  eventType: 'BREAKDOWN' | 'NEW_ORDER'
  // BREAKDOWN
  machineId?: string
  occurredAt?: string // 真实事件发生时间，任何分支都不得自动修改
  repairDurationMinutes?: number
  // NEW_ORDER
  orderCode?: string
  productFamily?: string
  quantity?: number
  arrivalAt?: string
  dueAt?: string
  priority?: number
  subType?: string
  note?: string
}

const REQUIRED_FIELDS: Record<DisturbanceEventInput['eventType'], (keyof DisturbanceEventInput)[]> = {
  BREAKDOWN: ['machineId', 'occurredAt', 'repairDurationMinutes'],
  NEW_ORDER: ['orderCode', 'productFamily', 'quantity', 'arrivalAt', 'dueAt', 'priority', 'occurredAt'],
}

function agentOf(ctx: NodeContext): DisturbanceAgent | null {
  const a = ctx.agent as DisturbanceAgent | undefined
  return a && typeof a === 'object' ? a : null
}

// 节点 1：接收事件 —— 校验触发输入完整性，并读当前发布计划作为重调度基准（只读）。
async function receiveEvent(ctx: NodeContext): Promise<NodeAction | ErrorEnvelope> {
  const detail = (ctx.checkpoint.trigger.detail ?? null) as DisturbanceEventInput | null
  if (!detail || (detail.eventType !== 'BREAKDOWN' && detail.eventType !== 'NEW_ORDER')) {
    return { action: 'terminate', reason: '触发输入缺失或 eventType 非法（期望 BREAKDOWN / NEW_ORDER），不可恢复' }
  }
  const missing = REQUIRED_FIELDS[detail.eventType].filter((f) => detail[f] === undefined || detail[f] === null || detail[f] === '')
  if (missing.length) {
    return { action: 'terminate', reason: `触发输入缺少必填字段：${missing.join(' / ')}（${detail.eventType}），不可恢复` }
  }
  const dash = await toolsOf(ctx).call('fjsp_get_dashboard')
  if (isErr(dash)) return dash as ErrorEnvelope
  const currentPlan = dash.currentPlan as { id?: string; kpi?: Record<string, unknown> } | null
  if (!currentPlan?.id) return envError('FJSP_NO_PUBLISHED_PLAN', '当前没有已发布计划，无法执行扰动处置')
  return {
    action: 'advance',
    result: { event: detail, oldPlanVersionId: currentPlan.id, baselineKpi: currentPlan.kpi ?? null },
  }
}

// 节点 2：登记事件（写，幂等键来自检查点）。E_EVENT_IN_PROCESS → suspend(needs-human)：
// 事件发生时间与在制工序冲突时只能由人工核实真实时间，流程不得自动移动事件时间。
async function registerEvent(ctx: NodeContext): Promise<NodeAction | ErrorEnvelope> {
  const prev = stepResult(ctx, 'receive-event')!
  const event = prev.event as DisturbanceEventInput
  const idempotencyKey = ctx.checkpoint.current!.idempotencyKey
  const args =
    event.eventType === 'BREAKDOWN'
      ? { ...pickDefined(event as Record<string, unknown>, ['machineId', 'occurredAt', 'repairDurationMinutes', 'note']), idempotencyKey }
      : { ...pickDefined(event as Record<string, unknown>, ['orderCode', 'productFamily', 'quantity', 'arrivalAt', 'dueAt', 'priority', 'occurredAt', 'subType', 'note']), idempotencyKey }
  const out = await toolsOf(ctx).call(event.eventType === 'BREAKDOWN' ? 'fjsp_report_breakdown' : 'fjsp_insert_order', args)
  if (isErr(out)) {
    if (out.error?.code === 'E_EVENT_IN_PROCESS') {
      return {
        action: 'suspend',
        reason: `事件发生时间与在制工序冲突（E_EVENT_IN_PROCESS）：需人工核实真实发生时间后改期重试，流程不自动移动事件时间。${out.error.message ?? ''}`,
      }
    }
    return out as ErrorEnvelope
  }
  const ev = out.event as { eventId?: string }
  return { action: 'advance', result: { eventId: ev.eventId, event }, refs: { eventId: ev.eventId ?? null } }
}

// 登记后加载真实决策上下文，固定原计划版本，不隐式切换到新的发布计划。
async function loadContext(ctx: NodeContext): Promise<NodeAction | ErrorEnvelope> {
  const { oldPlanVersionId } = stepResult(ctx, 'receive-event')! as { oldPlanVersionId: string }
  const eventId = ctx.checkpoint.refs.eventId
  if (!eventId) return envError('FJSP_BAD_RESPONSE', '事件登记未返回 eventId，不执行后续重调度')
  const out = await toolsOf(ctx).call('fjsp_get_disturbance_context', { eventId, planVersionId: oldPlanVersionId })
  if (isErr(out)) return out as ErrorEnvelope
  const context = out.context as DisturbanceContext | undefined
  if (!context || context.schemaVersion !== 1 || context.event?.eventId !== eventId
      || context.event.eventType !== (stepResult(ctx, 'receive-event')!.event as DisturbanceEventInput).eventType
      || context.baselinePlan?.id !== oldPlanVersionId
      || !Number.isInteger(context.constraints?.freezeWindowMinutes)
      || context.constraints.freezeWindowMinutes < 0 || context.constraints.freezeWindowMinutes > 1440
      || !Array.isArray(context.affectedOrders) || !context.deadlinePressure
      || !['hardLockedCount', 'softLockedCount', 'impactedOperationCount', 'impactedOrderCount'].every((key) => {
        const count = context.constraints[key as keyof DisturbanceContext['constraints']]
        return typeof count === 'number' && Number.isInteger(count) && count >= 0
      })
      || !context.constraints.modeEstimates || !context.constraints.impactSummary
      || !context.provenance || !Array.isArray(context.limitations)) {
    return envError('FJSP_BAD_RESPONSE', '扰动上下文缺失或事件/原计划/冻结窗口不匹配')
  }
  return { action: 'advance', result: { context } }
}

// 节点 3：检索经验（RAG query，只读）
async function queryExperience(ctx: NodeContext): Promise<NodeAction | ErrorEnvelope> {
  const { event } = stepResult(ctx, 'receive-event')! as { event: DisturbanceEventInput }
  const query =
    event.eventType === 'BREAKDOWN'
      ? `${event.machineId} 设备故障停机，预计维修 ${event.repairDurationMinutes} 分钟`
      : `插单 ${event.orderCode}（${event.productFamily}×${event.quantity}，优先级 ${event.priority}）`
  const out = await toolsOf(ctx).call('fjsp_experience_query', { eventType: event.eventType, query, limit: 10 })
  if (isErr(out)) return out as ErrorEnvelope
  return { action: 'advance', result: { experience: { records: out.records ?? [], recommendation: out.recommendation ?? null } } }
}

// 节点 4：Agent 建议模式/权重（决策节点；未注入 Agent 时 rawSuggestion=null，由下一节点落 fallback）
async function suggestStrategy(ctx: NodeContext): Promise<NodeAction> {
  const agent = agentOf(ctx)
  const { context } = stepResult(ctx, 'load-context')! as { context: DisturbanceContext }
  const { experience } = stepResult(ctx, 'query-experience')! as { experience: unknown }
  if (!agent) {
    ctx.log('未注入 Agent，策略建议落默认策略')
    return { action: 'advance', result: { rawSuggestion: null, invocation: { source: 'rule-fallback', reason: 'NO_AGENT' } } }
  }
  const input: StrategyInput = {
    readAt: context.readAt,
    event: context.event, experience, constraints: context.constraints,
    baselinePlan: context.baselinePlan, affectedOrders: context.affectedOrders,
    deadlinePressure: context.deadlinePressure, provenance: context.provenance,
    limitations: context.limitations,
  }
  const raw = await agent.suggestStrategy(input)
  return { action: 'advance', result: { rawSuggestion: raw ?? null, invocation: agent.lastInvocation?.() ?? { source: 'injected-agent' } } }
}

// 节点 5：校验建议 —— validateStrategySuggestion 把关；非法输出落 fallback 并记录拒绝原因，流程继续。
async function validateStrategy(ctx: NodeContext): Promise<NodeAction> {
  const { rawSuggestion } = stepResult(ctx, 'suggest-strategy')! as { rawSuggestion: unknown }
  const v = validateStrategySuggestion(rawSuggestion)
  if (v.ok) return { action: 'advance', result: { strategy: v.strategy } }
  ctx.log(`Agent 策略建议被驳回（${v.rejectedReasons.length} 项）：${v.rejectedReasons.join('；')}，落默认策略`)
  return { action: 'advance', result: { strategy: v.strategy, fallbackReasons: v.rejectedReasons } }
}

// 节点 6：创建重调度任务（写，幂等键来自检查点）
async function createReschedule(ctx: NodeContext): Promise<NodeAction | ErrorEnvelope> {
  const { oldPlanVersionId } = stepResult(ctx, 'receive-event')! as { oldPlanVersionId: string }
  const { strategy } = stepResult(ctx, 'validate-strategy')! as { strategy: StrategySuggestion }
  const eventId = ctx.checkpoint.refs.eventId!
  const out = await toolsOf(ctx).call('fjsp_reschedule', {
    mode: strategy.mode,
    eventId,
    oldPlanVersionId,
    weights: strategy.weights,
    freezeWindowMinutes: (stepResult(ctx, 'load-context')!.context as DisturbanceContext).constraints.freezeWindowMinutes,
    idempotencyKey: ctx.checkpoint.current!.idempotencyKey,
  })
  if (isErr(out)) return out as ErrorEnvelope
  const task = out.task as { taskId?: string }
  return { action: 'advance', result: { taskId: task.taskId, mode: strategy.mode }, refs: { taskId: task.taskId ?? null } }
}

// 节点 7：轮询任务结果（fjsp_task_status 语义：工具内部等待至终态，超时返回 RUNNING 快照）。
// 非终态（pending）→ retry 继续轮询（限次由 runner maxAttempts 兜底）；
// FAILED / INFEASIBLE 不在此处置，记入产出由 full-retry 节点判定分支。
async function pollTask(ctx: NodeContext): Promise<NodeAction | ErrorEnvelope> {
  const taskId = ctx.checkpoint.refs.taskId!
  const out = await toolsOf(ctx).call('fjsp_task_status', { taskId, waitSeconds: 60 })
  if (isErr(out)) return out as ErrorEnvelope
  const { outcome, task } = judgeTask(out)
  if (outcome === 'pending') {
    return { action: 'retry', reason: `任务 ${taskId} 未达终态（status=${task.status ?? '未知'}），复用本节点继续轮询` }
  }
  const planVersionId = (task.planVersionId as string | undefined) ?? null
  if (outcome === 'feasible' && !planVersionId) {
    return envError('FJSP_BAD_RESPONSE', `任务 ${taskId} 终态可行但未返回 planVersionId，结果不完整，重试读取`)
  }
  return {
    action: 'advance',
    result: { outcome, taskId, planVersionId, kpi: task.kpi ?? null, conflicts: task.conflicts ?? [], errorMessage: task.errorMessage ?? null },
    ...(planVersionId ? { refs: { planVersionId } } : {}),
  }
}

// 节点 8：INFEASIBLE / FAILED 异常分支 —— 解释冲突后按 ALLOW_FULL_RESCHEDULE_ONCE
// 升级 FULL_RESCHEDULE 重试一次；首次任务即 FEASIBLE 时本节点直接放行（no-op）。
// 再失败或策略本已是 FULL → suspend(needs-human)，不做第二次自动重排。
async function fullRetry(ctx: NodeContext): Promise<NodeAction | ErrorEnvelope> {
  const poll = stepResult(ctx, 'poll-task')! as {
    outcome: 'feasible' | 'infeasible' | 'failed'
    conflicts: unknown[]
    errorMessage: string | null
  }
  if (poll.outcome === 'feasible') return { action: 'advance' }

  const { event } = stepResult(ctx, 'receive-event')! as { event: DisturbanceEventInput }
  const { strategy } = stepResult(ctx, 'validate-strategy')! as { strategy: StrategySuggestion }
  const agent = agentOf(ctx)
  const explanation = agent
    ? await agent.explainConflicts({ outcome: poll.outcome, mode: strategy.mode, conflicts: poll.conflicts, errorMessage: poll.errorMessage, event: event as StrategyInput['event'] })
    : defaultExplainConflicts({ outcome: poll.outcome, mode: strategy.mode, conflicts: poll.conflicts, errorMessage: poll.errorMessage, event: event as StrategyInput['event'] })
  const explanationInvocation = agent?.lastInvocation?.() ?? { source: agent ? 'injected-agent' : 'rule-fallback' }
  ctx.log(`冲突解释来源：${JSON.stringify(explanationInvocation)}`)
  ctx.log(`重调度${poll.outcome === 'failed' ? '任务失败' : '结果不可行'}，冲突解释：\n${explanation}`)

  if (!ALLOW_FULL_RESCHEDULE_ONCE || strategy.mode === 'FULL_RESCHEDULE') {
    return { action: 'suspend', reason: `重调度${poll.outcome === 'failed' ? '失败' : '不可行'}且不允许/无法再自动升级重试，转人工处置。\n${explanation}` }
  }

  const { oldPlanVersionId } = stepResult(ctx, 'receive-event')! as { oldPlanVersionId: string }
  const eventId = ctx.checkpoint.refs.eventId!
  const tools = toolsOf(ctx)
  const retried = await tools.call('fjsp_reschedule', {
    mode: 'FULL_RESCHEDULE' satisfies RescheduleMode,
    eventId,
    oldPlanVersionId,
    weights: strategy.weights,
    freezeWindowMinutes: (stepResult(ctx, 'load-context')!.context as DisturbanceContext).constraints.freezeWindowMinutes,
    idempotencyKey: ctx.checkpoint.current!.idempotencyKey,
  })
  if (isErr(retried)) return retried as ErrorEnvelope
  const task2 = (retried.task ?? {}) as { taskId?: string }
  const out2 = await tools.call('fjsp_task_status', { taskId: task2.taskId, waitSeconds: 60 })
  if (isErr(out2)) return out2 as ErrorEnvelope
  const j2 = judgeTask(out2)
  if (j2.outcome === 'pending') {
    // 未达终态：整节点 retry——fjsp_reschedule 复用同一幂等键由服务端幂等回放返回同一任务，再轮询
    return { action: 'retry', reason: `FULL_RESCHEDULE 任务 ${task2.taskId} 未达终态（status=${j2.task.status ?? '未知'}），继续轮询` }
  }
  const planVersionId = (j2.task.planVersionId as string | undefined) ?? null
  if (j2.outcome === 'feasible' && !planVersionId) {
    return envError('FJSP_BAD_RESPONSE', `任务 ${task2.taskId} 终态可行但未返回 planVersionId，结果不完整，重试读取`)
  }
  if (j2.outcome !== 'feasible') {
    return {
      action: 'suspend',
      reason: `FULL_RESCHEDULE 重试仍${j2.outcome === 'failed' ? '失败' : '不可行'}，转人工处置。\n${explanation}`,
    }
  }
  return {
    action: 'advance',
    result: {
      retriedFrom: poll.outcome,
      mode: 'FULL_RESCHEDULE',
      explanation,
      explanationInvocation,
      taskId: task2.taskId,
      planVersionId,
      kpi: j2.task.kpi ?? null,
      conflicts: j2.task.conflicts ?? [],
    },
    refs: { taskId: task2.taskId ?? null, planVersionId },
  }
}

// 节点 9：对比方案（只读）：候选 vs 当前发布计划
async function comparePlans(ctx: NodeContext): Promise<NodeAction | ErrorEnvelope> {
  const planVersionId = ctx.checkpoint.refs.planVersionId!
  const { oldPlanVersionId } = stepResult(ctx, 'receive-event')! as { oldPlanVersionId: string }
  const out = await toolsOf(ctx).call('fjsp_compare_plans', { planVersionId, baselineVersionId: oldPlanVersionId })
  if (isErr(out)) return out as ErrorEnvelope
  return { action: 'advance', result: { diff: out.diff ?? null } }
}

// 节点 10：Agent 生成评审材料（生成节点；输入只读 KPI/对比数据，无写操作）。
// Agent 未注入或输出非法（非非空字符串）时落确定性兜底 buildReviewMaterial。
async function reviewMaterial(ctx: NodeContext): Promise<NodeAction> {
  const { context } = stepResult(ctx, 'load-context')! as { context: DisturbanceContext }
  const event = context.event
  const baselineKpi = context.baselinePlan.kpi
  const { strategy } = stepResult(ctx, 'validate-strategy')! as { strategy: StrategySuggestion }
  const retry = stepResult(ctx, 'full-retry') as { kpi?: Record<string, unknown>; explanation?: string } | null
  const poll = stepResult(ctx, 'poll-task')! as { kpi?: Record<string, unknown>; outcome: string }
  const { diff } = stepResult(ctx, 'compare-plans')! as { diff: unknown }
  const input: ReviewMaterialInput = {
    event: event as ReviewMaterialInput['event'],
    strategy,
    task: {
      taskId: ctx.checkpoint.refs.taskId ?? undefined,
      resultStatus: poll.outcome === 'feasible' ? 'FEASIBLE' : 'FEASIBLE_AFTER_FULL_RETRY',
      kpi: (retry?.kpi as Record<string, unknown> | undefined) ?? (poll.kpi as Record<string, unknown> | undefined) ?? null,
    },
    baselineKpi,
    diff,
    conflictExplanation: retry?.explanation ?? null,
  }
  const agent = agentOf(ctx)
  let material: unknown = agent ? await agent.buildReviewMaterial(input) : null
  if (typeof material !== 'string' || material.trim().length === 0) {
    if (agent) ctx.log('Agent 评审材料输出非法（非非空字符串），落确定性兜底生成')
    material = buildReviewMaterial(input)
  }
  return { action: 'advance', result: { material, invocation: agent?.lastInvocation?.() ?? { source: agent ? 'injected-agent' : 'rule-fallback' } } }
}

// 节点 11：提交评审（写）。节点体共享自 flow-common.runSubmitReview：
// fjsp_get_plan 读乐观锁 version → fjsp_submit_review；E_VERSION_STALE 重读后 retry 限次重试。
async function submitReview(ctx: NodeContext): Promise<NodeAction | ErrorEnvelope> {
  return runSubmitReview(ctx)
}

// 节点 12：挂起待人工决策 —— 评审材料已提交（REVIEW_PENDING），审批句柄入检查点，不回放旧批准。
async function awaitDecision(ctx: NodeContext): Promise<NodeAction> {
  const { material } = stepResult(ctx, 'review-material')! as { material: string }
  ctx.log(`评审材料：\n${material}`)
  return {
    action: 'suspend',
    reason: '候选方案已提交评审（REVIEW_PENDING），等待人工评审决策；评审通过与发布均需人工审批确认',
    awaitApproval: {
      tool: 'fjsp_approve_review',
      bizObject: ctx.checkpoint.refs.planVersionId,
      args: { planVersionId: ctx.checkpoint.refs.planVersionId }, // BFF 登记时生成参数摘要/指纹
    },
  }
}

// 扰动处置流程：返回节点数组供 runWorkflow 执行。deps 无状态，工具与 Agent 经 ctx 注入。
export function buildDisturbanceFlow(): WorkflowNode[] {
  return [
    { name: 'receive-event', run: receiveEvent },
    { name: 'register-event', run: registerEvent },
    { name: 'load-context', run: loadContext },
    { name: 'query-experience', run: queryExperience },
    { name: 'suggest-strategy', run: suggestStrategy },
    { name: 'validate-strategy', run: validateStrategy },
    { name: 'create-reschedule', run: createReschedule },
    { name: 'poll-task', run: pollTask },
    { name: 'full-retry', run: fullRetry },
    { name: 'compare-plans', run: comparePlans },
    { name: 'review-material', run: reviewMaterial },
    { name: 'submit-review', run: submitReview },
    { name: 'await-decision', run: awaitDecision },
  ]
}

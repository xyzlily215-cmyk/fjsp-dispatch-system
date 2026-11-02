// workflow/baseline-flow.mts — 基线排程流程定义（任务 5.2）。
//
// 节点序列（形态对齐 disturbance-flow）：
//   校验主数据就绪（只读：设备/订单/工艺模板数量）→ 创建基线排程任务（fjsp_create_baseline，
//   写，幂等键来自检查点）→ 轮询任务结果（judgeTask 终态判定，复用任务 3.2b 语义）
//   → 产出计划版本 → 挂起待人工确认进入评审（交评审发布流程，独立工作流实例接力）。
// 异常分支（在相关节点内判定，返回对应 action）：
//   - 主数据不全（设备/订单/工艺模板任一为 0）→ suspend(needs-input)，人工维护主数据后重跑；
//   - 任务 FAILED / 结果 INFEASIBLE → 解释冲突后 suspend(needs-human)。
//     基线不做 FULL_RESCHEDULE 升级：没有"旧计划"语义，升级重排无从谈起；
//   - fjsp_task_status 超时返回 RUNNING 快照（非终态）→ retry 继续轮询（runner 限次兜底）；
//   - 触发输入的 weights 非法（键集合/数值范围，同 agent-nodes 契约）→ terminate。
// 与评审发布流程的接力设计：本流程在产出计划版本后挂起，审批句柄 tool=fjsp_submit_review
// 作为"人工确认进入评审"的决策点；批准后本流程即完成，评审发布由 review-publish-flow
// 以 planVersionId 为输入独立触发（dedupeKey=review:{planVersionId}），两条流程的审批点
// 各自独立留痕，互不合并。
import type { NodeContext, NodeAction, WorkflowNode, ErrorEnvelope } from './runner.mts'
import { envError, isErr, judgeTask, pickDefined, stepResult, toolsOf } from './flow-common.mts'
import { WEIGHT_KEYS, MAX_WEIGHT_KEYS } from './agent-nodes.mts'

// 触发输入：checkpoint.trigger.detail 的契约形状。全部可选：缺省对全部在制订单全量排程。
export interface BaselineFlowInput {
  orderIds?: string[] // 指定订单子集；不传 = 全部
  weights?: Record<string, number> // 目标权重（键集合/数值约束同 agent-nodes 的 WEIGHT_KEYS 契约）
  seed?: number // 随机种子（可复现性验收用）
  note?: string
}

// 冲突解释的 Agent 注入接口（可选）；未注入或输出非法时用 defaultExplainBaselineConflicts。
export interface BaselineAgent {
  explainConflicts(input: { outcome: 'infeasible' | 'failed'; conflicts?: unknown[]; errorMessage?: string | null }): string | Promise<string>
}

function agentOf(ctx: NodeContext): BaselineAgent | null {
  const a = ctx.agent as BaselineAgent | undefined
  return a && typeof a === 'object' && typeof a.explainConflicts === 'function' ? a : null
}

// 基线排程 INFEASIBLE/FAILED 的确定性冲突解释（无 Agent 时的兜底，纯只读）
export function defaultExplainBaselineConflicts(input: { outcome: 'infeasible' | 'failed'; conflicts?: unknown[]; errorMessage?: string | null }): string {
  const head =
    input.outcome === 'failed'
      ? `基线排程任务执行失败${input.errorMessage ? `：${input.errorMessage}` : ''}`
      : '基线排程结果不可行 INFEASIBLE（常见原因：工艺模板与设备能力不匹配、订单交期过紧、主数据不全）'
  const items = (input.conflicts ?? []).slice(0, 10).map((c) => {
    if (c && typeof c === 'object') {
      const r = c as Record<string, unknown>
      return `- ${[r.type ?? r.code, r.machineId ?? r.orderId ?? '', r.message ?? r.detail ?? ''].filter(Boolean).join('：')}`
    }
    return `- ${String(c)}`
  })
  return [head, ...(items.length ? ['冲突明细：', ...items] : ['（服务未返回冲突明细）'])].join('\n')
}

// 校验触发输入的 weights：键 ⊆ WEIGHT_KEYS、非负有限数、≤16 键（同 agent-nodes 契约，
// 以 fjsp-tools WEIGHTS schema / algorithm-service SolveRequest 校验为准）。返回非法原因列表。
export function validateBaselineWeights(weights: unknown): string[] {
  const reasons: string[] = []
  if (weights === undefined) return reasons
  if (!weights || typeof weights !== 'object' || Array.isArray(weights)) return ['weights 必须是对象']
  const entries = Object.entries(weights as Record<string, unknown>)
  if (entries.length > MAX_WEIGHT_KEYS) reasons.push(`weights 键数 ${entries.length} 超过上限 ${MAX_WEIGHT_KEYS}`)
  for (const [k, v] of entries) {
    if (!(WEIGHT_KEYS as readonly string[]).includes(k)) {
      reasons.push(`weights 含未知键 ${k}（允许 ${WEIGHT_KEYS.join(' / ')}）`)
      continue
    }
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) reasons.push(`weights.${k} 必须是非负有限数，实际 ${JSON.stringify(v)}`)
  }
  return reasons
}

function triggerInput(ctx: NodeContext): BaselineFlowInput {
  return (ctx.checkpoint.trigger.detail ?? {}) as BaselineFlowInput
}

// 节点 1：校验主数据就绪（只读）——设备/订单/工艺模板数量检查，任一为 0 即主数据不全。
async function checkMasterData(ctx: NodeContext): Promise<NodeAction | ErrorEnvelope> {
  const tools = toolsOf(ctx)
  const dash = await tools.call('fjsp_get_dashboard')
  if (isErr(dash)) return dash as ErrorEnvelope
  const tpl = await tools.call('fjsp_list_process_templates')
  if (isErr(tpl)) return tpl as ErrorEnvelope
  const machineCount = Array.isArray(dash.machines) ? dash.machines.length : 0
  // orderStats 是 {status: count} 映射，总数 = 各状态计数之和
  const orderStats = (dash.orderStats ?? {}) as Record<string, unknown>
  const orderCount = Object.values(orderStats).reduce((sum, v) => sum + (typeof v === 'number' ? v : 0), 0)
  const templateCount = Array.isArray(tpl.templates) ? tpl.templates.length : 0
  const missing: string[] = []
  if (machineCount === 0) missing.push('设备')
  if (orderCount === 0) missing.push('订单')
  if (templateCount === 0) missing.push('工艺模板')
  if (missing.length > 0) {
    return {
      action: 'suspend',
      reason: `主数据不全（needs-input）：${missing.join('、')}数据为 0（设备 ${machineCount} / 订单 ${orderCount} / 工艺模板 ${templateCount}）。请先维护主数据再重跑基线排程。`,
    }
  }
  return { action: 'advance', result: { machineCount, orderCount, templateCount } }
}

// 节点 2：创建基线排程任务（写，幂等键来自检查点）
async function createBaseline(ctx: NodeContext): Promise<NodeAction | ErrorEnvelope> {
  const input = triggerInput(ctx)
  const badWeights = validateBaselineWeights(input.weights)
  if (badWeights.length > 0) {
    return { action: 'terminate', reason: `触发输入 weights 非法，不可恢复：${badWeights.join('；')}` }
  }
  const out = await toolsOf(ctx).call('fjsp_create_baseline', {
    ...pickDefined(input as Record<string, unknown>, ['orderIds', 'weights', 'seed']),
    idempotencyKey: ctx.checkpoint.current!.idempotencyKey,
  })
  if (isErr(out)) return out as ErrorEnvelope
  const task = out.task as { taskId?: string }
  return { action: 'advance', result: { taskId: task.taskId, mode: 'BASELINE' }, refs: { taskId: task.taskId ?? null } }
}

// 节点 3：轮询任务结果。非终态 → retry 继续轮询；FAILED/INFEASIBLE → 解释冲突后
// suspend(needs-human)（基线无 FULL_RESCHEDULE 升级分支）；feasible → 产出 planVersionId。
async function pollTask(ctx: NodeContext): Promise<NodeAction | ErrorEnvelope> {
  const taskId = ctx.checkpoint.refs.taskId!
  const out = await toolsOf(ctx).call('fjsp_task_status', { taskId, waitSeconds: 60 })
  if (isErr(out)) return out as ErrorEnvelope
  const { outcome, task } = judgeTask(out)
  if (outcome === 'pending') {
    return { action: 'retry', reason: `任务 ${taskId} 未达终态（status=${task.status ?? '未知'}），复用本节点继续轮询` }
  }
  if (outcome !== 'feasible') {
    const input = { outcome, conflicts: (task.conflicts as unknown[]) ?? [], errorMessage: (task.errorMessage as string | null) ?? null }
    const agent = agentOf(ctx)
    let explanation: unknown = agent ? await agent.explainConflicts(input) : null
    if (typeof explanation !== 'string' || explanation.trim().length === 0) {
      explanation = defaultExplainBaselineConflicts(input)
    }
    ctx.log(`基线排程${outcome === 'failed' ? '任务失败' : '结果不可行'}，冲突解释：\n${explanation}`)
    return {
      action: 'suspend',
      reason: `基线排程${outcome === 'failed' ? '失败' : '不可行'}，转人工处置（基线无"旧计划"语义，不做 FULL_RESCHEDULE 自动升级）。\n${explanation}`,
    }
  }
  const planVersionId = (task.planVersionId as string | undefined) ?? null
  if (!planVersionId) {
    return envError('FJSP_BAD_RESPONSE', `任务 ${taskId} 终态可行但未返回 planVersionId，结果不完整，重试读取`)
  }
  return {
    action: 'advance',
    result: { outcome, taskId, planVersionId, kpi: task.kpi ?? null },
    refs: { planVersionId },
  }
}

// 节点 4：挂起待人工确认进入评审 —— 计划版本已产出（DRAFT），审批句柄 tool=fjsp_submit_review
// 作为"人工确认进入评审"决策点；批准后本流程完成，由 review-publish-flow 接力。
async function awaitReviewHandoff(ctx: NodeContext): Promise<NodeAction> {
  const planVersionId = ctx.checkpoint.refs.planVersionId!
  const { kpi } = stepResult(ctx, 'poll-task')! as { kpi: unknown }
  ctx.log(`基线计划版本已产出：${planVersionId}，KPI=${JSON.stringify(kpi ?? null)}`)
  return {
    action: 'suspend',
    reason: `基线计划版本 ${planVersionId} 已产出（DRAFT），等待人工确认进入评审发布流程（review-publish-flow，独立工作流实例）`,
    awaitApproval: {
      tool: 'fjsp_submit_review',
      bizObject: planVersionId,
      args: { planVersionId }, // BFF 登记时生成参数摘要/指纹
    },
  }
}

// 基线排程流程：返回节点数组供 runWorkflow 执行。deps 无状态，工具与 Agent 经 ctx 注入。
export function buildBaselineFlow(): WorkflowNode[] {
  return [
    { name: 'check-master-data', run: checkMasterData },
    { name: 'create-baseline', run: createBaseline },
    { name: 'poll-task', run: pollTask },
    { name: 'await-review-handoff', run: awaitReviewHandoff },
  ]
}

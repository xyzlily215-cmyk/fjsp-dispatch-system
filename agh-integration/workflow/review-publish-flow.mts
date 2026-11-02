// workflow/review-publish-flow.mts — 评审发布流程定义（任务 5.2）。
//
// 输入为已有 planVersionId（trigger.detail.planVersionId，通常由 baseline-flow /
// disturbance-flow 产出后接力触发，dedupeKey 约定 review:{planVersionId}）。
//
// 节点序列：
//   读取计划版本与对比基准（只读）→ 方案对比（只读，无基线可跳过）→ Agent 生成评审材料
//   （只读生成节点）→ 提交评审（写，共享 flow-common.runSubmitReview）→ 挂起待人工评审
//   （fjsp_approve_review，REVIEWER 级）→ 评审通过后挂起待人工独立确认发布
//   （fjsp_publish，PRODUCTION_MANAGER 级）→ 发布（fjsp_publish，写）。
// 方案红线：评审通过与发布是两个独立人工决策点（两个独立审批句柄，不合并为一个审批）；
// 评审拒绝 → settleReviewPublishOutcome 落地：经验反馈（5.1 接线，仅有检索记录时）→
// 返修回路（fjsp_revise_plan 退回 DRAFT 后重新提交评审，限 1 次）→ 再次拒绝显式终止。
// 写节点幂等键一律取自检查点步骤键（wfId:node:seq）。tools 与 agent 均为注入接口。
import type { NodeContext, NodeAction, WorkflowNode, ErrorEnvelope, RunDeps } from './runner.mts'
import { suspendForApproval } from './runner.mts'
import type { CheckpointStore, PendingApproval, WorkflowCheckpoint } from './checkpoint.mts'
import { settleApprovalOutcome } from './bff-approval.mts'
import {
  collectExperienceIds,
  isErr,
  runSubmitReview,
  sendExperienceFeedback,
  stepResult,
  toolsOf,
  type FlowTools,
} from './flow-common.mts'
import { buildPlanReviewMaterial, type PlanReviewMaterialInput, type ReviewPublishAgent } from './agent-nodes.mts'

// 审批角色显式常量：与 agent-bff/server.mts TOOL_ROLES（任务 1.2，对齐 business-service
// PlanVersionController 的 @PreAuthorize）保持一致——评审 = REVIEWER 级，发布 = PRODUCTION_MANAGER 级。
export const REVIEW_DECISION_ROLES = ['REVIEWER', 'ADMIN']
export const PUBLISH_CONFIRM_ROLES = ['PRODUCTION_MANAGER', 'ADMIN']

// 返修回路上限：评审拒绝后只允许 revise + 重新提交一次，再次拒绝显式终止。
export const REVIEW_REVISE_LIMIT = 1

// 触发输入：checkpoint.trigger.detail 的契约形状。
export interface ReviewPublishInput {
  planVersionId: string // 必填：待评审发布的计划版本
  baselineVersionId?: string // 对比基准；不传时取当前发布计划（与候选不同才对比）
  experienceIds?: string[] // 本次处置的经验检索记录 id（上游流程传入；评审拒绝时用于追加负面反馈）
}

function agentOf(ctx: NodeContext): ReviewPublishAgent | null {
  const a = ctx.agent as ReviewPublishAgent | undefined
  return a && typeof a === 'object' && typeof a.buildPlanReviewMaterial === 'function' ? a : null
}

function triggerInput(ctx: NodeContext): ReviewPublishInput {
  return (ctx.checkpoint.trigger.detail ?? {}) as ReviewPublishInput
}

// 节点 1：读取计划版本与对比基准（只读）。planVersionId 缺失属触发输入不完整，不可恢复。
async function loadPlan(ctx: NodeContext): Promise<NodeAction | ErrorEnvelope> {
  const input = triggerInput(ctx)
  if (!input.planVersionId || typeof input.planVersionId !== 'string') {
    return { action: 'terminate', reason: '触发输入缺少 planVersionId，不可恢复' }
  }
  const tools = toolsOf(ctx)
  const planOut = await tools.call('fjsp_get_plan', { planVersionId: input.planVersionId })
  if (isErr(planOut)) return planOut as ErrorEnvelope
  const plan = planOut.plan as { id?: string; status?: string; versionCode?: string; kpi?: Record<string, unknown> | null }
  // 对比基准：触发输入指定优先；否则取当前发布计划（与候选不同才对比，首次基线无基准）
  let baseline: { id?: string; versionCode?: string; kpi?: Record<string, unknown> | null } | null = null
  if (input.baselineVersionId) {
    const b = await tools.call('fjsp_get_plan', { planVersionId: input.baselineVersionId })
    if (isErr(b)) return b as ErrorEnvelope
    baseline = b.plan as typeof baseline
  } else {
    const dash = await tools.call('fjsp_get_dashboard')
    if (isErr(dash)) return dash as ErrorEnvelope
    const cur = dash.currentPlan as { id?: string; versionCode?: string; kpi?: Record<string, unknown> | null } | null
    if (cur?.id && cur.id !== input.planVersionId) baseline = cur
  }
  return {
    action: 'advance',
    result: { plan, baseline },
    refs: { planVersionId: input.planVersionId },
  }
}

// 节点 2：方案对比（只读）。无基线（首次基线发布）时跳过，产出 diff=null。
async function comparePlans(ctx: NodeContext): Promise<NodeAction | ErrorEnvelope> {
  const { plan, baseline } = stepResult(ctx, 'load-plan')! as {
    plan: { id?: string }
    baseline: { id?: string } | null
  }
  if (!baseline?.id) {
    return { action: 'advance', result: { diff: null, note: '无基线可对比（首次基线或未指定对比基准）' } }
  }
  const out = await toolsOf(ctx).call('fjsp_compare_plans', { planVersionId: plan.id, baselineVersionId: baseline.id })
  if (isErr(out)) return out as ErrorEnvelope
  return { action: 'advance', result: { diff: out.diff ?? null } }
}

// 节点 3：Agent 生成评审材料（生成节点；输入只读，无写操作）。
// Agent 未注入或输出非法（非非空字符串）时落确定性兜底 buildPlanReviewMaterial。
async function reviewMaterial(ctx: NodeContext): Promise<NodeAction> {
  const { plan, baseline } = stepResult(ctx, 'load-plan')! as PlanReviewMaterialInput
  const { diff } = stepResult(ctx, 'compare-plans')! as { diff: unknown }
  const input: PlanReviewMaterialInput = {
    planVersionId: ctx.checkpoint.refs.planVersionId!,
    plan,
    baseline,
    diff,
    origin: { type: ctx.checkpoint.type, source: ctx.checkpoint.trigger.source },
  }
  const agent = agentOf(ctx)
  let material: unknown = agent ? await agent.buildPlanReviewMaterial(input) : null
  if (typeof material !== 'string' || material.trim().length === 0) {
    if (agent) ctx.log('Agent 评审材料输出非法（非非空字符串），落确定性兜底生成')
    material = buildPlanReviewMaterial(input)
  }
  return { action: 'advance', result: { material } }
}

// 节点 4：提交评审（写）。节点体共享自 flow-common.runSubmitReview（乐观锁重读 + E_VERSION_STALE retry）。
async function submitReview(ctx: NodeContext): Promise<NodeAction | ErrorEnvelope> {
  return runSubmitReview(ctx)
}

// 节点 5：挂起待人工评审 —— 第一个独立人工决策点（REVIEWER 级）。
async function awaitReview(ctx: NodeContext): Promise<NodeAction> {
  const { material } = stepResult(ctx, 'review-material')! as { material: string }
  ctx.log(`评审材料：\n${material}`)
  return {
    action: 'suspend',
    reason: '候选方案已提交评审（REVIEW_PENDING），等待人工评审决策（第一个独立人工决策点）',
    awaitApproval: {
      tool: 'fjsp_approve_review',
      bizObject: ctx.checkpoint.refs.planVersionId,
      args: { planVersionId: ctx.checkpoint.refs.planVersionId },
      requiredRoles: REVIEW_DECISION_ROLES,
    },
  }
}

// 节点 6：挂起待人工独立确认发布 —— 第二个独立人工决策点（PRODUCTION_MANAGER 级）。
// 方案红线：评审通过不等于同意发布，不得合并为一个审批。
async function awaitPublishConfirm(ctx: NodeContext): Promise<NodeAction> {
  return {
    action: 'suspend',
    reason: '评审已通过（REVIEWED）。发布是独立人工决策点：等待生产主管级人工独立确认后才执行 fjsp_publish',
    awaitApproval: {
      tool: 'fjsp_publish',
      bizObject: ctx.checkpoint.refs.planVersionId,
      args: { planVersionId: ctx.checkpoint.refs.planVersionId },
      requiredRoles: PUBLISH_CONFIRM_ROLES,
    },
  }
}

// 节点 7：发布（写）。fjsp_publish 自带 REVIEWED 状态守卫与"已发布"幂等返回；
// 发布成功后流程完成（COMPLETED）。
async function publish(ctx: NodeContext): Promise<NodeAction | ErrorEnvelope> {
  const planVersionId = ctx.checkpoint.refs.planVersionId!
  const out = await toolsOf(ctx).call('fjsp_publish', { planVersionId, idempotencyKey: ctx.checkpoint.current!.idempotencyKey })
  if (isErr(out)) return out as ErrorEnvelope
  return { action: 'advance', result: { planVersionId, published: true, alreadyPublished: out.alreadyPublished ?? false, ganttUrl: out.ganttUrl ?? null, plan: out.plan ?? null } }
}

// 评审发布流程：返回节点数组供 runWorkflow 执行。deps 无状态，工具与 Agent 经 ctx 注入。
export function buildReviewPublishFlow(): WorkflowNode[] {
  return [
    { name: 'load-plan', run: loadPlan },
    { name: 'compare-plans', run: comparePlans },
    { name: 'review-material', run: reviewMaterial },
    { name: 'submit-review', run: submitReview },
    { name: 'await-review', run: awaitReview },
    { name: 'await-publish-confirm', run: awaitPublishConfirm },
    { name: 'publish', run: publish },
  ]
}

// ---- 评审裁决落地（含返修回路与经验反馈接线）----

// 评审发布流程的裁决落地：发布确认点与普通走向（批准/拒绝/过期）完全复用通用
// settleApprovalOutcome 语义（批准→推进；拒绝→显式终止不发布；过期→重发审批）。
// 只有"评审决策点（fjsp_approve_review）被拒绝"走本流程专属分支：
//   了结挂起 → 经验反馈（任务 5.1 接线：本次处置有经验检索记录时追加 rejected 负面反馈，
//   best-effort 不阻断）→ 返修回路（fjsp_revise_plan 退回 DRAFT → 重新提交评审 →
//   重新挂起等新审批，限 REVIEW_REVISE_LIMIT 次）→ 超限显式终止（不发布）。
export async function settleReviewPublishOutcome(
  store: CheckpointStore,
  workflowId: string,
  deps: RunDeps,
  outcome: 'approved' | 'rejected' | 'expired',
): Promise<WorkflowCheckpoint> {
  const cp = store.load(workflowId)
  if (!cp) throw new Error(`检查点不存在：${workflowId}`)
  const approval = cp.pendingApproval
  if (outcome !== 'rejected' || approval?.tool !== 'fjsp_approve_review') {
    return settleApprovalOutcome(store, workflowId, buildReviewPublishFlow(), deps, outcome)
  }
  return handleReviewRejected(store, workflowId, deps, approval)
}

async function handleReviewRejected(
  store: CheckpointStore,
  workflowId: string,
  deps: RunDeps,
  approval: PendingApproval,
): Promise<WorkflowCheckpoint> {
  const log = deps.log ?? (() => {})
  const planVersionId = store.load(workflowId)!.refs.planVersionId
  store.clearApproval(workflowId)
  store.completeStep(workflowId, { approvalDecision: 'rejected', requestId: approval.requestId ?? null })

  // 经验反馈（任务 5.1 遗留接线）：仅当本次处置有经验检索记录（带 id）时追加负面反馈；
  // 步骤落 completedSteps 作业务证据。反馈是旁路动作：失败只记日志，不改变走向。
  store.beginStep(workflowId, 'experience-feedback')
  const ids = collectExperienceIds(store.load(workflowId)!)
  if (ids.length === 0) {
    store.completeStep(workflowId, { skipped: true, reason: '本次处置无经验检索记录（或记录无 id），不追加反馈' })
  } else {
    const sent = await sendExperienceFeedback(
      { tools: deps.tools, log },
      ids,
      'rejected',
      `人工评审拒绝（workflow ${workflowId}，planVersionId=${planVersionId ?? '无'}）`,
    )
    store.completeStep(workflowId, { outcome: 'rejected', sent, total: ids.length })
  }

  // 返修回路限 1 次：已有 revise-after-reject 步骤 = 已返修过，再次拒绝显式终止。
  const reviseCount = store.load(workflowId)!.completedSteps.filter((s) => s.node === 'revise-after-reject').length
  if (reviseCount >= REVIEW_REVISE_LIMIT) {
    return store.setStatus(workflowId, 'TERMINATED', `评审再次拒绝（已返修 ${reviseCount} 次达上限）：显式终止，不发布（planVersionId=${planVersionId ?? '无'}）`)
  }

  // 返修：fjsp_revise_plan（REJECTED → DRAFT，写，幂等键取自本步骤）
  store.beginStep(workflowId, 'revise-after-reject')
  const reviseKey = store.load(workflowId)!.current!.idempotencyKey
  const revised = await reviseAndResubmit(store, workflowId, deps, planVersionId!, reviseKey, log)
  if (revised) return revised // 失败：步骤结果已落错误明细，工作流 FAILED 转人工

  // 重新挂起等新评审决策（新审批登记，旧批准不回放）
  store.beginStep(workflowId, 'await-review')
  return suspendForApproval(store, workflowId, 'await-review', {
    reason: '返修后已重新提交评审（REVIEW_PENDING），等待人工评审决策（返修回路已用 1 次，再次拒绝将显式终止）',
    awaitApproval: {
      tool: 'fjsp_approve_review',
      bizObject: planVersionId,
      args: { planVersionId },
      requiredRoles: REVIEW_DECISION_ROLES,
    },
  }, deps)
}

// revise + 重新提交评审。失败时落步骤错误明细并置 FAILED（转人工），返回该检查点；
// 成功返回 null 由调用方继续挂起。
async function reviseAndResubmit(
  store: CheckpointStore,
  workflowId: string,
  deps: RunDeps,
  planVersionId: string,
  reviseKey: string,
  log: (msg: string) => void,
): Promise<WorkflowCheckpoint | null> {
  const tools = deps.tools as FlowTools
  if (!tools || typeof tools.call !== 'function') {
    store.completeStep(workflowId, { error: { code: 'E_INTERNAL', message: '未注入 tools（FlowTools.call）' } })
    return store.setStatus(workflowId, 'FAILED', '返修需要 tools 注入，转人工')
  }
  // revise：先读乐观锁 version（reads-before-retry）
  const plan = await tools.call('fjsp_get_plan', { planVersionId })
  if (isErr(plan)) {
    store.completeStep(workflowId, { error: plan.error })
    return store.setStatus(workflowId, 'FAILED', `返修前读取计划版本失败：${plan.error!.code} ${plan.error!.message ?? ''}，转人工`)
  }
  const version = (plan.plan as { version?: number }).version
  if (typeof version !== 'number') {
    store.completeStep(workflowId, { error: { code: 'FJSP_BAD_RESPONSE', message: 'fjsp_get_plan 未返回乐观锁 version' } })
    return store.setStatus(workflowId, 'FAILED', '返修前读取乐观锁 version 失败，转人工')
  }
  const out = await tools.call('fjsp_revise_plan', { planVersionId, version, idempotencyKey: reviseKey })
  if (isErr(out)) {
    store.completeStep(workflowId, { error: out.error })
    return store.setStatus(workflowId, 'FAILED', `返修（revise）失败：${out.error!.code} ${out.error!.message ?? ''}，转人工`)
  }
  store.completeStep(workflowId, { revised: true, plan: out.plan ?? null })
  log(`计划版本 ${planVersionId} 已退回 DRAFT，重新提交评审`)

  // 重新提交评审：复用共享节点体；E_VERSION_STALE 由 runSubmitReview 返回 retry，此处限次循环
  for (let attempt = 1; attempt <= 3; attempt++) {
    store.beginStep(workflowId, 'resubmit-after-revise')
    const ctx: NodeContext = { checkpoint: store.load(workflowId)!, tools: deps.tools, log }
    const action = await runSubmitReview(ctx)
    if ('action' in action && action.action === 'advance') {
      store.completeStep(workflowId, action.result)
      return null
    }
    if ('action' in action && action.action === 'retry' && attempt < 3) {
      log(`重新提交评审重试（${attempt}/3）：${action.reason}`)
      continue
    }
    const reason = 'action' in action ? action.reason : `[${(action as ErrorEnvelope).error.code}] ${(action as ErrorEnvelope).error.message}`
    store.completeStep(workflowId, { error: reason })
    return store.setStatus(workflowId, 'FAILED', `返修后重新提交评审失败：${reason}，转人工`)
  }
  return store.setStatus(workflowId, 'FAILED', '返修后重新提交评审重试耗尽，转人工')
}

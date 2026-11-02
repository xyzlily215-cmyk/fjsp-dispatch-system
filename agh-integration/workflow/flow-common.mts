// workflow/flow-common.mts — 流程共享件（任务 5.2）。
//
// 从 disturbance-flow.mts 抽取的公共部分，供 baseline-flow / review-publish-flow 复用：
//   - 工具面契约（ToolStructured / FlowTools）与取值助手（toolsOf / stepResult / isErr /
//     envError / pickDefined）；
//   - judgeTask：调度任务终态判定（复用任务 3.2b 语义，可行终态口径与
//     evaluation/scenarios/common.mjs 对齐：仅 status ∈ {SUCCESS, TIME_LIMIT} 且
//     resultStatus === 'FEASIBLE' 才算可行终态）；
//   - runSubmitReview：提交评审节点体（fjsp_get_plan 读乐观锁 version → fjsp_submit_review，
//     E_VERSION_STALE 重读后 retry）；
//   - 经验反馈接线（任务 5.1 遗留）：collectExperienceIds / sendExperienceFeedback /
//     makeExperienceFeedbackHook。评审被拒绝/返工时给本次处置检索到的经验记录追加负面
//     反馈；仅当该次处置有经验检索记录（带 id）时才调用 fjsp_experience_feedback。
//     反馈是追加式旁路动作：失败只记日志，绝不阻断主流程的终止/返修走向。
import type { NodeContext, NodeAction, ErrorEnvelope } from './runner.mts'
import type { WorkflowCheckpoint, PendingApproval } from './checkpoint.mts'

// fjsp-tools 工具的 structured 出参形态（任务 2.A envelope）
export interface ToolStructured {
  ok: boolean
  error?: { code: string; message?: string }
  [k: string]: unknown
}

// 流程依赖的工具面（fjsp-tools 的子集；测试注入 mock，真实接线时适配 fjsp-tools 的 tools 表）
export interface FlowTools {
  call(name: string, args?: Record<string, unknown>): Promise<ToolStructured>
}

export function toolsOf(ctx: NodeContext): FlowTools {
  const t = ctx.tools as FlowTools | undefined
  if (!t || typeof t.call !== 'function') throw Object.assign(new Error('未注入 tools（FlowTools.call）'), { code: 'E_INTERNAL' })
  return t
}

// 取某节点最近一次完成的产出（流程内向后传数据的通道）
export function stepResult(ctx: NodeContext, node: string): Record<string, unknown> | null {
  const s = [...ctx.checkpoint.completedSteps].reverse().find((s) => s.node === node)
  return (s?.result as Record<string, unknown> | undefined) ?? null
}

export function isErr(out: ToolStructured): boolean {
  return !out || out.ok !== true
}

export function envError(code: string, message: string): ErrorEnvelope {
  return { ok: false, error: { code, message } }
}

// 只透传已定义字段，避免把 undefined 键带进写工具入参
export function pickDefined(src: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of keys) if (src[k] !== undefined) out[k] = src[k]
  return out
}

// 任务终态判定。状态枚举全集（business-service TaskStatus）：PENDING / RUNNING / RETRY_WAIT /
// SUCCESS / TIME_LIMIT / INFEASIBLE / FAILED / CANCELLED。
// 可行终态口径对齐 evaluation/scenarios/common.mjs：仅 status ∈ {SUCCESS, TIME_LIMIT} 且
// resultStatus === 'FEASIBLE' 才算可行终态；PENDING/RUNNING/RETRY_WAIT（fjsp_task_status 超时
// 返回的 RUNNING 快照）一律非终态，绝不能落入 feasible（否则带空 planVersionId 污染下游）。
export function judgeTask(out: ToolStructured): {
  outcome: 'feasible' | 'infeasible' | 'failed' | 'pending'
  task: Record<string, unknown>
} {
  const task = (out.task ?? {}) as Record<string, unknown>
  const status = task.status as string | undefined
  const resultStatus = task.resultStatus as string | undefined
  if ((status === 'SUCCESS' || status === 'TIME_LIMIT') && resultStatus === 'FEASIBLE') return { outcome: 'feasible', task }
  if (status === 'INFEASIBLE' || ((status === 'SUCCESS' || status === 'TIME_LIMIT') && resultStatus === 'INFEASIBLE')) {
    return { outcome: 'infeasible', task }
  }
  if (status === 'FAILED' || status === 'CANCELLED') return { outcome: 'failed', task }
  return { outcome: 'pending', task } // PENDING / RUNNING / RETRY_WAIT / 未识别组合
}

// 提交评审节点体（写）：fjsp_get_plan 读最新乐观锁 version → fjsp_submit_review；
// E_VERSION_STALE（乐观锁）→ 已重读最新 version，返回 retry 由 runner maxAttempts 限次兜底。
// 幂等键取自 ctx.checkpoint.current.idempotencyKey（wfId:node:seq），重试复用同键。
export async function runSubmitReview(ctx: NodeContext): Promise<NodeAction | ErrorEnvelope> {
  const tools = toolsOf(ctx)
  const planVersionId = ctx.checkpoint.refs.planVersionId!
  const plan = await tools.call('fjsp_get_plan', { planVersionId })
  if (isErr(plan)) return plan as ErrorEnvelope
  const version = (plan.plan as { version?: number }).version
  if (typeof version !== 'number') return envError('FJSP_BAD_RESPONSE', 'fjsp_get_plan 未返回乐观锁 version')
  const out = await tools.call('fjsp_submit_review', { planVersionId, version, idempotencyKey: ctx.checkpoint.current!.idempotencyKey })
  if (isErr(out)) {
    if (out.error?.code === 'E_VERSION_STALE') {
      return { action: 'retry', reason: `乐观锁冲突（E_VERSION_STALE），已重读最新 version 后重试：${out.error.message ?? ''}` }
    }
    return out as ErrorEnvelope
  }
  return { action: 'advance', result: { planVersionId, plan: out.plan ?? null } }
}

// ---- 经验反馈接线（任务 5.1 遗留，5.2 落地）----

// 从检查点收集本次处置检索到的经验记录 id：触发上下文 detail.experienceIds
// （上游流程/调用方传入）优先；否则取 query-experience 步骤产出 records 里带 id 的条目
// （旧记录无 id，无法被 fjsp_experience_feedback 关联，自动跳过）。
export function collectExperienceIds(cp: WorkflowCheckpoint): string[] {
  const detail = cp.trigger.detail as { experienceIds?: unknown } | undefined
  if (Array.isArray(detail?.experienceIds)) {
    return detail.experienceIds.filter((x): x is string => typeof x === 'string' && x.length > 0)
  }
  const step = [...cp.completedSteps].reverse().find((s) => s.node === 'query-experience')
  const records = (step?.result as { experience?: { records?: unknown } } | undefined)?.experience?.records
  if (!Array.isArray(records)) return []
  return records
    .map((r) => (r && typeof r === 'object' ? (r as { id?: unknown }).id : undefined))
    .filter((x): x is string => typeof x === 'string' && x.length > 0)
}

// 给经验记录追加反馈（fjsp_experience_feedback，写）。best-effort：单条失败记日志继续，
// 不抛出、不改变主流程走向。返回实际发送条数。
export async function sendExperienceFeedback(
  ctx: Pick<NodeContext, 'tools' | 'log'>,
  experienceIds: string[],
  outcome: 'rejected' | 'reworked',
  note: string,
): Promise<number> {
  let sent = 0
  for (const experienceId of experienceIds) {
    try {
      const out = await toolsOf(ctx as NodeContext).call('fjsp_experience_feedback', { experienceId, outcome, note })
      if (isErr(out)) {
        ctx.log(`经验反馈未写入（${experienceId}）：${out.error?.code ?? '未知'} ${out.error?.message ?? ''}`)
      } else {
        sent++
      }
    } catch (e) {
      ctx.log(`经验反馈调用异常（${experienceId}）：${String(e)}`)
    }
  }
  return sent
}

// settleApprovalOutcome 的 onRejected 钩子工厂（任务 5.1 遗留的 workflow 侧接线）：
// 评审审批被拒绝时，若本次处置有经验检索记录则追加 outcome=rejected 负面反馈。
// 只对评审决策点（fjsp_approve_review）生效；发布确认等其他审批点的拒绝不触发。
export function makeExperienceFeedbackHook(deps: { tools?: unknown; log?: (msg: string) => void }) {
  const log = deps.log ?? (() => {})
  return async (cp: WorkflowCheckpoint, approval: PendingApproval | null): Promise<void> => {
    if (approval?.tool !== 'fjsp_approve_review') return
    const ids = collectExperienceIds(cp)
    if (ids.length === 0) {
      log('评审被拒绝，但本次处置无经验检索记录（或无 id），跳过经验反馈')
      return
    }
    const sent = await sendExperienceFeedback({ tools: deps.tools, log }, ids, 'rejected', '人工评审拒绝（workflow 审批拒绝分支）')
    log(`评审被拒绝，已对 ${sent}/${ids.length} 条经验记录追加 rejected 反馈`)
  }
}

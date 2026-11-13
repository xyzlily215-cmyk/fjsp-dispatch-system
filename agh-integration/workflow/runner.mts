// workflow/runner.mts — 节点执行引擎（任务 3.2-partA）。
//
// 职责：按节点数组顺序推进工作流，每节点两段写检查点（beginStep 意图 / completeStep 结果）。
// 幂等键由 checkpoint.mts 统一生成（wfId:node:seq），同节点重试复用同键、attempt 递增。
// 失败按 fjsp-tools 错误分类路由：retryable → 重试；needs-human / needs-input → 挂起等人工；
// terminal → 终止；重试超 maxAttempts → FAILED 转人工。崩溃恢复核对（业务现态 vs 检查点）
// 不在本模块，见 recovery.mts。
import { randomUUID } from 'node:crypto'
import { CheckpointStore, type WorkflowCheckpoint, type PendingApproval, type BusinessRefs } from './checkpoint.mts'
import { __contract } from '../fjsp-tools/index.mjs'

const { classifyError } = __contract as { classifyError: (code: string) => { category: string; retryable: boolean; recovery: string } }

// 节点上下文：checkpoint 为 beginStep 后的快照（可读本步骤幂等键），tools/agent 由调用方注入。
export interface NodeContext {
  checkpoint: WorkflowCheckpoint
  tools?: unknown
  agent?: unknown
  log: (msg: string) => void
}

// 挂起时请求人工审批的五要素句柄（缺省字段由引擎补齐）。
export interface ApprovalRequest {
  requestId?: string
  tool: string
  bizObject?: string | null
  args?: Record<string, unknown> // 审批工具的入参（BFF 登记时生成参数摘要/指纹用）
  argsDigest?: string
  requiredRoles?: string[]
  ttlMs?: number // 默认 5 分钟，与 BFF 审批有效期对齐
  workflowId?: string // 缺省字段由引擎补齐：登记 BFF 时把审批记录关联回工作流（任务 4.2）
}

export type NodeAction =
  | { action: 'advance'; result?: Record<string, unknown>; refs?: Partial<BusinessRefs> }
  | { action: 'retry'; reason: string }
  | { action: 'suspend'; reason: string; awaitApproval?: ApprovalRequest }
  | { action: 'terminate'; reason: string }

// 节点也可直接返回 fjsp-tools 错误 envelope，引擎按 category 路由（等价于显式 retry/suspend/terminate）。
export interface ErrorEnvelope {
  ok: false
  error: { code: string; message: string; category?: string }
}

export interface WorkflowNode {
  name: string // 节点名在工作流内唯一（seq 与幂等键按名计数）
  maxAttempts?: number // 默认 3
  run(ctx: NodeContext): Promise<NodeAction | ErrorEnvelope> | NodeAction | ErrorEnvelope
}

export interface RunDeps {
  store: CheckpointStore
  tools?: unknown
  agent?: unknown
  log?: (msg: string) => void
  // BFF 审批登记通道（任务 3.4，workflow/bff-approval.mts 提供）：挂起时先向 BFF 登记
  // 五要素审批请求，用返回的 requestId/expiresAt 覆盖本地句柄；登记失败落本地句柄，
  // 恢复时由 checkApproval 核对重发（不回放旧批准）。
  approvalChannel?: { register(req: ApprovalRequest): Promise<{ requestId: string; expiresAt: string }> }
  // 审批被拒绝时的旁路钩子（任务 5.2 经验反馈接线）：settleApprovalOutcome 在落地拒绝
  // 裁决后、终止前调用；实现必须 best-effort（如 fjsp_experience_feedback 追加负面反馈），
  // 抛错只记日志，不改变终止走向。
  onRejected?: (cp: WorkflowCheckpoint, approval: PendingApproval | null) => Promise<void> | void
}

// A guarded write suspends the current node before any effect; approval is not
// node completion. Resume re-executes the same node with the same step key.
export class ToolApprovalRequired extends Error {
  constructor(readonly approval: {
    tool: string; args: Record<string, unknown>; requestId: string; expiresAt: string; argsDigest: string
  }) { super('WORKFLOW_WRITE_APPROVAL_REQUIRED') }
}

const noop = () => {}
const APPROVAL_TTL_MS = 5 * 60 * 1000

function isErrorEnvelope(v: unknown): v is ErrorEnvelope {
  return !!v && typeof v === 'object' && (v as ErrorEnvelope).ok === false && !!(v as ErrorEnvelope).error
}

// 统一失败分类：category 缺失时按错误码走 fjsp-tools 分类表，无法识别兜底 needs-human。
function classifyFailure(e: unknown): { category: string; message: string } {
  if (isErrorEnvelope(e)) {
    const category = e.error.category ?? classifyError(e.error.code).category
    return { category, message: `[${e.error.code}] ${e.error.message}` }
  }
  const err = e as { code?: unknown; message?: unknown }
  const code = typeof err?.code === 'string' ? err.code : null
  const category = code ? classifyError(code).category : 'needs-human'
  const message = String(err?.message ?? e)
  return { category, message: code ? `[${code}] ${message}` : message }
}

function buildApproval(req: ApprovalRequest): PendingApproval {
  const issuedAt = new Date()
  return {
    requestId: req.requestId ?? `appr-${randomUUID()}`,
    tool: req.tool,
    bizObject: req.bizObject ?? null,
    ...(req.argsDigest ? { argsDigest: req.argsDigest } : {}),
    ...(req.requiredRoles ? { requiredRoles: req.requiredRoles } : {}),
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + (req.ttlMs ?? APPROVAL_TTL_MS)).toISOString(),
  }
}

// 挂起登记（含 BFF 审批通道）：buildApproval 构造本地句柄 → 有 approvalChannel 则向 BFF
// 登记并用返回的 requestId/expiresAt 覆盖；登记失败落本地句柄（恢复时核对重发，不回放）。
// 抽出为独立函数供 runner 与各流程的 settle 包装（如 review-publish 返修后重新挂起）共用。
export async function suspendForApproval(
  store: CheckpointStore,
  workflowId: string,
  nodeName: string,
  action: { reason: string; awaitApproval: ApprovalRequest },
  deps: RunDeps,
): Promise<WorkflowCheckpoint> {
  const log = deps.log ?? noop
  let approval = buildApproval(action.awaitApproval)
  if (deps.approvalChannel) {
    try {
      const reg = await deps.approvalChannel.register({ ...action.awaitApproval, workflowId })
      approval = { ...approval, requestId: reg.requestId, expiresAt: reg.expiresAt }
      log(`节点 ${nodeName} 审批已登记 BFF：requestId ${reg.requestId}`)
    } catch (e) {
      if ((e as { permanent?: boolean })?.permanent) {
        // BFF 明确拒绝（403）：落本地句柄只会在恢复时 404→重发→再 403 循环，直接转人工
        log(`节点 ${nodeName} BFF 拒绝登记审批（${String(e)}），转人工`)
        return store.setStatus(workflowId, 'FAILED', `审批登记被 BFF 拒绝：${String(e)}`)
      }
      // 登记失败不阻断挂起：落本地句柄，恢复时核对不到有效审批即标过期重发
      log(`节点 ${nodeName} BFF 审批登记失败（${String(e)}），先落本地句柄待恢复重发`)
    }
  }
  store.recordApproval(workflowId, approval)
  log(`节点 ${nodeName} 挂起等待审批：${action.reason}`)
  return store.load(workflowId)!
}

// 从检查点续跑或从头跑。非 RUNNING 状态不推进：挂起须先经审批裁决（clearApproval）再重入。
export async function runWorkflow(workflowId: string, nodes: WorkflowNode[], deps: RunDeps): Promise<WorkflowCheckpoint> {
  const { store, tools, agent } = deps
  const log = deps.log ?? noop
  const cp = store.load(workflowId)
  if (!cp) throw new Error(`检查点不存在：${workflowId}`)
  if (cp.status !== 'RUNNING') {
    log(`工作流 ${workflowId} 状态 ${cp.status}，不推进`)
    return cp
  }

  const done = new Set(cp.completedSteps.map((s) => s.node))
  const idx = nodes.findIndex((n) => !done.has(n.name))
  if (idx === -1) return store.setStatus(workflowId, 'COMPLETED')
  // 崩溃留下的未了结 intent：只允许与下一待执行节点同名（同键重跑），否则须先走恢复协议
  if (cp.current && cp.current.node !== nodes[idx].name) {
    throw new Error(`检查点 current=${cp.current.node} 与下一待执行节点 ${nodes[idx].name} 不一致，需先走恢复协议`)
  }

  for (let i = idx; i < nodes.length; i++) {
    const node = nodes[i]
    const maxAttempts = node.maxAttempts ?? 3
    while (true) {
      const step = store.beginStep(workflowId, node.name)
      if (step.current!.attempt > maxAttempts) {
        const reason = `节点 ${node.name} 重试 ${maxAttempts} 次未成功，转人工处理（needs-human）`
        log(reason)
        return store.setStatus(workflowId, 'FAILED', reason)
      }
      log(`节点 ${node.name} 第 ${step.current!.attempt}/${maxAttempts} 次尝试，幂等键 ${step.current!.idempotencyKey}`)

      let action: NodeAction
      try {
        const out = await node.run({ checkpoint: step, tools, agent, log })
        if (isErrorEnvelope(out)) {
          action = routeFailure(classifyFailure(out))
        } else {
          action = out
        }
      } catch (e) {
        if (e instanceof ToolApprovalRequired) {
          const grant = e.approval
          // Waiting for a human is not a failed business attempt.
          store.deferAttempt(workflowId)
          store.recordApproval(workflowId, { requestId: grant.requestId, tool: grant.tool,
            bizObject: null, argsDigest: grant.argsDigest,
            issuedAt: new Date().toISOString(), expiresAt: grant.expiresAt })
          return store.load(workflowId)!
        }
        action = routeFailure(classifyFailure(e))
      }

      switch (action.action) {
        case 'advance':
          store.completeStep(workflowId, action.result, action.refs)
          break
        case 'retry':
          log(`节点 ${node.name} 重试：${action.reason}`)
          continue // beginStep 复用同一幂等键、attempt+1
        case 'suspend': {
          if (action.awaitApproval) {
            return suspendForApproval(store, workflowId, node.name, action, deps)
          }
          store.setStatus(workflowId, 'WAITING_APPROVAL', action.reason)
          log(`节点 ${node.name} 挂起：${action.reason}`)
          return store.load(workflowId)!
        }
        case 'terminate':
          log(`节点 ${node.name} 终止：${action.reason}`)
          return store.setStatus(workflowId, 'TERMINATED', action.reason)
      }
      break // advance：进入下一节点
    }
  }
  return store.setStatus(workflowId, 'COMPLETED')
}

// 失败分类 → 节点动作：retryable 重试；terminal 终止；needs-human/needs-input 挂起等人工。
function routeFailure(f: { category: string; message: string }): NodeAction {
  if (f.category === 'retryable') return { action: 'retry', reason: f.message }
  if (f.category === 'terminal') return { action: 'terminate', reason: f.message }
  return { action: 'suspend', reason: f.message }
}

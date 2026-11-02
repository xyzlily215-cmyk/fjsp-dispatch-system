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
  argsDigest?: string
  requiredRoles?: string[]
  ttlMs?: number // 默认 5 分钟，与 BFF 审批有效期对齐
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
            store.recordApproval(workflowId, buildApproval(action.awaitApproval))
            log(`节点 ${node.name} 挂起等待审批：${action.reason}`)
          } else {
            store.setStatus(workflowId, 'WAITING_APPROVAL', action.reason)
            log(`节点 ${node.name} 挂起：${action.reason}`)
          }
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

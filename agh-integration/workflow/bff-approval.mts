// workflow/bff-approval.mts — 工作流 ↔ BFF 审批接线（任务 3.4）。
//
// 三条接线（HTTP 层一律可注入 mock，不起真实 BFF）：
//   1. 挂起登记：runner 挂起时经 createBffApprovalChannel 调 BFF POST /agent-api/approvals
//      创建五要素审批记录（工具名/参数摘要/业务对象/有效期/可审批角色由 BFF 服务端生成），
//      返回的 requestId/expiresAt 写入检查点 pendingApproval；
//   2. 裁决获取：pollApprovalDecision 轮询 GET /agent-api/approvals/:requestId，
//      结果交 settleApprovalOutcome 落地——批准 → 恢复推进到终态；拒绝 → 显式终止
//      （方案 3.5 拒绝分支：不发布）；过期/查无记录 → 标过期重发（新 requestId，旧批准不回放）；
//   3. 恢复核对：makeApprovalChecker 注入 recovery.recover 的 checkApproval——
//      pending 有效继续等，expired/timeout/not_found 标过期重发；BFF 不可达抛
//      BffUnavailableError，recovery 映射 unavailable，不推进（fail-safe）。
import { CheckpointStore, type PendingApproval, type WorkflowCheckpoint } from './checkpoint.mts'
import type { ApprovalValidity } from './recovery.mts'
import { runWorkflow, type ApprovalRequest, type RunDeps, type WorkflowNode } from './runner.mts'

// BFF 不可达 / 响应不符合契约：核对方绝不得据此推进（fail-safe）
export class BffUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BffUnavailableError'
  }
}

export type BffApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'timeout' | 'not_found'

export interface BffApprovalClientOptions {
  baseUrl: string // 如 http://127.0.0.1:4178/agent-api
  token: string // business-service 签发的 Bearer JWT（工作流服务账号）
  conversationId: string // 审批卡片落在哪个会话（SSE permission_request 下发目标）
  fetchImpl?: typeof fetch // 测试注入 mock HTTP 层
  timeoutMs?: number // 单次请求超时，默认 3000
}

export interface BffApprovalClient {
  register(req: ApprovalRequest): Promise<{ requestId: string; expiresAt: string }>
  check(requestId: string): Promise<BffApprovalStatus>
}

const DECIDED = new Set(['approved', 'rejected'])
const KNOWN_STATUS = new Set(['pending', 'approved', 'rejected', 'expired', 'timeout'])

function client(opts: BffApprovalClientOptions): BffApprovalClient {
  const f = opts.fetchImpl ?? fetch
  const base = opts.baseUrl.replace(/\/+$/, '')
  const timeout = opts.timeoutMs ?? 3000
  const request = async (method: string, path: string, body?: unknown) => {
    let res: Response
    try {
      res = await f(`${base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${opts.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeout),
      })
    } catch (e) {
      throw new BffUnavailableError(`BFF 不可达（${method} ${path}）：${String(e)}`)
    }
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null
    return { status: res.status, data }
  }
  return {
    async register(req) {
      const { status, data } = await request('POST', '/approvals', {
        conversationId: opts.conversationId,
        toolCall: { name: req.tool, args: req.args ?? {} },
        ...(req.ttlMs ? { ttlMs: req.ttlMs } : {}),
        // 关联键贯通（任务 4.2）：审批记录带 workflowId，审计聚合可按工作流回溯审批链
        ...(req.workflowId ? { workflowId: req.workflowId } : {}),
      })
      const approval = data?.approval as { requestId?: unknown; expiresAt?: unknown } | undefined
      if ((status !== 200 && status !== 202) || typeof approval?.requestId !== 'string' || typeof approval?.expiresAt !== 'number') {
        throw new BffUnavailableError(`BFF 登记审批失败（HTTP ${status}）：${JSON.stringify(data)}`)
      }
      return { requestId: approval.requestId, expiresAt: new Date(approval.expiresAt).toISOString() }
    },
    async check(requestId) {
      const { status, data } = await request('GET', `/approvals/${encodeURIComponent(requestId)}`)
      if (status === 404) return 'not_found'
      const s = (data?.approval as { status?: unknown } | undefined)?.status
      if (status === 200 && typeof s === 'string' && KNOWN_STATUS.has(s)) return s as BffApprovalStatus
      throw new BffUnavailableError(`BFF 审批查询失败（HTTP ${status}）：${JSON.stringify(data)}`)
    },
  }
}

// runner 挂起接线（RunDeps.approvalChannel）：登记成功则用 BFF 的 requestId/expiresAt
// 覆盖本地句柄；登记失败由 runner 落本地句柄（恢复时核对重发，不回放）。
export function createBffApprovalChannel(opts: BffApprovalClientOptions): RunDeps['approvalChannel'] {
  const c = client(opts)
  return { register: (req) => c.register(req) }
}

// recovery 注入（RecoveryDeps.checkApproval）：pending → 继续等；approved/rejected →
// 已裁决（不回放，由副作用核对决定重做）；expired/timeout/not_found → 标过期重发。
// BFF 不可达时抛 BffUnavailableError，recovery 映射 unavailable 不推进。
export function makeApprovalChecker(opts: BffApprovalClientOptions): (approval: PendingApproval) => Promise<ApprovalValidity> {
  const c = client(opts)
  return async (approval) => {
    const s = await c.check(approval.requestId)
    if (s === 'pending') return 'pending'
    if (DECIDED.has(s)) return 'decided'
    return 'expired' // expired / timeout / not_found：无法确认有效即标过期重发（方案 3.5）
  }
}

// 轮询拿裁决结果：pending 继续等；approved/rejected 返回；expired/timeout/not_found 或
// 检查点有效期已过 → 'expired'。BFF 不可达抛 BffUnavailableError（调用方不得推进）。
export async function pollApprovalDecision(
  opts: BffApprovalClientOptions,
  approval: PendingApproval,
  { pollMs = 2000 }: { pollMs?: number } = {},
): Promise<'approved' | 'rejected' | 'expired'> {
  const c = client(opts)
  const deadline = Date.parse(approval.expiresAt)
  while (true) {
    const s = await c.check(approval.requestId)
    if (s === 'approved' || s === 'rejected') return s
    if (s !== 'pending') return 'expired'
    if (Date.now() >= deadline) return 'expired'
    await new Promise((r) => setTimeout(r, pollMs))
  }
}

// 裁决落地 + 恢复推进。挂起节点的"副作用"即人工决策本身：了结当前步骤（不回放、不重跑
// 节点），批准 → runner 继续推进到终态；拒绝 → 显式终止（不发布，方案 3.5 拒绝分支）；
// 过期 → 标过期存档后重跑挂起节点，重新登记审批（新 requestId，旧批准不回放）。
export async function settleApprovalOutcome(
  store: CheckpointStore,
  workflowId: string,
  nodes: WorkflowNode[],
  deps: RunDeps,
  outcome: 'approved' | 'rejected' | 'expired',
): Promise<WorkflowCheckpoint> {
  const cp = store.load(workflowId)
  if (!cp) throw new Error(`检查点不存在：${workflowId}`)
  const approval = cp.pendingApproval
  if (outcome === 'expired') {
    store.expireApproval(workflowId, '审批已过有效期或未能在 BFF 确认有效，重新发起')
    return runWorkflow(workflowId, nodes, deps)
  }
  store.clearApproval(workflowId)
  store.completeStep(workflowId, { approvalDecision: outcome, requestId: approval?.requestId ?? null })
  if (outcome === 'rejected') {
    // 拒绝旁路钩子（任务 5.2 经验反馈接线）：best-effort，钩子异常不改变终止走向
    if (deps.onRejected) {
      try {
        await deps.onRejected(store.load(workflowId)!, approval ?? null)
      } catch (e) {
        deps.log?.(`审批拒绝旁路钩子异常（已忽略，不影响终止）：${String(e)}`)
      }
    }
    return store.setStatus(workflowId, 'TERMINATED', `审批被拒绝：显式停止，不执行后续发布动作（planVersionId=${cp.refs.planVersionId ?? '无'}）`)
  }
  return runWorkflow(workflowId, nodes, deps)
}

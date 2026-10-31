// workflow/recovery.mts — 工作流恢复协议（任务 3.1）。
//
// 设计依据：docs/Agent化架构优化方案.md 3.5。
// 恢复顺序（严格按方案）：
//   1. 读检查点；
//   2. 按检查点存下的业务对象 ID 查 business-service 现态（默认复用 fjsp-tools 只读
//      工具：fjsp_get_dashboard / fjsp_task_status / fjsp_get_plan，与任务 2.B 的
//      terminalQuery 终态查询指引同源）；
//   3. 逐节点核对副作用是否已发生：结果未知时复用原幂等键、先查终态再决定重做；
//   4. 审批：pending 审批与审批方核对，无法确认仍有效 → 标过期重新发起，不回放旧批准。
//
// 「结果未知」判定不依赖客户端超时存在（任务 2.B 评审留白：fjsp-tools 的 api() 无
// AbortSignal）：恢复一律以查业务终态为准；业务服务不可达时只输出 unavailable，绝不推进。
import {
  CheckpointStore,
  type BusinessRefs,
  type CompletedStep,
  type PendingApproval,
  type StepState,
  type WorkflowCheckpoint,
} from './checkpoint.mts'

// ---- 外部依赖接口（全部可注入；默认实现见文件末尾，测试一律注入 mock） ----

// 审批有效性核对。BFF 审批记录是进程内存（任务 1.2），BFF 重启后 pending 承诺消亡，
// 且目前没有按 requestId 查询审批状态的端点——默认实现因此只能确认「已过期」，
// 其余一律 unknown（保守方向：过期重发，不回放旧批准）。任务 3.4 接真实审批流时可注入
// 能返回 pending/decided 的核对器。
export type ApprovalValidity = 'pending' | 'decided' | 'expired' | 'unknown'

// 副作用核对结论：
//   done          副作用已发生（业务现态中有证据）→ 跳过重做，补登记后继续；
//   not-done      副作用未发生 → 复用原幂等键重做；
//   contradiction 业务现态与检查点矛盾且不可调和 → 终止工作流；
//   unknown       证据不足（如 recentEvents 只保留最近 8 条，查不到不等于没发生）→ 采信检查点。
export type SideEffectVerdict = 'done' | 'not-done' | 'contradiction' | 'unknown'

export interface BusinessState {
  dashboard?: ToolStructured | null // fjsp_get_dashboard 快照（recentEvents/recentTasks/currentPlan）
  task?: ToolStructured | null // refs.taskId 对应任务快照
  plan?: ToolStructured | null // refs.planVersionId 对应计划快照
}

// fjsp-tools 工具的 structured 出参形态（任务 2.A envelope）
export interface ToolStructured {
  ok: boolean
  error?: { code: string; message?: string; category?: string; retryable?: boolean }
  [key: string]: unknown
}

export interface RecoveryDeps {
  now?: () => number
  readDashboard?: () => Promise<ToolStructured>
  readTask?: (taskId: string) => Promise<ToolStructured>
  readPlan?: (planVersionId: string) => Promise<ToolStructured>
  checkApproval?: (approval: PendingApproval) => Promise<ApprovalValidity>
  // 节点级副作用核对器：具体流程（3.2 起）按节点语义注入；缺省走 defaultVerifyStep。
  verifyStep?: (ctx: { checkpoint: WorkflowCheckpoint; step: StepState; business: BusinessState }) => Promise<SideEffectVerdict> | SideEffectVerdict
  verifyCompletedStep?: (ctx: { checkpoint: WorkflowCheckpoint; step: CompletedStep; business: BusinessState }) => Promise<SideEffectVerdict> | SideEffectVerdict
}

export type RecoveryDecision =
  | { action: 'done'; workflowId: string }
  | { action: 'already-terminated'; workflowId: string; reason?: string }
  | { action: 'needs-human'; workflowId: string; reason: string }
  | { action: 'unavailable'; workflowId: string; reason: string }
  | { action: 'terminate'; workflowId: string; reason: string }
  | { action: 'await-approval'; workflowId: string; approval: PendingApproval }
  | { action: 'reissue-approval'; workflowId: string; from: string; idempotencyKey: string; reason: string }
  | { action: 'resume'; workflowId: string; from: string | null; skipExecute: boolean; idempotencyKey?: string; reason?: string }
  | { action: 'not-found'; workflowId: string }

// 结果未知/通道类错误（与 fjsp-tools isUnknownResultCode 同口径）：读现态遇这些码
// 说明"业务现态本身未知"，恢复只能输出 unavailable，不做任何推进决定。
function isUnknownResultCode(code: unknown): boolean {
  return code === 'FJSP_UNREACHABLE' || code === 'FJSP_BAD_RESPONSE' || code === 'E_INTERNAL' ||
    (typeof code === 'string' && /^FJSP_HTTP_5\d\d$/.test(code))
}
const isNotFoundCode = (code: unknown) => code === 'E_NOT_FOUND' || code === 'FJSP_NOT_FOUND'

// 默认终态读取：复用 fjsp-tools 同一份工具实现（AGH 插件 / MCP 共用），动态 import
// 保持最小耦合——注入了 mock deps 的测试完全不加载 fjsp-tools。
type ToolExecutor = (name: string, args?: Record<string, unknown>) => Promise<ToolStructured>
let toolExecutor: ToolExecutor | null = null
async function defaultExecutor(): Promise<ToolExecutor> {
  if (!toolExecutor) {
    const { tools } = await import('../fjsp-tools/index.mjs')
    const map = new Map(tools.map((t) => [t.name, t]))
    toolExecutor = async (name, args = {}) => {
      const tool = map.get(name)
      if (!tool) throw new Error(`fjsp-tools 中不存在工具 ${name}`)
      const out = await tool.execute(args)
      return out.structured as ToolStructured
    }
  }
  return toolExecutor
}

async function defaultReadDashboard(): Promise<ToolStructured> {
  return (await defaultExecutor())('fjsp_get_dashboard')
}
async function defaultReadTask(taskId: string): Promise<ToolStructured> {
  return (await defaultExecutor())('fjsp_task_status', { taskId, waitSeconds: 0 })
}
async function defaultReadPlan(planVersionId: string): Promise<ToolStructured> {
  return (await defaultExecutor())('fjsp_get_plan', { planVersionId })
}

// 默认审批核对：只能凭检查点里的截止时间确认「已过期」，其余 unknown（见类型注释）。
async function defaultCheckApproval(approval: PendingApproval): Promise<ApprovalValidity> {
  return Date.now() > Date.parse(approval.expiresAt) ? 'expired' : 'unknown'
}

// 默认已完成步骤核对：按步骤产出里记录的业务证据逐条对现态。
//   planVersionId → 直读计划，E_NOT_FOUND = 检查点引用了不存在的对象，矛盾；
//   taskId        → 直读任务，同上；
//   eventId       → 只能在 dashboard 的 recentEvents（最近 8 条切片）里找，
//                   找不到不算矛盾（切片截断），证据不足返回 unknown 采信检查点。
async function defaultVerifyCompletedStep(ctx: { step: CompletedStep; business: BusinessState }): Promise<SideEffectVerdict> {
  const r = ctx.step.result || {}
  if (typeof r.planVersionId === 'string') {
    const plan = ctx.business.plan
    if (plan && plan.ok === false && isNotFoundCode(plan.error?.code)) return 'contradiction'
    if (plan && plan.ok === true) return 'done'
  }
  if (typeof r.taskId === 'string') {
    const task = ctx.business.task
    if (task && task.ok === false && isNotFoundCode(task.error?.code)) return 'contradiction'
    if (task && task.ok === true) return 'done'
  }
  if (typeof r.eventId === 'string') {
    const events = (ctx.business.dashboard as any)?.recentEvents
    if (Array.isArray(events)) {
      return events.some((e: any) => (e.eventId ?? e.id) === r.eventId) ? 'done' : 'unknown'
    }
  }
  return 'unknown'
}

// 默认当前步骤核对：无节点语义可注入时保守返回 not-done——重做是安全的，因为
// ① 重试复用同一幂等键（服务端同键同体回放）；② 计划类写工具内部先读现态
// （submit_review / approve_review / publish 的 reads-before-retry，任务 2.B 表格）。
async function defaultVerifyStep(): Promise<SideEffectVerdict> {
  return 'not-done'
}

interface CollectedState {
  business?: BusinessState
  unavailableReason?: string
}

// 按检查点存下的业务对象 ID 收集现态；任何一路读出"结果未知"类错误 → 整体不可用。
async function collectBusinessState(cp: WorkflowCheckpoint, deps: RecoveryDeps): Promise<CollectedState> {
  const readDashboard = deps.readDashboard || defaultReadDashboard
  const readTask = deps.readTask || defaultReadTask
  const readPlan = deps.readPlan || defaultReadPlan
  const business: BusinessState = {}
  const readOne = async (label: string, fn: () => Promise<ToolStructured>): Promise<ToolStructured | null | { __unavailable: string }> => {
    try {
      const out = await fn()
      if (out && out.ok === false && isUnknownResultCode(out.error?.code)) {
        return { __unavailable: `${label} 查询结果未知（${out.error?.code}）：业务现态不可核对` }
      }
      return out
    } catch (e) {
      return { __unavailable: `${label} 查询失败：${String(e)}` }
    }
  }
  const dash = await readOne('dashboard', readDashboard)
  if (dash && '__unavailable' in dash) return { unavailableReason: dash.__unavailable }
  business.dashboard = dash
  if (cp.refs.taskId) {
    const t = await readOne(`任务 ${cp.refs.taskId}`, () => readTask(cp.refs.taskId as string))
    if (t && '__unavailable' in t) return { unavailableReason: t.__unavailable }
    business.task = t
  }
  if (cp.refs.planVersionId) {
    const p = await readOne(`计划 ${cp.refs.planVersionId}`, () => readPlan(cp.refs.planVersionId as string))
    if (p && '__unavailable' in p) return { unavailableReason: p.__unavailable }
    business.plan = p
  }
  return { business }
}

// 恢复主流程：读检查点 → 查业务现态 → 核对已完成步骤证据 → 核对待审批 → 核对当前步骤副作用。
// 除 terminate / reissue-approval / await-approval / resume(skipExecute) 需要的检查点落盘外，
// 不修改任何业务状态。
export async function recover(store: CheckpointStore, workflowId: string, deps: RecoveryDeps = {}): Promise<RecoveryDecision> {
  const now = deps.now || (() => Date.now())
  const cp = store.load(workflowId)
  if (!cp) return { action: 'not-found', workflowId }
  if (cp.status === 'COMPLETED') return { action: 'done', workflowId }
  if (cp.status === 'TERMINATED') return { action: 'already-terminated', workflowId, reason: cp.statusReason }
  if (cp.status === 'FAILED') return { action: 'needs-human', workflowId, reason: cp.statusReason || '工作流处于 FAILED，需人工介入' }

  // 第 2 步：查业务现态
  const collected = await collectBusinessState(cp, deps)
  if (collected.unavailableReason) return { action: 'unavailable', workflowId, reason: collected.unavailableReason }
  const business = collected.business as BusinessState

  // 第 3 步 a：已完成步骤的业务证据核对（防线：检查点声称做过的，业务现态里必须有迹）
  const verifyCompleted = deps.verifyCompletedStep || defaultVerifyCompletedStep
  for (const step of cp.completedSteps) {
    const verdict = await verifyCompleted({ checkpoint: cp, step, business })
    if (verdict === 'contradiction') {
      const reason = `已完成步骤 ${step.node}#${step.seq} 的业务证据在现态中不存在（不可调和），终止工作流`
      store.setStatus(workflowId, 'TERMINATED', reason)
      return { action: 'terminate', workflowId, reason }
    }
  }

  // 第 4 步：待审批核对。pending 有效 → 继续等；过期/无法确认 → 标过期重发；
  // 已裁决 → 不回放旧批准，落入下面的副作用核对（批了但没执行到 = 副作用未发生，重新发起）。
  const hadPendingApproval = !!cp.pendingApproval
  if (cp.pendingApproval) {
    const check = deps.checkApproval || defaultCheckApproval
    const validity = await check(cp.pendingApproval)
    const expiredByClock = now() > Date.parse(cp.pendingApproval.expiresAt)
    if (validity === 'pending' && !expiredByClock) {
      return { action: 'await-approval', workflowId, approval: cp.pendingApproval }
    }
    if (validity === 'decided') {
      store.clearApproval(workflowId)
    } else {
      const reason = validity === 'expired' || expiredByClock ? '审批已过有效期' : '审批状态无法确认（BFF 审批记录不持久化）'
      store.expireApproval(workflowId, reason)
      if (!cp.current) {
        // 挂起在审批上但没有当前步骤：异常形态，转人工
        const msg = '审批挂起但检查点无当前步骤，无法自动恢复'
        store.setStatus(workflowId, 'FAILED', msg)
        return { action: 'needs-human', workflowId, reason: msg }
      }
      return { action: 'reissue-approval', workflowId, from: cp.current.node, idempotencyKey: cp.current.idempotencyKey, reason }
    }
  }

  // 第 3 步 b：当前步骤副作用核对
  if (!cp.current) {
    // 崩溃在 completeStep 之后、beginStep 之前：无副作用悬空，从下一节点继续
    const last = cp.completedSteps[cp.completedSteps.length - 1]
    return { action: 'resume', workflowId, from: null, skipExecute: false, reason: last ? `已完成至 ${last.node}#${last.seq}，从下一节点继续` : '尚无已完成步骤，从头开始' }
  }
  const verify = deps.verifyStep || defaultVerifyStep
  const verdict = await verify({ checkpoint: cp, step: cp.current, business })
  if (verdict === 'contradiction') {
    const reason = `当前步骤 ${cp.current.node}#${cp.current.seq} 与业务现态矛盾（不可调和），终止工作流`
    store.setStatus(workflowId, 'TERMINATED', reason)
    return { action: 'terminate', workflowId, reason }
  }
  if (verdict === 'done') {
    // 副作用已发生：补登记，跳过重做，由运行器从下一节点继续
    store.markStepRecovered(workflowId, { node: cp.current.node, idempotencyKey: cp.current.idempotencyKey })
    return { action: 'resume', workflowId, from: cp.current.node, skipExecute: true, reason: '业务现态确认副作用已发生，跳过重做' }
  }
  // not-done / unknown：重做并复用原幂等键；若该步骤原本挂在审批上（已裁决但未执行到），需重新发起审批
  if (hadPendingApproval) {
    return { action: 'reissue-approval', workflowId, from: cp.current.node, idempotencyKey: cp.current.idempotencyKey, reason: '旧审批已裁决但副作用未发生（不回放旧批准），重新发起审批' }
  }
  return { action: 'resume', workflowId, from: cp.current.node, skipExecute: false, idempotencyKey: cp.current.idempotencyKey, reason: verdict === 'unknown' ? '副作用证据不足，复用原幂等键重做（服务端幂等回放兜底）' : '副作用未发生，复用原幂等键重做' }
}

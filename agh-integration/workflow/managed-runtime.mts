// Single-process Web workflow supervisor. Tokens stay in memory, never in checkpoints.
import { createHash, randomUUID } from 'node:crypto'
import { writeFileSync, readFileSync, renameSync, openSync, fsyncSync, closeSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { CheckpointStore, type WorkflowCheckpoint } from './checkpoint.mts'
import { runWorkflow, ToolApprovalRequired, type ApprovalRequest } from './runner.mts'
import { recover } from './recovery.mts'
import { buildDisturbanceFlow, type DisturbanceEventInput } from './disturbance-flow.mts'
import type { DisturbanceAgent } from './agent-nodes.mts'
import type { FlowTools, ToolStructured } from './flow-common.mts'

export function argsDigest(value: unknown): string {
  const norm = (v: unknown): unknown => Array.isArray(v) ? v.map(norm)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm((v as Record<string, unknown>)[k])])) : v
  return createHash('sha256').update(JSON.stringify(norm(value))).digest('hex')
}
export interface WorkflowActor { username: string; role: string }
export interface RuntimeApproval {
  requestId: string; workflowId: string | null; conversationId: string; tool: string
  argsDigest: string; expiresAt: number; status: string; approvedBy?: string
}
interface Operation {
  requestId: string; tool: string; args: Record<string, unknown>; digest: string; stepKey: string
  state: 'waiting' | 'executing' | 'done' | 'expired'; result?: ToolStructured
}
interface ManagedRecord {
  version: 3; workflowId: string; owner: string; conversationId: string; inputDigest: string
  eventKey: string; deliveryKey: string; operations: Operation[]; recoveryRequired: boolean
}
export class WorkflowHttpError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code) }
}
export interface RuntimeDeps {
  store: CheckpointStore
  tools: FlowTools
  validate(name: string, args: Record<string, unknown>): boolean
  authenticate(token: string): Promise<WorkflowActor | null>
  registerApproval(conversationId: string, workflowId: string, tool: string, args: Record<string, unknown>): RuntimeApproval
  readApproval(requestId: string): RuntimeApproval | null
  audit(entry: Record<string, unknown>): boolean
  changed(conversationId: string, view: Record<string, unknown>): void
  agent?: (workflowId: string) => DisturbanceAgent | undefined
}
const WRITES = new Set(['fjsp_report_breakdown', 'fjsp_insert_order', 'fjsp_reschedule', 'fjsp_submit_review'])
const READS = new Set(['fjsp_get_dashboard', 'fjsp_get_disturbance_context', 'fjsp_experience_query', 'fjsp_task_status', 'fjsp_get_plan', 'fjsp_compare_plans'])
const terminal = (cp: WorkflowCheckpoint) => ['COMPLETED', 'TERMINATED', 'FAILED'].includes(cp.status)

export class ManagedWorkflowRuntime {
  private records = new Map<string, ManagedRecord>()
  private running = new Map<string, Promise<void>>()
  private gates = new Map<string, Promise<void>>()
  constructor(private deps: RuntimeDeps) {
    for (const cp of deps.store.list()) {
      const path = this.file(cp.workflowId)
      if (!existsSync(path)) continue // Independent legacy workflows are not Web-owned.
      const record = JSON.parse(readFileSync(path, 'utf8')) as ManagedRecord
      if (record.version !== 3 || record.workflowId !== cp.workflowId || !record.owner) throw new Error('Invalid managed workflow metadata')
      record.recoveryRequired = !terminal(cp)
      // Decisions without a persisted execution result cannot survive a process lifetime.
      for (const op of record.operations) if (op.state !== 'done') op.state = 'expired'
      this.records.set(cp.workflowId, record)
      this.save(record)
    }
  }
  private file(id: string) {
    if (!/^wf-[a-zA-Z0-9-]+$/.test(id)) throw new WorkflowHttpError(404, 'workflow_not_found')
    return join(this.deps.store.dir, `managed-${id}.json`)
  }
  private save(record: ManagedRecord) {
    const file = this.file(record.workflowId), tmp = `${file}.tmp-${randomUUID()}`
    const fd = openSync(tmp, 'wx', 0o600)
    try { writeFileSync(fd, JSON.stringify(record)); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(tmp, file)
  }
  private owned(id: string, username: string) {
    const record = this.records.get(id)
    if (!record) throw new WorkflowHttpError(404, 'workflow_not_found')
    if (record.owner !== username) throw new WorkflowHttpError(403, 'workflow_forbidden')
    return record
  }
  view(id: string, username: string) {
    const record = this.owned(id, username), cp = this.deps.store.load(id)!
    return { workflowId: id, conversationId: record.conversationId, status: cp.status,
      reason: cp.statusReason ?? null, currentNode: cp.current?.node ?? null,
      refs: cp.refs, pendingApproval: cp.pendingApproval, completedSteps: cp.completedSteps,
      updatedAt: cp.updatedAt, running: this.running.has(id), recoveryRequired: record.recoveryRequired }
  }
  list(username: string, conversationId?: string) {
    return [...this.records.values()].filter((r) => r.owner === username && (!conversationId || r.conversationId === conversationId))
      .map((r) => this.view(r.workflowId, username))
  }
  activeConversation(conversationId: string) {
    return [...this.records.values()].some((r) => r.conversationId === conversationId && !terminal(this.deps.store.load(r.workflowId)!))
  }
  create(actor: WorkflowActor, token: string, input: { conversationId: string; sourceEventId: string; event: DisturbanceEventInput & { eventId?: string } }) {
    if (!['DISPATCHER', 'ADMIN'].includes(actor.role)) throw new WorkflowHttpError(403, 'workflow_role_forbidden')
    const event = input.event
    const identity = event.eventId ? ['event', event.eventId]
      : event.eventType === 'BREAKDOWN' ? ['BREAKDOWN', event.machineId, new Date(event.occurredAt!).toISOString()]
        : ['NEW_ORDER', event.orderCode]
    const eventKey = argsDigest(identity), deliveryKey = argsDigest([actor.username, input.sourceEventId])
    const digest = argsDigest(event)
    const existing = [...this.records.values()].find((r) => r.eventKey === eventKey || r.deliveryKey === deliveryKey)
    if (existing) {
      if (existing.owner !== actor.username) throw new WorkflowHttpError(409, 'event_already_managed')
      if (existing.inputDigest !== digest) throw new WorkflowHttpError(409, 'workflow_input_conflict')
      return { deduplicated: true, workflow: this.view(existing.workflowId, actor.username) }
    }
    if (this.activeConversation(input.conversationId)) throw new WorkflowHttpError(409, 'conversation_workflow_active')
    const { checkpoint } = this.deps.store.create({ type: 'WEB_DISTURBANCE_V3', trigger: {
      source: 'manual', dedupeKey: `web-v3:${eventKey}`, detail: structuredClone(event),
    } })
    const record: ManagedRecord = { version: 3, workflowId: checkpoint.workflowId, owner: actor.username,
      conversationId: input.conversationId, inputDigest: digest, eventKey, deliveryKey,
      operations: [], recoveryRequired: false }
    this.records.set(record.workflowId, record)
    this.save(record)
    this.enqueue(record, token)
    return { deduplicated: false, workflow: this.view(record.workflowId, actor.username) }
  }
  resume(id: string, actor: WorkflowActor, token: string) {
    const record = this.owned(id, actor.username)
    if (!['DISPATCHER', 'ADMIN'].includes(actor.role)) throw new WorkflowHttpError(403, 'workflow_role_forbidden')
    this.enqueue(record, token)
    return this.view(id, actor.username)
  }
  private notify(record: ManagedRecord) {
    this.deps.changed(record.conversationId, this.view(record.workflowId, record.owner))
  }
  private enqueue(record: ManagedRecord, token: string) {
    if (this.running.has(record.workflowId)) return
    const task = Promise.resolve().then(() => this.drive(record, token)).catch(() => {
      this.deps.store.setStatus(record.workflowId, 'WAITING_APPROVAL', 'WORKFLOW_EXECUTION_UNAVAILABLE：核查业务现态后恢复')
    }).finally(() => { this.running.delete(record.workflowId); this.notify(record) })
    this.running.set(record.workflowId, task)
  }
  async idle(id: string) { await this.running.get(id) }
  private async withGate<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const before = this.gates.get(key) ?? Promise.resolve()
    let unlock!: () => void
    const after = new Promise<void>((resolve) => { unlock = resolve })
    const chain = before.then(() => after)
    this.gates.set(key, chain)
    await before
    try { return await fn() } finally { unlock(); if (this.gates.get(key) === chain) this.gates.delete(key) }
  }
  private async tools(record: ManagedRecord, token: string): Promise<FlowTools> {
    return { call: async (name, args = {}) => {
      if (!READS.has(name) && !WRITES.has(name)) throw new Error('WORKFLOW_TOOL_FORBIDDEN')
      if (!this.deps.validate(name, args)) return { ok: false, error: { code: 'FJSP_INVALID_PARAMS', message: '工作流工具参数校验失败' } }
      if (READS.has(name)) return this.deps.tools.call(name, args)
      const cp = this.deps.store.load(record.workflowId)!
      const stepKey = cp.current?.idempotencyKey
      if (!stepKey || args.idempotencyKey !== stepKey) throw new Error('WORKFLOW_STEP_KEY_MISMATCH')
      const digest = argsDigest(args)
      const operation = [...record.operations].reverse().find((o) => o.stepKey === stepKey && o.tool === name && o.digest === digest)
      if (operation?.state === 'done') return structuredClone(operation.result!)
      return this.withGate(`${record.workflowId}:${stepKey}`, async () => {
        const actor = await this.deps.authenticate(token)
        if (!actor || actor.username !== record.owner || !['DISPATCHER', 'ADMIN'].includes(actor.role)) {
          throw Object.assign(new Error('当前用户身份或写操作权限失效，请重新登录后恢复'), { code: 'E_UNAUTHORIZED' })
        }
        const approval = operation?.state === 'waiting' ? this.deps.readApproval(operation.requestId) : null
        if (approval?.status === 'rejected') {
          this.deps.store.setStatus(record.workflowId, 'TERMINATED', '人工拒绝业务写操作')
          throw Object.assign(new Error('人工拒绝，停止流程'), { code: 'E_INTEGRITY_VIOLATION' })
        }
        const valid = approval?.status === 'approved' && approval.expiresAt > Date.now()
          && approval.workflowId === record.workflowId && approval.conversationId === record.conversationId
          && approval.tool === name && approval.argsDigest === digest && approval.approvedBy === actor.username
        if (!valid) {
          if (operation) operation.state = 'expired'
          const created = this.deps.registerApproval(record.conversationId, record.workflowId, name, args)
          const next: Operation = { requestId: created.requestId, tool: name, args: structuredClone(args), digest, stepKey, state: 'waiting' }
          record.operations.push(next)
          this.save(record)
          throw new ToolApprovalRequired({ tool: name, args, requestId: created.requestId,
            expiresAt: new Date(created.expiresAt).toISOString(), argsDigest: digest })
        }
        // The grant is consumed durably before the business effect. A crash here
        // requires state recovery and a new human decision, never replaying approval.
        operation!.state = 'executing'
        this.save(record)
        if (!this.deps.audit({ workflowId: record.workflowId, requestId: approval.requestId, by: actor.username,
          result: 'workflow_execute', tool: name, argsDigest: digest, idempotencyKey: stepKey })) throw new Error('AUDIT_UNAVAILABLE')
        const result = await this.deps.tools.call(name, structuredClone(args))
        if (result.ok) { operation!.state = 'done'; operation!.result = structuredClone(result) }
        else operation!.state = 'expired'
        this.save(record)
        return result
      })
    } }
  }
  private async drive(record: ManagedRecord, token: string) {
    let cp = this.deps.store.load(record.workflowId)!
    if (terminal(cp)) return
    const tools = await this.tools(record, token)
    if (record.recoveryRequired) {
      const read = async (name: string, args?: Record<string, unknown>) => {
        const out = await this.deps.tools.call(name, args)
        if (!out.ok) throw new Error('BUSINESS_STATE_UNAVAILABLE')
        return out
      }
      const decision = await recover(this.deps.store, record.workflowId, {
        readDashboard: () => read('fjsp_get_dashboard'),
        readTask: (taskId) => read('fjsp_task_status', { taskId, waitSeconds: 0 }),
        readPlan: (planVersionId) => read('fjsp_get_plan', { planVersionId }),
        checkApproval: async () => 'expired', verifyStep: () => 'not-done',
      })
      if (!['resume', 'reissue-approval'].includes(decision.action)) return
      record.recoveryRequired = false
      this.save(record)
      cp = this.deps.store.load(record.workflowId)!
    }
    if (cp.pendingApproval) {
      const approval = this.deps.readApproval(cp.pendingApproval.requestId)
      if (approval?.status === 'pending' && approval.expiresAt > Date.now()) return
      if (approval?.status === 'rejected') {
        this.deps.store.setStatus(record.workflowId, 'TERMINATED', '人工拒绝业务写操作'); return
      }
      this.deps.store.clearApproval(record.workflowId)
    } else if (cp.status === 'WAITING_APPROVAL') {
      if (cp.current?.node === 'await-decision') return // Stage 4 owns actual review/publish actions.
      this.deps.store.setStatus(record.workflowId, 'RUNNING')
    }
    const nodes = buildDisturbanceFlow().map((node) => node.name === 'await-decision' ? {
      ...node, run: () => ({ action: 'suspend' as const, reason: 'REVIEW_PENDING：请在业务审核页面完成评审；本阶段不自动执行评审或发布' }),
    } : node)
    await runWorkflow(record.workflowId, nodes, { store: this.deps.store, tools,
      agent: this.deps.agent?.(record.workflowId),
      log: () => this.notify(record) })
  }
  async recoverOnStartup() {
    for (const record of this.records.values()) {
      if (!record.recoveryRequired) continue
      // Read-only checks may run without a browser token. No model or write is
      // scheduled until an authenticated owner explicitly resumes the instance.
      const cp = this.deps.store.load(record.workflowId)!
      try {
        const state = await this.deps.tools.call('fjsp_get_dashboard')
        if (!state.ok) throw new Error('unavailable')
        if (cp.refs.taskId) {
          const task = await this.deps.tools.call('fjsp_task_status', { taskId: cp.refs.taskId, waitSeconds: 0 })
          if (!task.ok) throw new Error('unavailable')
        }
        if (cp.refs.planVersionId) {
          const plan = await this.deps.tools.call('fjsp_get_plan', { planVersionId: cp.refs.planVersionId })
          if (!plan.ok) throw new Error('unavailable')
        }
        this.deps.store.setStatus(record.workflowId, 'WAITING_APPROVAL', 'AUTH_REQUIRED：重启已读取业务现态，需属主重新登录恢复；旧批准不回放')
      } catch { this.deps.store.setStatus(record.workflowId, 'WAITING_APPROVAL', 'RECOVERY_UNAVAILABLE：业务现态不可核对，不推进') }
      this.notify(record)
    }
  }
}

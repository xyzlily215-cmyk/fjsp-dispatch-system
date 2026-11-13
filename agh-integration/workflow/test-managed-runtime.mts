import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ManagedWorkflowRuntime, argsDigest, type RuntimeApproval, type RuntimeDeps } from './managed-runtime.mts'
import { CheckpointStore } from './checkpoint.mts'
import { contextFixture } from './context-fixture.mts'
const dirs: string[] = []
const actor = { username: 'alice', role: 'DISPATCHER' }
const event = { eventType: 'BREAKDOWN' as const, machineId: 'M-03', occurredAt: '2026-11-02T06:00:00Z', repairDurationMinutes: 120 }
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'managed-wf-')); dirs.push(dir)
  const store = new CheckpointStore(dir)
  let auth = true, audit = true, available = true
  const approvals = new Map<string, RuntimeApproval>()
  const calls: string[] = [], effects: { name: string; args: Record<string, unknown> }[] = []
  const seen = new Map<string, unknown>()
  const deps: RuntimeDeps = {
    store, validate: () => true, authenticate: async (token) => auth && token === 'secret-test-token' ? actor : null,
    registerApproval: (conversationId, workflowId, tool, args) => {
      const record = { requestId: `r-${approvals.size + 1}`, conversationId, workflowId, tool,
        argsDigest: argsDigest(args), expiresAt: Date.now() + 60000, status: 'pending' }
      approvals.set(record.requestId, record); return record
    },
    readApproval: (id) => approvals.get(id) ?? null,
    audit: () => audit, changed: () => {},
    tools: { call: async (name, args = {}) => {
      calls.push(name)
      if (!available) return { ok: false, error: { code: 'FJSP_UNREACHABLE', message: 'offline' } }
      if (name === 'fjsp_get_dashboard') return { ok: true, currentPlan: { id: 'pv-old', kpi: {} }, recentEvents: [] }
      if (name === 'fjsp_get_disturbance_context') return { ok: true, context: contextFixture() }
      if (name === 'fjsp_experience_query') return { ok: true, records: [] }
      if (name === 'fjsp_get_plan') return { ok: true, plan: { id: 'pv-new', version: 1 } }
      if (name === 'fjsp_task_status') return { ok: true, task: { status: 'SUCCESS', resultStatus: 'FEASIBLE', planVersionId: 'pv-new', kpi: {} } }
      if (name === 'fjsp_compare_plans') return { ok: true, diff: {} }
      if (seen.has(String(args.idempotencyKey))) return structuredClone(seen.get(String(args.idempotencyKey))) as any
      effects.push({ name, args: structuredClone(args) })
      const result = name === 'fjsp_report_breakdown' ? { ok: true, event: { eventId: 'ev-1' } }
        : name === 'fjsp_reschedule' ? { ok: true, task: { taskId: 'task-1' } } : { ok: true, plan: { status: 'REVIEW_PENDING' } }
      seen.set(String(args.idempotencyKey), result); return result
    } },
  }
  return { dir, store, deps, approvals, effects, calls,
    control: (values: { auth?: boolean; audit?: boolean; available?: boolean }) => {
      if (values.auth !== undefined) auth = values.auth
      if (values.audit !== undefined) audit = values.audit
      if (values.available !== undefined) available = values.available
    } }
}
function create(runtime: ManagedWorkflowRuntime, detail = event) {
  return runtime.create(actor, 'secret-test-token', { conversationId: 'conv-1', sourceEventId: 'source-1', event: detail })
}
function approve(map: Map<string, RuntimeApproval>, id: string) {
  const approval = map.get(id)!; approval.status = 'approved'; approval.approvedBy = 'alice'
}
try {
  {
    const t = setup(), runtime = new ManagedWorkflowRuntime(t.deps)
    const first = create(runtime), id = first.workflow.workflowId
    const duplicate = create(runtime)
    assert.equal(duplicate.workflow.workflowId, id)
    assert.ok(duplicate.deduplicated)
    assert.throws(() => create(runtime, { ...event, repairDurationMinutes: 90 }), /workflow_input_conflict/)
    assert.throws(() => runtime.view(id, 'bob'), /workflow_forbidden/)
    assert.throws(() => runtime.create({ username: 'reviewer', role: 'REVIEWER' }, '', { conversationId: 'c', sourceEventId: 's', event }), /workflow_role_forbidden/)
    await runtime.idle(id)
    assert.equal(t.effects.length, 0, '创建实例不等于批准业务写入')
    for (const expected of ['fjsp_report_breakdown', 'fjsp_reschedule', 'fjsp_submit_review']) {
      const pending = runtime.view(id, 'alice').pendingApproval!
      assert.equal(pending.tool, expected)
      approve(t.approvals, pending.requestId)
      runtime.resume(id, actor, 'secret-test-token')
      runtime.resume(id, actor, 'secret-test-token')
      await runtime.idle(id)
    }
    assert.equal(t.effects.length, 3)
    assert.equal(runtime.view(id, 'alice').currentNode, 'await-decision')
    assert.equal(runtime.view(id, 'alice').pendingApproval, null)
    assert.ok(!t.calls.includes('fjsp_publish') && !t.calls.includes('fjsp_approve_review'))
    for (const name of readdirSync(t.dir)) assert.ok(!readFileSync(join(t.dir, name), 'utf8').includes('secret-test-token'))
    console.log('PASS managed happy path: dedupe/ownership, per-write approvals, serial resume, no implicit review/publish, token not persisted')
  }
  for (const mode of ['reject', 'expired', 'digest', 'auth', 'audit'] as const) {
    const t = setup(), runtime = new ManagedWorkflowRuntime(t.deps), id = create(runtime).workflow.workflowId
    await runtime.idle(id)
    const pending = runtime.view(id, 'alice').pendingApproval!
    approve(t.approvals, pending.requestId)
    const approval = t.approvals.get(pending.requestId)!
    if (mode === 'reject') approval.status = 'rejected'
    if (mode === 'expired') approval.expiresAt = Date.now() - 1
    if (mode === 'digest') approval.argsDigest = 'mismatch'
    if (mode === 'auth') t.control({ auth: false })
    if (mode === 'audit') t.control({ audit: false })
    runtime.resume(id, actor, 'secret-test-token'); await runtime.idle(id)
    assert.equal(t.effects.length, 0, mode)
  }
  console.log('PASS rejection/expiry/parameter mutation/auth revocation/audit failure all fail closed')
  {
    const t = setup(), first = new ManagedWorkflowRuntime(t.deps), id = create(first).workflow.workflowId
    await first.idle(id)
    const old = first.view(id, 'alice').pendingApproval!
    approve(t.approvals, old.requestId)
    const restarted = new ManagedWorkflowRuntime(t.deps)
    t.control({ available: false }); await restarted.recoverOnStartup()
    assert.equal(t.effects.length, 0)
    assert.ok(restarted.view(id, 'alice').recoveryRequired)
    t.control({ available: true })
    restarted.resume(id, actor, 'secret-test-token'); await restarted.idle(id)
    assert.equal(t.effects.length, 0, '重启后不能消费旧批准')
    assert.notEqual(restarted.view(id, 'alice').pendingApproval?.requestId, old.requestId)
    console.log('PASS restart: business unavailable holds; fresh login reissues approval instead of replay')
  }
} finally { for (const d of dirs) rmSync(d, { recursive: true, force: true }) }

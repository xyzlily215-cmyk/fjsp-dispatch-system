// workflow/test-bff-approval.mts — 工作流 ↔ BFF 审批接线测试（任务 3.4，mock HTTP 层，不起真实 BFF/AGH）。
// 覆盖：挂起→BFF 登记→批准→推进到终态；拒绝→显式终止（不发布）；恢复路径 pending 有效继续等 /
// expired 重发（新 requestId）；BFF 不可达 → 不推进（fail-safe）；登记失败回落本地句柄。
// 运行：cd agh-integration && npx tsx workflow/test-bff-approval.mts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { CheckpointStore, type PendingApproval } from './checkpoint.mts'
import { runWorkflow } from './runner.mts'
import { recover } from './recovery.mts'
import { buildDisturbanceFlow, type FlowTools, type DisturbanceEventInput } from './disturbance-flow.mts'
import type { DisturbanceAgent } from './agent-nodes.mts'
import {
  BffUnavailableError,
  createBffApprovalChannel,
  makeApprovalChecker,
  pollApprovalDecision,
  settleApprovalOutcome,
  type BffApprovalClientOptions,
} from './bff-approval.mts'

const dirs: string[] = []
let seq = 0

const BREAKDOWN_EVENT: DisturbanceEventInput = {
  eventType: 'BREAKDOWN',
  machineId: 'M-03',
  occurredAt: '2026-11-02T06:00:00Z',
  repairDurationMinutes: 120,
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'bff-approval-test-'))
  dirs.push(dir)
  const store = new CheckpointStore(dir)
  const { checkpoint } = store.create({
    type: 'DISTURBANCE',
    trigger: { source: 'test', dedupeKey: `t-${Date.now()}-${seq++}`, detail: BREAKDOWN_EVENT },
  })
  return { store, workflowId: checkpoint.workflowId }
}

// 最小 mock 业务服务（happy path 到 submit-review 挂起）
function makeMockTools() {
  const calls: { name: string; args: Record<string, unknown> }[] = []
  const tools: FlowTools = {
    async call(name, args = {}) {
      calls.push({ name, args })
      switch (name) {
        case 'fjsp_get_dashboard':
          return { ok: true, currentPlan: { id: 'pv-old', kpi: {} }, recentEvents: [] }
        case 'fjsp_report_breakdown':
          return { ok: true, event: { eventId: 'ev-1', eventType: 'BREAKDOWN', status: 'OPEN' } }
        case 'fjsp_experience_query':
          return { ok: true, records: [], recommendation: null }
        case 'fjsp_reschedule':
          return { ok: true, task: { taskId: 'tsk-1', mode: args.mode, status: 'RUNNING' } }
        case 'fjsp_task_status':
          return { ok: true, task: { taskId: args.taskId, status: 'SUCCESS', resultStatus: 'FEASIBLE', planVersionId: 'pv-new-1', kpi: {}, conflicts: [] } }
        case 'fjsp_get_plan':
          return { ok: true, plan: { id: args.planVersionId, version: 4, status: 'DRAFT', kpi: {} } }
        case 'fjsp_compare_plans':
          return { ok: true, diff: { summary: { changed: 1 } } }
        case 'fjsp_submit_review':
          return { ok: true, plan: { id: args.planVersionId, status: 'REVIEW_PENDING', version: 5 } }
        default:
          throw new Error(`未 mock 的工具：${name}`)
      }
    },
  }
  return { tools, calls }
}

const agent: DisturbanceAgent = {
  suggestStrategy: () => ({ mode: 'LOCAL_RESCHEDULE', weights: { makespan: 1 }, rationale: 'r' }),
  explainConflicts: () => 'x',
  buildReviewMaterial: () => '评审材料（mock）',
}

// mock BFF HTTP 层：内存审批记录表，复刻 server.mts 的端点契约
function makeMockBff() {
  const records = new Map<string, { status: string; expiresAt: number; conversationId: string }>()
  const requests: { method: string; path: string; body?: Record<string, unknown>; auth?: string }[] = []
  let n = 0
  let unreachable = false
  const fetchImpl = (async (url: string | URL, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const u = String(url)
    const path = u.slice(u.indexOf('/agent-api') + '/agent-api'.length)
    const body = init?.body ? JSON.parse(init.body) : undefined
    requests.push({ method: init?.method ?? 'GET', path, body, auth: init?.headers?.Authorization })
    if (unreachable) throw new Error('connect ECONNREFUSED')
    const json = (status: number, data: unknown) => ({ status, json: async () => data }) as unknown as Response
    if (init?.method === 'POST' && path === '/approvals') {
      const requestId = `bff-req-${++n}`
      const expiresAt = Date.now() + ((body?.ttlMs as number) ?? 5 * 60_000)
      records.set(requestId, { status: 'pending', expiresAt, conversationId: body!.conversationId as string })
      return json(202, { ok: true, approval: { requestId, conversationId: body!.conversationId, tool: body!.toolCall.name, risk: 'HIGH_RISK', argsDigest: 'd'.repeat(64), argsSummary: 's', bizObject: body!.toolCall.args, requiredRoles: ['REVIEWER', 'ADMIN'], createdAt: Date.now(), expiresAt, status: 'pending' } })
    }
    const m = path.match(/^\/approvals\/(.+)$/)
    if (m) {
      const rec = records.get(decodeURIComponent(m[1]))
      if (!rec) return json(404, { error: 'approval_not_found' })
      return json(200, { ok: true, approval: { requestId: decodeURIComponent(m[1]), status: rec.status, expiresAt: rec.expiresAt } })
    }
    return json(404, { error: 'not_found' })
  }) as unknown as typeof fetch
  const opts: BffApprovalClientOptions = { baseUrl: 'http://mock-bff/agent-api', token: 'wf-token', conversationId: 'conv-wf', fetchImpl }
  return {
    opts,
    records,
    requests,
    decide(requestId: string, status: 'approved' | 'rejected') {
      const rec = records.get(requestId)
      assert.ok(rec, `mock BFF 无记录 ${requestId}`)
      rec.status = status
    },
    expire(requestId: string) {
      const rec = records.get(requestId)
      assert.ok(rec)
      rec.status = 'expired'
    },
    setUnreachable(v: boolean) { unreachable = v },
  }
}

const log = () => {}

async function testSuspendRegisterApproveCompletes() {
  const { store, workflowId } = setup()
  const { tools, calls } = makeMockTools()
  const bff = makeMockBff()
  const channel = createBffApprovalChannel(bff.opts)!
  const nodes = buildDisturbanceFlow()

  // 挂起：审批经 BFF 登记，检查点句柄用 BFF 的 requestId/expiresAt
  const cp = await runWorkflow(workflowId, nodes, { store, tools, agent, log, approvalChannel: channel })
  assert.equal(cp.status, 'WAITING_APPROVAL')
  assert.equal(cp.pendingApproval!.requestId, 'bff-req-1', 'requestId 应来自 BFF 登记')
  assert.ok(Date.parse(cp.pendingApproval!.expiresAt) > Date.now(), 'expiresAt 来自 BFF 记录')
  const regReq = bff.requests.find((r) => r.method === 'POST' && r.path === '/approvals')!
  assert.equal(regReq.auth, 'Bearer wf-token')
  assert.equal(regReq.body!.conversationId, 'conv-wf')
  assert.deepEqual(regReq.body!.toolCall, { name: 'fjsp_approve_review', args: { planVersionId: 'pv-new-1' } })
  assert.equal(regReq.body!.workflowId, workflowId, '登记应带 workflowId 关联键（任务 4.2）')

  // 批准 → 轮询拿到 approved → 推进到终态
  bff.decide('bff-req-1', 'approved')
  const outcome = await pollApprovalDecision(bff.opts, cp.pendingApproval!, { pollMs: 5 })
  assert.equal(outcome, 'approved')
  const done = await settleApprovalOutcome(store, workflowId, nodes, { store, tools, agent, log, approvalChannel: channel }, outcome)
  assert.equal(done.status, 'COMPLETED', '批准后应推进到终态')
  const decisionStep = done.completedSteps.find((s) => s.node === 'await-decision')!
  assert.equal(decisionStep.result!.approvalDecision, 'approved')
  assert.equal(decisionStep.result!.requestId, 'bff-req-1')
  assert.equal(calls.filter((c) => c.name === 'fjsp_submit_review').length, 1, '推进不得重放提交评审')
  assert.ok(!calls.some((c) => c.name === 'fjsp_publish'), '本流程不含发布动作')
  console.log('ok 挂起→BFF 登记→批准→推进到终态')
}

async function testRejectTerminates() {
  const { store, workflowId } = setup()
  const { tools, calls } = makeMockTools()
  const bff = makeMockBff()
  const channel = createBffApprovalChannel(bff.opts)!
  const nodes = buildDisturbanceFlow()
  const cp = await runWorkflow(workflowId, nodes, { store, tools, agent, log, approvalChannel: channel })
  assert.equal(cp.status, 'WAITING_APPROVAL')

  bff.decide(cp.pendingApproval!.requestId, 'rejected')
  const outcome = await pollApprovalDecision(bff.opts, cp.pendingApproval!, { pollMs: 5 })
  assert.equal(outcome, 'rejected')
  const done = await settleApprovalOutcome(store, workflowId, nodes, { store, tools, agent, log, approvalChannel: channel }, outcome)
  assert.equal(done.status, 'TERMINATED', '拒绝应走显式终止分支')
  assert.match(done.statusReason ?? '', /审批被拒绝/)
  assert.match(done.statusReason ?? '', /pv-new-1/)
  assert.equal(done.completedSteps.find((s) => s.node === 'await-decision')!.result!.approvalDecision, 'rejected')
  assert.ok(!calls.some((c) => c.name === 'fjsp_publish' || c.name === 'fjsp_approve_review'), '拒绝后不得执行任何发布/评审写操作')
  console.log('ok 拒绝 → 显式终止（不发布，状态正确）')
}

async function testRecoveryPendingValidWaits() {
  const { store, workflowId } = setup()
  const { tools } = makeMockTools()
  const bff = makeMockBff()
  const channel = createBffApprovalChannel(bff.opts)!
  const cp = await runWorkflow(workflowId, buildDisturbanceFlow(), { store, tools, agent, log, approvalChannel: channel })
  assert.equal(cp.status, 'WAITING_APPROVAL')

  // 恢复：BFF 说 pending 有效 → 继续等（不重发、不作废）
  const decision = await recover(store, workflowId, {
    readDashboard: async () => ({ ok: true, currentPlan: { id: 'pv-old' }, recentEvents: [{ eventId: 'ev-1' }] }),
    readTask: async (taskId) => ({ ok: true, task: { taskId, status: 'SUCCESS', resultStatus: 'FEASIBLE', planVersionId: 'pv-new-1' } }),
    readPlan: async (planVersionId) => ({ ok: true, plan: { id: planVersionId, status: 'REVIEW_PENDING' } }),
    checkApproval: makeApprovalChecker(bff.opts),
  })
  assert.equal(decision.action, 'await-approval', 'pending 有效应继续等')
  assert.equal((decision as { approval: PendingApproval }).approval.requestId, cp.pendingApproval!.requestId)
  assert.equal(store.load(workflowId)!.status, 'WAITING_APPROVAL')
  assert.equal(store.load(workflowId)!.expiredApprovals.length, 0, 'pending 有效不得标过期')
  console.log('ok 恢复：pending 有效继续等（BFF 核对替代默认 unknown）')
}

async function testRecoveryExpiredReissues() {
  const { store, workflowId } = setup()
  const { tools } = makeMockTools()
  const bff = makeMockBff()
  const channel = createBffApprovalChannel(bff.opts)!
  const nodes = buildDisturbanceFlow()
  const cp = await runWorkflow(workflowId, nodes, { store, tools, agent, log, approvalChannel: channel })
  const oldRequestId = cp.pendingApproval!.requestId
  bff.expire(oldRequestId)

  const deps = {
    readDashboard: async () => ({ ok: true, currentPlan: { id: 'pv-old' }, recentEvents: [{ eventId: 'ev-1' }] }),
    readTask: async (taskId: string) => ({ ok: true, task: { taskId, status: 'SUCCESS', resultStatus: 'FEASIBLE', planVersionId: 'pv-new-1' } }),
    readPlan: async (planVersionId: string) => ({ ok: true, plan: { id: planVersionId, status: 'REVIEW_PENDING' } }),
    checkApproval: makeApprovalChecker(bff.opts),
  }
  const decision = await recover(store, workflowId, deps)
  assert.equal(decision.action, 'reissue-approval', 'expired 应标过期重发')
  const after = store.load(workflowId)!
  assert.equal(after.expiredApprovals.length, 1)
  assert.equal(after.expiredApprovals[0].requestId, oldRequestId, '旧审批入过期存档（不回放）')
  assert.equal(after.status, 'RUNNING')

  // 重跑挂起节点 → 重新登记，新 requestId
  const cp2 = await runWorkflow(workflowId, nodes, { store, tools, agent, log, approvalChannel: channel })
  assert.equal(cp2.status, 'WAITING_APPROVAL')
  assert.ok(cp2.pendingApproval!.requestId !== oldRequestId, '重发必须是新 requestId（旧批准不回放）')
  assert.ok(bff.records.has(cp2.pendingApproval!.requestId), '新审批已在 BFF 登记')
  console.log('ok 恢复：expired → 标过期存档 → 重发（新 requestId）')
}

async function testRecoveryBffUnreachableDoesNotAdvance() {
  const { store, workflowId } = setup()
  const { tools } = makeMockTools()
  const bff = makeMockBff()
  const channel = createBffApprovalChannel(bff.opts)!
  const cp = await runWorkflow(workflowId, buildDisturbanceFlow(), { store, tools, agent, log, approvalChannel: channel })
  assert.equal(cp.status, 'WAITING_APPROVAL')
  bff.setUnreachable(true)

  const decision = await recover(store, workflowId, {
    readDashboard: async () => ({ ok: true, currentPlan: { id: 'pv-old' }, recentEvents: [{ eventId: 'ev-1' }] }),
    readTask: async (taskId: string) => ({ ok: true, task: { taskId, status: 'SUCCESS', resultStatus: 'FEASIBLE', planVersionId: 'pv-new-1' } }),
    readPlan: async (planVersionId: string) => ({ ok: true, plan: { id: planVersionId, status: 'REVIEW_PENDING' } }),
    checkApproval: makeApprovalChecker(bff.opts),
  })
  assert.equal(decision.action, 'unavailable', 'BFF 不可达应 fail-safe 不推进')
  const after = store.load(workflowId)!
  assert.equal(after.status, 'WAITING_APPROVAL', '检查点原样保留')
  assert.equal(after.pendingApproval?.requestId, cp.pendingApproval!.requestId, '挂起句柄未被作废')

  // 轮询同样 fail-safe：抛 BffUnavailableError 而不是猜一个结果
  await assert.rejects(
    pollApprovalDecision(bff.opts, cp.pendingApproval!, { pollMs: 5 }),
    (e) => e instanceof BffUnavailableError,
  )
  console.log('ok 恢复：BFF 不可达 → unavailable 不推进，轮询抛 BffUnavailableError')
}

async function testRegisterFailureFallsBackToLocalHandle() {
  const { store, workflowId } = setup()
  const { tools } = makeMockTools()
  const failing = { register: async () => { throw new BffUnavailableError('mock down') } }
  const cp = await runWorkflow(workflowId, buildDisturbanceFlow(), { store, tools, agent, log, approvalChannel: failing })
  assert.equal(cp.status, 'WAITING_APPROVAL', '登记失败仍应挂起（不丢审批语义）')
  assert.match(cp.pendingApproval!.requestId, /^appr-/, '登记失败回落本地句柄，恢复时核对重发')
  console.log('ok 登记失败 → 回落本地句柄（恢复时重发）')
}

const tests = [
  testSuspendRegisterApproveCompletes,
  testRejectTerminates,
  testRecoveryPendingValidWaits,
  testRecoveryExpiredReissues,
  testRecoveryBffUnreachableDoesNotAdvance,
  testRegisterFailureFallsBackToLocalHandle,
]

let failed = 0
for (const t of tests) {
  try {
    await t()
  } catch (e) {
    failed++
    console.error(`FAIL ${t.name}:`, e)
  }
}
for (const d of dirs) rmSync(d, { recursive: true, force: true })
if (failed) {
  console.error(`${failed}/${tests.length} 个用例失败`)
  process.exit(1)
}
console.log(`全部 ${tests.length} 个用例通过`)

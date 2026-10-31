// workflow/test-recovery.mts — 恢复协议测试（任务 3.1 简报第 4 条）。
// 覆盖恢复决策全分支：done / already-terminated / needs-human(FAILED) / unavailable /
// 已完成步骤矛盾→terminate / 当前步骤副作用已发生（skipExecute 跳过重做）/
// 副作用未发生（重做并复用原幂等键）/ 当前步骤矛盾→terminate / pending 审批有效（继续等）/
// 审批过期与无法确认（标过期重发，不回放旧批准）/ 审批已裁决但副作用未发生（重发审批）/
// 崩溃在步骤间隙（从下一节点继续）。全程注入 mock deps，无网络、无副作用。
// 另有一组默认终态读取器（fjsp-tools）的接线测试：mock fetch 验证默认 reader 调对工具与端点。
// 运行：../agnes-harness/node_modules/.bin/tsx workflow/test-recovery.mts（cwd 为 agh-integration）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CheckpointStore, type PendingApproval, type WorkflowCheckpoint } from './checkpoint.mts'
import { recover, type RecoveryDeps, type ToolStructured } from './recovery.mts'

let failures = 0
const assert = (cond: boolean, msg: string) => {
  if (cond) console.log('PASS ' + msg)
  else {
    failures++
    console.log('FAIL ' + msg)
  }
}

const dir = mkdtempSync(join(tmpdir(), 'fjsp-wf-recovery-'))
const store = new CheckpointStore(dir)

const okDashboard = (extra: Record<string, unknown> = {}): ToolStructured => ({ ok: true, recentEvents: [], recentTasks: [], currentPlan: null, ...extra })

// 造一个推进到指定形态的检查点
function makeCp(dedupeKey: string, build: (wfId: string) => void): WorkflowCheckpoint {
  const { checkpoint } = store.create({ type: 'DISTURBANCE', trigger: { source: 'mhs', dedupeKey } })
  build(checkpoint.workflowId)
  return store.load(checkpoint.workflowId)!
}

const futureApproval = (over: Partial<PendingApproval> = {}): PendingApproval => ({
  requestId: 'req-1',
  tool: 'fjsp_publish',
  bizObject: 'PV-100',
  issuedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 300_000).toISOString(),
  ...over,
})

const deps = (over: Partial<RecoveryDeps> = {}): RecoveryDeps => ({
  readDashboard: async () => okDashboard(),
  ...over,
})

// ---- 1. 终态直通 ----
{
  const cp = makeCp('k-done', (wf) => store.setStatus(wf, 'COMPLETED'))
  const d = await recover(store, cp.workflowId, deps())
  assert(d.action === 'done', '分支 done：COMPLETED 直接返回')
}
{
  const cp = makeCp('k-term', (wf) => store.setStatus(wf, 'TERMINATED', '历史矛盾'))
  const d = await recover(store, cp.workflowId, deps())
  assert(d.action === 'already-terminated' && (d as any).reason === '历史矛盾', '分支 already-terminated：TERMINATED 不重复终止')
}
{
  const cp = makeCp('k-failed', (wf) => store.setStatus(wf, 'FAILED', '重试耗尽'))
  const d = await recover(store, cp.workflowId, deps())
  assert(d.action === 'needs-human' && (d as any).reason === '重试耗尽', '分支 needs-human：FAILED 转人工')
}
{
  const d = await recover(store, 'wf-00000000-0000-0000-0000-000000000000', deps())
  assert(d.action === 'not-found', '分支 not-found：检查点不存在')
}

// ---- 2. 业务现态不可核对 → unavailable（绝不推进；不依赖客户端超时，以查终态为准） ----
{
  const cp = makeCp('k-unavail', (wf) => store.beginStep(wf, 'register-event'))
  const d1 = await recover(store, cp.workflowId, deps({ readDashboard: async () => ({ ok: false, error: { code: 'FJSP_UNREACHABLE' } }) }))
  assert(d1.action === 'unavailable', '分支 unavailable：dashboard 不可达（FJSP_UNREACHABLE）')
  const d2 = await recover(store, cp.workflowId, deps({ readDashboard: async () => ({ ok: false, error: { code: 'FJSP_HTTP_503' } }) }))
  assert(d2.action === 'unavailable', '分支 unavailable：服务端 5xx 结果未知')
  const d3 = await recover(store, cp.workflowId, deps({ readDashboard: async () => { throw new Error('socket hang up') } }))
  assert(d3.action === 'unavailable' && (d3 as any).reason.includes('socket hang up'), '分支 unavailable：读取抛异常同样不推进')
  const still = store.load(cp.workflowId)!
  assert(still.status === 'RUNNING' && still.current?.node === 'register-event' && still.current.attempt === 1, 'unavailable 后检查点原样保留（无副作用）')
}

// ---- 3. 已完成步骤业务证据核对 ----
{
  // 证据在现态中存在 → 继续恢复当前步骤（不终止）
  const cp = makeCp('k-evid-ok', (wf) => {
    store.beginStep(wf, 'register-event')
    store.completeStep(wf, { eventId: 'EVT-100' }, { eventId: 'EVT-100' })
    store.beginStep(wf, 'reschedule')
  })
  const d = await recover(store, cp.workflowId, deps({
    readDashboard: async () => okDashboard({ recentEvents: [{ eventId: 'EVT-100', eventType: 'BREAKDOWN' }] }),
  }))
  assert(d.action === 'resume' && (d as any).skipExecute === false, '证据核对：recentEvents 找到已完成步骤的 eventId，不终止')
}
{
  // 检查点声称已提交评审的计划版本，现态里不存在 → 矛盾，终止
  const cp = makeCp('k-evid-bad', (wf) => {
    store.beginStep(wf, 'submit-review')
    store.completeStep(wf, { planVersionId: 'PV-GONE' }, { planVersionId: 'PV-GONE' })
    store.beginStep(wf, 'publish')
  })
  const d = await recover(store, cp.workflowId, deps({
    readPlan: async () => ({ ok: false, error: { code: 'E_NOT_FOUND' } }),
  }))
  assert(d.action === 'terminate' && (d as any).reason.includes('submit-review'), '分支 terminate：已完成步骤的计划版本在现态中不存在（不可调和）')
  assert(store.load(cp.workflowId)!.status === 'TERMINATED', 'terminate 已落盘 TERMINATED')
}
{
  // recentEvents 只留最近 8 条：查不到早期 eventId ≠ 矛盾 → unknown 采信检查点，继续恢复
  const cp = makeCp('k-evid-slice', (wf) => {
    store.beginStep(wf, 'register-event')
    store.completeStep(wf, { eventId: 'EVT-OLD' }, { eventId: 'EVT-OLD' })
    store.beginStep(wf, 'reschedule')
  })
  const d = await recover(store, cp.workflowId, deps({
    readDashboard: async () => okDashboard({ recentEvents: [{ eventId: 'EVT-NEW1' }, { eventId: 'EVT-NEW2' }] }),
  }))
  assert(d.action === 'resume', '证据核对：recentEvents 切片查不到旧事件不定罪（unknown 采信检查点）')
}

// ---- 4. 当前步骤副作用核对（注入节点核对器，模拟 3.2 起的节点语义） ----
{
  // 4a. 副作用已发生 → skipExecute 跳过重做 + 补登记，不落第二次写入
  const cp = makeCp('k-side-done', (wf) => {
    store.beginStep(wf, 'register-event')
    store.completeStep(wf, { eventId: 'EVT-100' }, { eventId: 'EVT-100' })
    store.beginStep(wf, 'submit-review')
  })
  const key = store.load(cp.workflowId)!.current!.idempotencyKey
  const d = await recover(store, cp.workflowId, deps({
    verifyStep: () => 'done',
  }))
  assert(d.action === 'resume' && (d as any).skipExecute === true && (d as any).from === 'submit-review', '分支 skipExecute：副作用已确认，跳过重做')
  const after = store.load(cp.workflowId)!
  assert(after.current === null && after.completedSteps.length === 2, 'skipExecute：当前步骤已补登记进 completedSteps')
  assert(after.completedSteps[1].recovered === true && after.completedSteps[1].idempotencyKey === key, 'skipExecute：补登记标 recovered=true 并保留原幂等键（审计可溯）')
}
{
  // 4b. 副作用未发生 → 重做并复用原幂等键
  const cp = makeCp('k-side-notdone', (wf) => {
    store.beginStep(wf, 'reschedule')
  })
  const key = store.load(cp.workflowId)!.current!.idempotencyKey
  const d = await recover(store, cp.workflowId, deps({ verifyStep: () => 'not-done' }))
  assert(d.action === 'resume' && (d as any).skipExecute === false && (d as any).idempotencyKey === key, '分支 redo：副作用未发生，重做并复用原幂等键')
  assert(store.load(cp.workflowId)!.current!.attempt === 1, 'redo：attempt 未被恢复流程虚增（由运行器重试时 beginStep 递增）')
}
{
  // 4c. 默认核对器（无节点语义注入）→ 保守 not-done：同键重做安全（服务端幂等回放兜底）
  const cp = makeCp('k-side-default', (wf) => store.beginStep(wf, 'insert-order'))
  const d = await recover(store, cp.workflowId, deps())
  assert(d.action === 'resume' && (d as any).skipExecute === false && typeof (d as any).idempotencyKey === 'string', '默认核对：无注入核对器时保守 redo 同键')
}
{
  // 4d. 当前步骤与现态矛盾 → 终止
  const cp = makeCp('k-side-contra', (wf) => store.beginStep(wf, 'publish'))
  const d = await recover(store, cp.workflowId, deps({ verifyStep: () => 'contradiction' }))
  assert(d.action === 'terminate' && (d as any).reason.includes('publish'), '分支 terminate：当前步骤与业务现态矛盾')
  assert(store.load(cp.workflowId)!.status === 'TERMINATED', 'terminate 落盘')
}
{
  // 4e. 崩溃在步骤间隙（completeStep 后、beginStep 前）→ 从下一节点继续
  const cp = makeCp('k-gap', (wf) => {
    store.beginStep(wf, 'register-event')
    store.completeStep(wf, { eventId: 'EVT-100' }, { eventId: 'EVT-100' })
  })
  const d = await recover(store, cp.workflowId, deps({
    readDashboard: async () => okDashboard({ recentEvents: [{ eventId: 'EVT-100' }] }),
  }))
  assert(d.action === 'resume' && (d as any).from === null && (d as any).reason.includes('register-event'), '分支间隙恢复：无当前步骤，从下一节点继续')
}

// ---- 5. 审批恢复 ----
{
  // 5a. pending 仍有效 → 继续等
  const cp = makeCp('k-apr-wait', (wf) => {
    store.beginStep(wf, 'publish')
    store.recordApproval(wf, futureApproval())
  })
  const d = await recover(store, cp.workflowId, deps({ checkApproval: async () => 'pending' }))
  assert(d.action === 'await-approval' && (d as any).approval.requestId === 'req-1', '分支 await-approval：pending 审批有效，继续等')
  assert(store.load(cp.workflowId)!.status === 'WAITING_APPROVAL', 'await-approval：检查点保持 WAITING_APPROVAL')
}
{
  // 5b. 核对器说 pending 但时钟已过有效期 → 以有效期为准，标过期重发
  const cp = makeCp('k-apr-clock', (wf) => {
    store.beginStep(wf, 'publish')
    store.recordApproval(wf, futureApproval({ expiresAt: new Date(Date.now() - 1000).toISOString() }))
  })
  const d = await recover(store, cp.workflowId, deps({ checkApproval: async () => 'pending' }))
  assert(d.action === 'reissue-approval' && (d as any).reason.includes('有效期'), '分支 reissue-approval：时钟过期优先于核对器 pending')
}
{
  // 5c. 无法确认有效（unknown，默认核对器即此行为）→ 标过期重发，不回放旧批准
  const cp = makeCp('k-apr-unknown', (wf) => {
    store.beginStep(wf, 'publish')
    store.recordApproval(wf, futureApproval())
  })
  const key = store.load(cp.workflowId)!.current!.idempotencyKey
  const d = await recover(store, cp.workflowId, deps({ checkApproval: async () => 'unknown' }))
  assert(d.action === 'reissue-approval' && (d as any).from === 'publish' && (d as any).idempotencyKey === key, '分支 reissue-approval：unknown 标过期重发，幂等键复用')
  const after = store.load(cp.workflowId)!
  assert(after.status === 'RUNNING' && after.pendingApproval === null && after.expiredApprovals.length === 1, 'reissue-approval：旧审批已存档 expiredApprovals，状态回 RUNNING')
}
{
  // 5d. 默认核对器（无注入）：未过期 → unknown → 同样标过期重发（BFF 审批记录不持久化，保守方向）
  const cp = makeCp('k-apr-default', (wf) => {
    store.beginStep(wf, 'approve-review')
    store.recordApproval(wf, futureApproval())
  })
  const d = await recover(store, cp.workflowId, deps())
  assert(d.action === 'reissue-approval' && (d as any).reason.includes('无法确认'), '默认核对器：无法确认有效即过期重发（不回放旧批准）')
}
{
  // 5e. 已裁决 + 副作用已发生 → 不回放旧批准，以业务现态为准跳过重做
  const cp = makeCp('k-apr-decided-done', (wf) => {
    store.beginStep(wf, 'publish')
    store.recordApproval(wf, futureApproval())
  })
  const d = await recover(store, cp.workflowId, deps({ checkApproval: async () => 'decided', verifyStep: () => 'done' }))
  assert(d.action === 'resume' && (d as any).skipExecute === true, '分支 decided+done：旧批准不回放，现态确认副作用后跳过')
  assert(store.load(cp.workflowId)!.pendingApproval === null, 'decided+done：挂起已清除')
}
{
  // 5f. 已裁决 + 副作用未发生（批了但崩溃在执行前）→ 重新发起审批
  const cp = makeCp('k-apr-decided-notdone', (wf) => {
    store.beginStep(wf, 'publish')
    store.recordApproval(wf, futureApproval())
  })
  const d = await recover(store, cp.workflowId, deps({ checkApproval: async () => 'decided', verifyStep: () => 'not-done' }))
  assert(d.action === 'reissue-approval' && (d as any).reason.includes('不回放旧批准'), '分支 decided+not-done：重新发起审批而非消费旧批准')
}

// ---- 6. 默认终态读取器接线（fjsp-tools，mock fetch；验证默认 reader 调对工具与端点） ----
{
  process.env.FJSP_AUTH_TOKEN = 'recovery-test-token'
  process.env.FJSP_API_BASE = 'http://recovery-test.invalid/api/v1'
  const fetchCalls: Array<{ url: string; method: string }> = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: any, opts: any) => {
    const u = String(url)
    fetchCalls.push({ url: u, method: (opts && opts.method) || 'GET' })
    const json = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ code: 'OK', data }) })
    if (u.endsWith('/dashboard')) return json({ recentEvents: [], recentTasks: [], currentPlan: null })
    if (u.includes('/schedule-tasks/')) return json({ taskId: 'TSK-1', status: 'SUCCESS' })
    if (u.includes('/plan-versions/') && !u.includes('/operations')) return json({ id: 'PV-1', status: 'REVIEWED' })
    if (u.includes('/operations')) return json({ items: [] })
    throw new Error('unexpected fetch: ' + u)
  }) as any
  try {
    // 新 store + 带 taskId/planVersionId 的检查点，不注入任何 reader → 走默认 fjsp-tools 接线
    const cp = makeCp('k-default-reader', (wf) => {
      store.updateRefs(wf, { taskId: 'TSK-1', planVersionId: 'PV-1' })
      store.beginStep(wf, 'publish')
    })
    const d = await recover(store, cp.workflowId, { verifyStep: () => 'not-done' })
    assert(d.action === 'resume', '默认读取器：fjsp-tools 接线恢复成功')
    assert(fetchCalls.some((c) => c.url.endsWith('/dashboard')), '默认读取器：查了 dashboard')
    assert(fetchCalls.some((c) => c.url.includes('/schedule-tasks/TSK-1')), '默认读取器：按 refs.taskId 查任务终态')
    assert(fetchCalls.some((c) => c.url.includes('/plan-versions/PV-1')), '默认读取器：按 refs.planVersionId 查计划现态')
  } finally {
    globalThis.fetch = realFetch
  }
}

// ---- 收尾 ----
rmSync(dir, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASS (test-recovery)' : `\n${failures} FAILURES (test-recovery)`)
process.exit(failures === 0 ? 0 : 1)

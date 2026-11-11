// Stage 1 contract regression: real tool implementation + mocked business HTTP only.
import assert from 'node:assert/strict'
process.env.FJSP_AUTH_TOKEN = 'stage1-test-token'
process.env.FJSP_API_BASE = 'http://context-test.invalid/api/v1'
const { tools } = await import('./index.mjs')
const map = new Map(tools.map((t) => [t.name, t]))
const contextTool = map.get('fjsp_get_disturbance_context')
assert.ok(contextTool, '只读扰动上下文工具必须已注册')
assert.equal(contextTool.meta.requiresApproval, 'never')
const calls = []
const base = {
  event: { eventId: 'ev/1', eventCode: 'EV-1', eventType: 'BREAKDOWN', status: 'CONFIRMED',
    occurredAt: '2026-11-02T06:00:00Z', machineId: 'M-03', repairDurationMinutes: 120,
    impacts: [{ operationId: 'opaque-operation', impactType: 'SUCCESSOR', lockType: 'HARD_LOCKED' }] },
  preview: { eventId: 'ev/1', eventType: 'BREAKDOWN', occurredAt: '2026-11-02T06:00:00Z', planVersionId: 'pv/old', freezeWindowMinutes: 45,
    hardLockedCount: 2, softLockedCount: 4, impactedOperationCount: 3, impactedOrderCount: 2,
    impactedOrders: ['order-a', 'order-b'], impactSummary: { total: 3, byType: { SUCCESSOR: 3 } },
    modeEstimates: { LOCAL_RESCHEDULE: { estimatedOperationCount: 2 }, FULL_RESCHEDULE: { estimatedOperationCount: 6 } } },
  dashboard: { currentPlan: { id: 'pv/old', versionCode: 'PV-OLD', status: 'PUBLISHED',
    kpi: { cMaxMinutes: 480, weightedTardinessMinutes: 20, nTardy: 1, loadImbalance: 0.12, utilizationByMachine: { M1: 0.8 } } } },
  orders: [
    { orderId: 'order-a', orderCode: 'A', dueAt: '2026-11-02T05:00:00Z', priority: 5, status: 'SCHEDULED' },
    { orderId: 'order-b', orderCode: 'B', dueAt: '2026-11-03T06:00:00Z', priority: 3, status: 'WAITING' },
  ],
}
let data = structuredClone(base)
let errorPath = null
let httpWrites = []
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url)
  calls.push({ url: u, method: opts.method || 'GET', headers: opts.headers })
  if (u.pathname === errorPath) return { ok: false, status: 403, json: async () => ({ code: 'E_FORBIDDEN', message: '拒绝访问' }) }
  let value
  if (opts.method === 'POST') {
    httpWrites.push(JSON.parse(opts.body))
    value = { taskId: 'task-1' }
  } else if (u.pathname.endsWith('/reschedule-preview')) value = data.preview
  else if (u.pathname.endsWith('/events/ev%2F1')) value = data.event
  else if (u.pathname.endsWith('/dashboard')) value = data.dashboard
  else if (u.pathname.endsWith('/orders')) value = data.orders
  else throw new Error(`unexpected ${url}`)
  return { ok: true, status: 200, json: async () => ({ code: 'OK', data: value }) }
}
const args = { eventId: 'ev/1', planVersionId: 'pv/old' }
let out = await contextTool.execute(args)
assert.equal(out.structured.ok, true)
const context = out.structured.context
assert.equal(calls.length, 4)
assert.ok(calls.every((c) => c.method === 'GET'))
assert.equal(calls.find((c) => c.url.pathname.endsWith('/dashboard')).url.searchParams.get('planVersionId'), 'pv/old')
assert.equal(calls.find((c) => c.url.pathname.endsWith('/reschedule-preview')).url.searchParams.get('planVersionId'), 'pv/old')
assert.equal(context.constraints.freezeWindowMinutes, 45)
assert.equal(context.affectedOrders[0].orderId, 'order-a', '归属来自真实 orderId，不截取工序号')
assert.equal(context.affectedOrders[0].minutesToDueAtEvent, -60)
assert.equal(context.deadlinePressure.dueWithin24HoursCount, 1)
assert.equal(context.deadlinePressure.pastDueOrderCount, 1)
assert.equal(context.deadlinePressure.highPriorityOrderCount, 1)
assert.deepEqual(context.baselinePlan.kpi.utilizationByMachine, { M1: 0.8 })
assert.equal(context.constraints.registeredImpacts[0].lockType, 'HARD_LOCKED')
assert.ok(context.limitations.some((s) => s.includes('估算')))
assert.ok(context.provenance.constraints.includes('reschedule-preview'))
assert.deepEqual(JSON.parse(out.content[0].text), out.structured)

calls.length = 0
out = await contextTool.execute({ ...args, freezeWindowMinutes: 45 })
assert.equal(out.structured.ok, true)
assert.equal(calls.find((c) => c.url.pathname.endsWith('/reschedule-preview')).url.searchParams.get('freezeWindowMinutes'), '45')

for (const mutate of [
  (d) => { d.preview.planVersionId = 'other-plan' },
  (d) => { d.event.eventId = 'other-event' },
  (d) => { delete d.preview.hardLockedCount },
  (d) => { d.orders = [] },
  (d) => { d.orders[0].dueAt = 'bad-time' },
  (d) => { d.orders = { items: d.orders } },
  (d) => { delete d.dashboard.currentPlan.kpi },
  (d) => { d.dashboard.currentPlan.kpi = {} },
  (d) => { d.orders[0].dueAt = '2026-11-02T05:00:00' },
  (d) => { d.preview.occurredAt = '2026-11-03T06:00:00Z' },
  (d) => { d.preview.impactedOrderCount = 3 },
  (d) => { d.preview.modeEstimates.LOCAL_RESCHEDULE.estimatedOperationCount = -1 },
]) {
  data = structuredClone(base); mutate(data)
  out = await contextTool.execute(args)
  assert.equal(out.structured.ok, false)
  assert.equal(out.structured.error.code, 'FJSP_BAD_RESPONSE')
}
data = structuredClone(base)
data.event.status = 'CLOSED'
assert.equal((await contextTool.execute(args)).structured.error.code, 'E_STATE_CONFLICT')
data = structuredClone(base)
data.event.eventType = data.preview.eventType = 'NEW_ORDER'
data.event.orderId = 'order-a'
out = await contextTool.execute(args)
assert.equal(out.structured.ok, true, '聚合工具兼容插单事件，不另造一套流程')
data = structuredClone(base)
data.preview.impactedOrders = []
data.preview.impactedOrderCount = 0
data.preview.impactedOperationCount = 0
data.preview.impactSummary = { total: 0, byType: {} }
out = await contextTool.execute(args)
assert.equal(out.structured.ok, true)
assert.equal(out.structured.context.deadlinePressure.minMinutesToDueAtEvent, null)
assert.equal(out.structured.context.deadlinePressure.pastDueOrderCount, 0)
data = structuredClone(base)
assert.equal((await contextTool.execute({ ...args, freezeWindowMinutes: 0 })).structured.error.code, 'FJSP_BAD_RESPONSE')
errorPath = '/api/v1/orders'
assert.equal((await contextTool.execute(args)).structured.error.code, 'E_FORBIDDEN')
errorPath = null
calls.length = 0
assert.equal((await contextTool.execute({ ...args, freezeWindowMinutes: -1 })).structured.error.code, 'FJSP_INVALID_PARAMS')
assert.equal(calls.length, 0)

const reschedule = map.get('fjsp_reschedule')
const weights = { makespan: 0, weightedTardiness: 0.7, deltaPlan: 0.2, machineChange: 0.1 }
out = await reschedule.execute({ mode: 'LOCAL_RESCHEDULE', eventId: 'ev/1', oldPlanVersionId: 'pv/old', weights, freezeWindowMinutes: 0, idempotencyKey: 'stage1-step' })
assert.equal(out.structured.ok, true)
assert.deepEqual(httpWrites.at(-1).objectiveWeights, weights)
assert.equal(httpWrites.at(-1).freezeWindowMinutes, 0)
assert.equal(calls.at(-1).headers['Idempotency-Key'], 'stage1-step')
for (const badWeights of [{ loadImbalance: 1 }, { deltaPlan: -1 }, { machineChange: Infinity }, { unknown: 0.5 }]) {
  calls.length = 0
  out = await reschedule.execute({ mode: 'FULL_RESCHEDULE', eventId: 'ev/1', oldPlanVersionId: 'pv/old', weights: badWeights })
  assert.equal(out.structured.error.code, 'FJSP_INVALID_PARAMS')
  assert.equal(calls.length, 0)
}
assert.equal((await map.get('fjsp_create_baseline').execute({ weights: { deltaPlan: 1 } })).structured.error.code, 'FJSP_INVALID_PARAMS')
assert.equal((await map.get('fjsp_create_baseline').execute({ weights: { loadImbalance: 1 } })).structured.ok, true)
console.log('PASS stage1 context: fixed plan, real ID joins, deadline basis, missing/error fail-closed, mode-specific weights and freeze forwarding')

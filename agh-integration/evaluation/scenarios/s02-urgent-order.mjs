// s02-urgent-order.mjs — Golden 场景 b：紧急插单
// 前置：复位快照 → 基线排程并发布（确定性，纯 API）。
// 触发：紧急插单 ORD-GOLDEN-S02（壳体C ×10，优先级 1，仿真起点 +24h 到达、+30h 交期）。
// 断言：插单事件登记成功、订单与工序实例已创建、影响集合已计算。
// 用法: node s02-urgent-order.mjs [--base URL] [--user U] [--password P] [--no-reset]
import { parseArgs, login, api, resetSnapshot, relMin, buildAndPublishBaseline, assert, emitResult, exitCode } from './common.mjs';

const opts = parseArgs(process.argv.slice(2),
  '用法: node s02-urgent-order.mjs [--base URL] [--user U] [--password P] [--no-reset]');
await login(opts);

const seed = opts.reset ? await resetSnapshot(opts) : { simulationStartAt: undefined };
if (!opts.reset) throw new Error('s02 依赖确定的仿真起点，请先复位快照（去掉 --no-reset）');
const simStart = seed.simulationStartAt;
const baseline = await buildAndPublishBaseline(opts);

console.log('== 触发：紧急插单事件（ORD-GOLDEN-S02，壳体C ×10，优先级 1）==');
const io = await api(opts, '/events/new-orders', {
  method: 'POST',
  idem: 'golden-s02-new-order',
  body: {
    subType: 'URGENT_INSERT',
    orderCode: 'ORD-GOLDEN-S02',
    productFamily: '壳体C',
    quantity: 10,
    arrivalAt: relMin(simStart, 24 * 60),
    dueAt: relMin(simStart, 30 * 60),
    priority: 1,
    occurredAt: relMin(simStart, 24 * 60),
    note: 'golden-s02 紧急插单',
  },
});
assert(typeof io.eventId === 'string' && typeof io.eventCode === 'string', `插单事件已登记 ${io.eventCode}`);
assert(io.orderCode === 'ORD-GOLDEN-S02' && typeof io.orderId === 'string', `订单实例已创建 ${io.orderCode}`);
assert(Array.isArray(io.operationIds) && io.operationIds.length > 0,
  `工序实例已创建（${io.operationIds?.length} 道）`);
assert(io.impactSummary && typeof io.impactSummary.total === 'number',
  `响应含 impactSummary.total（实际 ${io.impactSummary?.total}）`);

const ev = await api(opts, '/events/' + io.eventId);
assert(ev.eventType === 'NEW_ORDER' && ev.subType === 'URGENT_INSERT' && ev.status === 'CONFIRMED',
  `事件详情 NEW_ORDER/URGENT_INSERT/CONFIRMED（实际 ${ev.eventType}/${ev.subType}/${ev.status}）`);

emitResult({
  scenario: 's02-urgent-order',
  triggered: { type: 'NEW_ORDER', subType: 'URGENT_INSERT', orderCode: 'ORD-GOLDEN-S02', productFamily: '壳体C', quantity: 10, priority: 1 },
  eventId: io.eventId,
  eventCode: io.eventCode,
  orderId: io.orderId,
  operationIds: io.operationIds,
  impactSummary: io.impactSummary,
  basePlanVersionId: baseline.planVersionId,
  baseTaskId: baseline.taskId,
  simulationStartAt: simStart,
  expectedTerminal: 'agent 以该 eventId 对 basePlanVersionId 做重调度，把插单排入并走评审；终态候选版本含 ORD-GOLDEN-S02 的工序',
});
process.exit(exitCode());

// s03-mixed-disturbance.mjs — Golden 场景 c：混合扰动（故障 + 插单先后发生）
// 前置：复位快照 → 基线排程并发布（确定性，纯 API）。
// 触发顺序：先 M-03 故障（+24h，维修 120min），再紧急插单 ORD-GOLDEN-S03（盘类B ×10，+25h 登记）。
// 盘类B 候选设备含 M-03，两个扰动存在交互，考察 agent 对先后事件的合并处置。
// 断言：两个事件均登记成功且相互独立（eventId 不同、各自影响集合已计算）。
// 用法: node s03-mixed-disturbance.mjs [--base URL] [--user U] [--password P] [--no-reset]
import { parseArgs, login, api, resetSnapshot, relMin, buildAndPublishBaseline, assert, emitResult, exitCode } from './common.mjs';

const opts = parseArgs(process.argv.slice(2),
  '用法: node s03-mixed-disturbance.mjs [--base URL] [--user U] [--password P] [--no-reset]');
await login(opts);

const seed = opts.reset ? await resetSnapshot(opts) : { simulationStartAt: undefined };
if (!opts.reset) throw new Error('s03 依赖确定的仿真起点，请先复位快照（去掉 --no-reset）');
const simStart = seed.simulationStartAt;
const baseline = await buildAndPublishBaseline(opts);

console.log('== 触发 1/2：设备故障事件（M-03，+24h，维修 120min）==');
const bd = await api(opts, '/events/breakdowns', {
  method: 'POST',
  idem: 'golden-s03-breakdown-m03',
  body: {
    machineId: 'M-03',
    occurredAt: relMin(simStart, 24 * 60),
    repairDurationMinutes: 120,
    source: 'golden-eval',
    note: 'golden-s03 混合扰动-故障',
  },
});
assert(typeof bd.eventId === 'string', `故障事件已登记 ${bd.eventCode}`);

console.log('== 触发 2/2：紧急插单事件（ORD-GOLDEN-S03，盘类B ×10，优先级 1）==');
const io = await api(opts, '/events/new-orders', {
  method: 'POST',
  idem: 'golden-s03-new-order',
  body: {
    subType: 'URGENT_INSERT',
    orderCode: 'ORD-GOLDEN-S03',
    productFamily: '盘类B',
    quantity: 10,
    arrivalAt: relMin(simStart, 25 * 60),
    dueAt: relMin(simStart, 31 * 60),
    priority: 1,
    occurredAt: relMin(simStart, 25 * 60),
    note: 'golden-s03 混合扰动-插单',
  },
});
assert(typeof io.eventId === 'string', `插单事件已登记 ${io.eventCode}`);
assert(io.eventId !== bd.eventId, '两个扰动为相互独立的事件');

const evBd = await api(opts, '/events/' + bd.eventId);
const evIo = await api(opts, '/events/' + io.eventId);
assert(evBd.status === 'CONFIRMED' && evIo.status === 'CONFIRMED',
  `两事件均 CONFIRMED（实际 ${evBd.status}/${evIo.status}）`);

emitResult({
  scenario: 's03-mixed-disturbance',
  triggered: [
    { type: 'BREAKDOWN', machineId: 'M-03', occurredAt: relMin(simStart, 24 * 60), repairDurationMinutes: 120 },
    { type: 'NEW_ORDER', subType: 'URGENT_INSERT', orderCode: 'ORD-GOLDEN-S03', productFamily: '盘类B', quantity: 10, priority: 1 },
  ],
  breakdownEventId: bd.eventId,
  breakdownEventCode: bd.eventCode,
  newOrderEventId: io.eventId,
  newOrderEventCode: io.eventCode,
  orderId: io.orderId,
  operationIds: io.operationIds,
  basePlanVersionId: baseline.planVersionId,
  baseTaskId: baseline.taskId,
  simulationStartAt: simStart,
  expectedTerminal: 'agent 按发生先后处置两个事件（可先故障重调度再插单重调度，或合并评估），最终候选版本同时吸收两类扰动并走评审',
});
process.exit(exitCode());

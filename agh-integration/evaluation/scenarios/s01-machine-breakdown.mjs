// s01-machine-breakdown.mjs — Golden 场景 a：设备故障
// 前置：复位快照 → 基线排程并发布（确定性，纯 API）。
// 触发：M-03 在仿真起点 +24h 发生故障，维修 120 分钟。
// 断言：事件登记成功、影响集合已计算（impactSummary/impacts）、reschedule-preview 可用。
// 用法: node s01-machine-breakdown.mjs [--base URL] [--user U] [--password P] [--no-reset]
import { parseArgs, login, api, resetSnapshot, relMin, buildAndPublishBaseline, assert, emitResult, exitCode } from './common.mjs';

const opts = parseArgs(process.argv.slice(2),
  '用法: node s01-machine-breakdown.mjs [--base URL] [--user U] [--password P] [--no-reset]');
await login(opts);

const seed = opts.reset ? await resetSnapshot(opts) : { simulationStartAt: undefined };
if (!opts.reset) throw new Error('s01 依赖确定的仿真起点，请先复位快照（去掉 --no-reset）');
const simStart = seed.simulationStartAt;
const baseline = await buildAndPublishBaseline(opts);

console.log('== 触发：设备故障事件（M-03，+24h，维修 120min）==');
const bd = await api(opts, '/events/breakdowns', {
  method: 'POST',
  idem: 'golden-s01-breakdown-m03',
  body: {
    machineId: 'M-03',
    occurredAt: relMin(simStart, 24 * 60),
    repairDurationMinutes: 120,
    source: 'golden-eval',
    note: 'golden-s01 设备故障',
  },
});
assert(typeof bd.eventId === 'string' && typeof bd.eventCode === 'string', `故障事件已登记 ${bd.eventCode}`);
assert(bd.impactSummary && typeof bd.impactSummary.total === 'number',
  `响应含 impactSummary.total（实际 ${bd.impactSummary?.total}）`);

const ev = await api(opts, '/events/' + bd.eventId);
assert(ev.eventType === 'BREAKDOWN' && ev.machineId === 'M-03' && ev.status === 'CONFIRMED',
  `事件详情 BREAKDOWN/M-03/CONFIRMED（实际 ${ev.eventType}/${ev.machineId}/${ev.status}）`);
assert(Array.isArray(ev.impacts), '事件详情含 impacts 影响集合');

const preview = await api(opts, `/events/${bd.eventId}/reschedule-preview`);
assert(preview !== null && typeof preview === 'object', 'reschedule-preview 可取（供局部/全量重调度决策）');

emitResult({
  scenario: 's01-machine-breakdown',
  triggered: { type: 'BREAKDOWN', machineId: 'M-03', occurredAt: relMin(simStart, 24 * 60), repairDurationMinutes: 120 },
  eventId: bd.eventId,
  eventCode: bd.eventCode,
  impactSummary: bd.impactSummary,
  impactCount: ev.impacts.length,
  basePlanVersionId: baseline.planVersionId,
  baseTaskId: baseline.taskId,
  simulationStartAt: simStart,
  expectedTerminal: 'agent 以该 eventId 对 basePlanVersionId 做 LOCAL_RESCHEDULE（必要时升级 FULL_RESCHEDULE），产出新候选版本并走评审',
});
process.exit(exitCode());

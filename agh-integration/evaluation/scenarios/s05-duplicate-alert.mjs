// s05-duplicate-alert.mjs — Golden 场景 e：重复告警（同一事件重复投递）
// 前置：复位快照 → 基线排程并发布（确定性，纯 API；使故障影响集合计算有对象）。
// 触发：同一故障事件以同一 Idempotency-Key 连续投递两次（模拟告警重发），
//       再以同一请求体换一个 Idempotency-Key 投递第三次（模拟上游换键重发）。
// 断言：
//   1) 同键同体第二次调用回放首次响应（eventId 相同），不产生第二次写入；
//   2) 换键同体第三次调用被业务指纹拒绝（HTTP 409 / E_DUPLICATE）；
//   3) 事件总数净增恰好 1。
// 依据：IdempotencyService.execute 回放语义（IdempotencyService.java:92-100）、
//       事件指纹去重（EventService.java:211-215）。
// 用法: node s05-duplicate-alert.mjs [--base URL] [--user U] [--password P] [--no-reset]
import { parseArgs, login, api, resetSnapshot, relMin, buildAndPublishBaseline, assert, emitResult, exitCode } from './common.mjs';

const opts = parseArgs(process.argv.slice(2),
  '用法: node s05-duplicate-alert.mjs [--base URL] [--user U] [--password P] [--no-reset]');
await login(opts);

const seed = opts.reset ? await resetSnapshot(opts) : { simulationStartAt: undefined };
if (!opts.reset) throw new Error('s05 依赖确定的仿真起点，请先复位快照（去掉 --no-reset）');
const simStart = seed.simulationStartAt;
await buildAndPublishBaseline(opts);

const before = await api(opts, '/events?eventType=BREAKDOWN&page=0&size=1');
const body = {
  machineId: 'M-05',
  occurredAt: relMin(simStart, 26 * 60),
  repairDurationMinutes: 90,
  source: 'golden-eval',
  note: 'golden-s05 重复告警',
};

console.log('== 触发：同一故障告警投递 3 次（同键×2 + 换键×1）==');
const r1 = await api(opts, '/events/breakdowns', { method: 'POST', idem: 'golden-s05-dup-key', body });
assert(typeof r1.eventId === 'string', `第 1 次投递登记成功 ${r1.eventCode}`);

const r2 = await api(opts, '/events/breakdowns', { method: 'POST', idem: 'golden-s05-dup-key', body });
assert(r2.eventId === r1.eventId && r2.eventCode === r1.eventCode,
  `第 2 次投递（同键同体）回放首次响应 eventId=${r2.eventId}`);

const r3 = await api(opts, '/events/breakdowns', {
  method: 'POST', idem: 'golden-s05-dup-key-other', body, expectError: true,
});
assert(r3.status === 409 && r3.code === 'E_DUPLICATE',
  `第 3 次投递（换键同体）被拒 HTTP ${r3.status} ${r3.code}`);

const after = await api(opts, '/events?eventType=BREAKDOWN&page=0&size=1');
assert(after.total - before.total === 1,
  `BREAKDOWN 事件总数净增 1（实际 ${before.total} -> ${after.total}）`);

emitResult({
  scenario: 's05-duplicate-alert',
  triggered: { type: 'BREAKDOWN', machineId: 'M-05', occurredAt: relMin(simStart, 26 * 60), repairDurationMinutes: 90, deliveries: 3 },
  eventId: r1.eventId,
  eventCode: r1.eventCode,
  idempotentReplay: r2.eventId === r1.eventId,
  fingerprintRejected: r3.status === 409 && r3.code === 'E_DUPLICATE',
  eventCountDelta: after.total - before.total,
  simulationStartAt: simStart,
  expectedTerminal: 'agent/上游重复投递同一告警时系统不产生第二次事件写入；agent 侧应识别重复告警，不重复发起重调度',
});
process.exit(exitCode());

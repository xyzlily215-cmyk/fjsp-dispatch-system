// s04-infeasible.mjs — Golden 场景 d：不可行解（INFEASIBLE）
// 前置：复位快照 → 基线排程并发布（确定性，纯 API）。
// 触发：8 台设备同时登记覆盖整个排程 horizon（仿真起点 +0 起 6300 分钟）的故障事件，
//       所有候选设备均无可用区间，任何重调度必然不可行。
// 断言（确定性业务侧自检，agent 表现由 0.3 另评）：
//   对触发事件发起的 FULL_RESCHEDULE 任务终态 status=INFEASIBLE、resultStatus=INFEASIBLE、
//   conflicts 含规则 NO_FEASIBLE_WINDOW（algorithm-service/app/instance.py:457）。
// agent 预期行为（0.3 断言）：解释冲突并给出处置建议，不盲目重试、不提交评审。
// 用法: node s04-infeasible.mjs [--base URL] [--user U] [--password P] [--no-reset]
import { parseArgs, login, api, resetSnapshot, relMin, buildAndPublishBaseline, waitTask, assert, emitResult, exitCode } from './common.mjs';

const MACHINES = ['M-01', 'M-02', 'M-03', 'M-04', 'M-05', 'M-06', 'M-07', 'M-08'];
const HORIZON_MINUTES = 6300; // seed/demo_instance.json 设备可用区间末端（相对仿真起点）

const opts = parseArgs(process.argv.slice(2),
  '用法: node s04-infeasible.mjs [--base URL] [--user U] [--password P] [--no-reset]');
await login(opts);

const seed = opts.reset ? await resetSnapshot(opts) : { simulationStartAt: undefined };
if (!opts.reset) throw new Error('s04 依赖确定的仿真起点，请先复位快照（去掉 --no-reset）');
const simStart = seed.simulationStartAt;
const baseline = await buildAndPublishBaseline(opts);

console.log('== 触发：全车间停摆（8 台设备 × 全 horizon 故障）==');
const events = [];
for (const machineId of MACHINES) {
  const bd = await api(opts, '/events/breakdowns', {
    method: 'POST',
    idem: `golden-s04-breakdown-${machineId}`,
    body: {
      machineId,
      occurredAt: relMin(simStart, 0),
      repairDurationMinutes: HORIZON_MINUTES,
      source: 'golden-eval',
      note: 'golden-s04 全车间停摆（构造不可行解）',
    },
  });
  assert(typeof bd.eventId === 'string', `${machineId} 故障事件已登记 ${bd.eventCode}`);
  events.push({ machineId, eventId: bd.eventId, eventCode: bd.eventCode });
}

console.log('== 业务侧自检：FULL_RESCHEDULE 必须落在 INFEASIBLE ==');
const rs = await api(opts, '/schedule-tasks', {
  method: 'POST',
  body: { mode: 'FULL_RESCHEDULE', oldPlanVersionId: baseline.planVersionId, eventId: events[0].eventId },
});
const task = await waitTask(opts, rs.taskId, '不可行重调度任务');
assert(task.status === 'INFEASIBLE' && task.resultStatus === 'INFEASIBLE',
  `重调度任务终态 INFEASIBLE（实际 status=${task.status} resultStatus=${task.resultStatus}）`);
const conflicts = task.conflicts || [];
assert(Array.isArray(conflicts) && conflicts.length > 0, `conflicts 非空（${conflicts.length} 条）`);
assert(conflicts.some(c => c.rule === 'NO_FEASIBLE_WINDOW'),
  `conflicts 含 NO_FEASIBLE_WINDOW（实际规则: ${[...new Set(conflicts.map(c => c.rule))].join(',')}）`);
assert(!task.planVersionId, '不可行任务不产生新计划版本');

emitResult({
  scenario: 's04-infeasible',
  triggered: events.map(e => ({ type: 'BREAKDOWN', machineId: e.machineId, occurredAt: relMin(simStart, 0), repairDurationMinutes: HORIZON_MINUTES })),
  eventIds: events.map(e => e.eventId),
  triggerEventId: events[0].eventId,
  basePlanVersionId: baseline.planVersionId,
  selfCheckTaskId: rs.taskId,
  selfCheckResult: { status: task.status, resultStatus: task.resultStatus, conflictRules: [...new Set(conflicts.map(c => c.rule))] },
  simulationStartAt: simStart,
  expectedTerminal: 'agent 重调度得到 INFEASIBLE 后解释 conflicts（NO_FEASIBLE_WINDOW：所有候选设备均无可容纳工序的连续可用区间）并建议处置（调整维修窗口/外协/交期协商），不盲目重试、不提交评审',
});
process.exit(exitCode());

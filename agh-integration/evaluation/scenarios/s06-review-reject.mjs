// s06-review-reject.mjs — Golden 场景 f：审批拒绝
// 前置：复位快照 → 基线排程（确定性，纯 API）→ 提交评审。
// 触发：评审决定 REJECT（带驳回意见）。
// 断言：
//   1) 计划版本终态 REJECTED，乐观锁 version 已推进；
//   2) 无发布副作用：dashboard.currentPlan 仍为空、REJECTED 版本上 publish 被状态机拒绝（E_STATE_CONFLICT）；
//   3) 审计链完整：存在 PLAN_SUBMIT_REVIEW 与 PLAN_REVIEW_REJECT，不存在 PLAN_PUBLISH。
// 依据：评审状态机（PlanReviewService.java:139-162）、发布守卫（PlanPublishService.java:80-94）。
// 用法: node s06-review-reject.mjs [--base URL] [--user U] [--password P] [--no-reset]
import { parseArgs, login, api, resetSnapshot, waitTask, assert, emitResult, exitCode, GOLDEN_WEIGHTS, GOLDEN_ALGORITHM } from './common.mjs';

const opts = parseArgs(process.argv.slice(2),
  '用法: node s06-review-reject.mjs [--base URL] [--user U] [--password P] [--no-reset]');
await login(opts);

const seed = opts.reset ? await resetSnapshot(opts) : null;
if (!opts.reset) throw new Error('s06 依赖确定的快照状态，请先复位快照（去掉 --no-reset）');

console.log('== 前置：基线排程 + 提交评审 ==');
const orders = await api(opts, '/orders');
const created = await api(opts, '/schedule-tasks', {
  method: 'POST',
  body: { mode: 'BASELINE', orderIds: orders.map(o => o.orderId), objectiveWeights: GOLDEN_WEIGHTS, algorithm: GOLDEN_ALGORITHM },
});
const task = await waitTask(opts, created.taskId, '基线任务');
// GA 触达 timeLimitSeconds 时终态为 TIME_LIMIT + FEASIBLE（solver.py:120），基线仍可用，不算失败
assert(['SUCCESS', 'TIME_LIMIT'].includes(task.status) && task.resultStatus === 'FEASIBLE',
  `基线任务 SUCCESS/TIME_LIMIT+FEASIBLE（实际 status=${task.status} resultStatus=${task.resultStatus}）`);
const pvId = task.planVersionId;

let pv = await api(opts, '/plan-versions/' + pvId);
await api(opts, `/plan-versions/${pvId}/submit-review`, { method: 'POST', body: { version: pv.version } });
pv = await api(opts, '/plan-versions/' + pvId);
assert(pv.status === 'REVIEW_PENDING', `submit-review 后 REVIEW_PENDING（实际 ${pv.status}）`);

console.log('== 触发：评审拒绝（decision=REJECT）==');
await api(opts, `/plan-versions/${pvId}/review`, {
  method: 'POST',
  body: { decision: 'REJECT', comment: 'golden-s06 演练驳回：KPI 不达标，退回调整', version: pv.version },
});
pv = await api(opts, '/plan-versions/' + pvId);
assert(pv.status === 'REJECTED', `review REJECT 后 REJECTED（实际 ${pv.status}）`);
assert(pv.reviewComment && pv.reviewComment.includes('golden-s06'), '驳回意见已落库');

console.log('== 断言：无发布副作用 ==');
const dash = await api(opts, '/dashboard');
assert(dash.currentPlan === null, `dashboard.currentPlan 为空（实际 ${JSON.stringify(dash.currentPlan)}）`);
const pub = await api(opts, `/plan-versions/${pvId}/publish`, {
  method: 'POST', body: { version: pv.version }, expectError: true,
});
assert(pub.status === 409 && pub.code === 'E_STATE_CONFLICT',
  `REJECTED 版本上 publish 被拒 HTTP ${pub.status} ${pub.code}`);
pv = await api(opts, '/plan-versions/' + pvId);
assert(pv.status === 'REJECTED', `publish 尝试后状态仍 REJECTED（实际 ${pv.status}）`);

const audit = await api(opts, `/audit-logs?objectType=plan_version&objectId=${encodeURIComponent(pvId)}&size=100`);
const actions = (audit.items || []).map(it => it.action);
assert(actions.includes('PLAN_SUBMIT_REVIEW') && actions.includes('PLAN_REVIEW_REJECT'),
  `审计含 PLAN_SUBMIT_REVIEW 与 PLAN_REVIEW_REJECT（实际 ${actions.join(',')}）`);
assert(!actions.includes('PLAN_PUBLISH'), '审计不含 PLAN_PUBLISH（无发布副作用）');

emitResult({
  scenario: 's06-review-reject',
  triggered: { type: 'REVIEW_REJECT', planVersionId: pvId, comment: 'golden-s06 演练驳回：KPI 不达标，退回调整' },
  planVersionId: pvId,
  taskId: created.taskId,
  finalStatus: pv.status,
  auditActions: actions,
  simulationStartAt: seed.simulationStartAt,
  expectedTerminal: '评审被拒后计划版本停留 REJECTED、无 PUBLISHED 副作用；agent 可建议 fjsp_revise_plan 退回修改后重新提审，不得绕过评审直接发布',
});
process.exit(exitCode());

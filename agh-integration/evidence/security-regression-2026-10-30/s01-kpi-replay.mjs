// s01-kpi-replay.mjs — 任务 1.3 基线可复现校验（API 层降级项）：
// 在隔离回归环境精确复现基线 s01（设备故障）agent 处置的业务路径：
//   复位快照 → 基线排程发布（GOLDEN_ALGORITHM）→ 登记 M-03 故障（s01 参数）
//   → LOCAL_RESCHEDULE（请求体与基线事件流中 agent 的 fjsp_reschedule 调用逐字段一致：
//     {mode, eventId, oldPlanVersionId}，不带 weights/algorithm，见
//     evidence/baseline-2026-10-30/s01-skill-run1.jsonl 的 tool/call）
//   → 对比候选 KPI 与 BASELINE.md（cMax 3355 / 加权拖期 60199 / 负载 0.102175 / Δ_plan 0.128166）
//   → 候选版本走 提审→评审通过→发布，核对审计链 SUBMIT→APPROVE→PUBLISH。
// 用法: node s01-kpi-replay.mjs（需 FJSP_API_BASE 等环境变量，同 evaluation/scenarios）
import { parseArgs, login, api, resetSnapshot, waitTask, assert, emitResult, exitCode, relMin, GOLDEN_WEIGHTS, GOLDEN_ALGORITHM } from '../../evaluation/scenarios/common.mjs';

const EXPECT_KPI = { cMaxMinutes: 3355, weightedTardinessMinutes: 60199, loadImbalance: 0.102175 };

const opts = parseArgs(process.argv.slice(2),
  '用法: node s01-kpi-replay.mjs [--base URL] [--user U] [--password P]');
await login(opts);
const seed = await resetSnapshot(opts);

console.log('== 前置：基线排程 + 审批发布（GOLDEN_ALGORITHM）==');
const orders = await api(opts, '/orders');
const created = await api(opts, '/schedule-tasks', {
  method: 'POST',
  body: { mode: 'BASELINE', orderIds: orders.map(o => o.orderId), objectiveWeights: GOLDEN_WEIGHTS, algorithm: GOLDEN_ALGORITHM },
});
const baseTask = await waitTask(opts, created.taskId, '基线任务');
assert(['SUCCESS', 'TIME_LIMIT'].includes(baseTask.status) && baseTask.resultStatus === 'FEASIBLE',
  `基线任务 SUCCESS/TIME_LIMIT+FEASIBLE（实际 ${baseTask.status}/${baseTask.resultStatus}）`);
const basePvId = baseTask.planVersionId;
let pv = await api(opts, '/plan-versions/' + basePvId);
await api(opts, `/plan-versions/${basePvId}/submit-review`, { method: 'POST', body: { version: pv.version } });
pv = await api(opts, '/plan-versions/' + basePvId);
await api(opts, `/plan-versions/${basePvId}/review`, { method: 'POST', body: { decision: 'APPROVE', comment: 'kpi-replay 前置自动通过', version: pv.version } });
pv = await api(opts, '/plan-versions/' + basePvId);
await api(opts, `/plan-versions/${basePvId}/publish`, { method: 'POST', body: { version: pv.version } });
pv = await api(opts, '/plan-versions/' + basePvId);
assert(['PUBLISHED', 'EXECUTING'].includes(pv.status), `基线发布 ${pv.status}（${pv.versionCode}）`);

console.log('== 触发：M-03 故障（s01 参数：+1440min，维修 120min）==');
const evt = await api(opts, '/events/breakdowns', {
  method: 'POST', idem: 'golden-s01-breakdown-m03',
  body: { machineId: 'M-03', occurredAt: relMin(seed.simulationStartAt, 1440), repairDurationMinutes: 120, source: 'golden-eval' },
});
assert(typeof evt.eventId === 'string' && evt.impactSummary?.total === 12,
  `故障事件已登记且影响集合 total=12（实际 ${evt.impactSummary?.total}，基线=12）`);
const evtDetail = await api(opts, '/events/' + evt.eventId);
assert(evtDetail.status === 'CONFIRMED', `事件详情 CONFIRMED（实际 ${evtDetail.status}）`);

console.log('== 处置：LOCAL_RESCHEDULE（请求体与基线 agent 调用一致）==');
const reTask = await api(opts, '/schedule-tasks', {
  method: 'POST',
  body: { mode: 'LOCAL_RESCHEDULE', eventId: evt.eventId, oldPlanVersionId: basePvId },
});
const task = await waitTask(opts, reTask.taskId, '局部重排任务');
assert(['SUCCESS', 'TIME_LIMIT'].includes(task.status) && task.resultStatus === 'FEASIBLE',
  `重调度 SUCCESS/TIME_LIMIT+FEASIBLE（实际 ${task.status}/${task.resultStatus}）`);
assert((task.conflicts || []).length === 0, `conflicts 为空（实际 ${(task.conflicts || []).length}，基线=0）`);

const kpi = task.kpi || {};
const deltaPlan = kpi.deltaPlan?.deltaPlan;
console.log(`[KPI] cMax=${kpi.cMaxMinutes} wT=${kpi.weightedTardinessMinutes} load=${kpi.loadImbalance} deltaPlan=${deltaPlan}`);
assert(kpi.cMaxMinutes === EXPECT_KPI.cMaxMinutes, `cMax=${kpi.cMaxMinutes}（基线 ${EXPECT_KPI.cMaxMinutes}）`);
assert(kpi.weightedTardinessMinutes === EXPECT_KPI.weightedTardinessMinutes,
  `加权拖期=${kpi.weightedTardinessMinutes}（基线 ${EXPECT_KPI.weightedTardinessMinutes}）`);
assert(Math.abs(kpi.loadImbalance - EXPECT_KPI.loadImbalance) < 1e-9,
  `负载均衡=${kpi.loadImbalance}（基线 ${EXPECT_KPI.loadImbalance}）`);
assert(Math.abs(deltaPlan - 0.128166) < 1e-9, `Δ_plan=${deltaPlan}（基线 0.128166）`);

console.log('== 终态：候选版本提审 → 评审通过 → 发布，核对审计链 ==');
const candPvId = task.planVersionId;
pv = await api(opts, '/plan-versions/' + candPvId);
await api(opts, `/plan-versions/${candPvId}/submit-review`, { method: 'POST', body: { version: pv.version } });
pv = await api(opts, '/plan-versions/' + candPvId);
await api(opts, `/plan-versions/${candPvId}/review`, { method: 'POST', body: { decision: 'APPROVE', comment: 'kpi-replay 评审通过', version: pv.version } });
pv = await api(opts, '/plan-versions/' + candPvId);
await api(opts, `/plan-versions/${candPvId}/publish`, { method: 'POST', body: { version: pv.version } });
pv = await api(opts, '/plan-versions/' + candPvId);
assert(['PUBLISHED', 'EXECUTING'].includes(pv.status), `候选版本发布 ${pv.status}（${pv.versionCode}）`);

const audit = await api(opts, `/audit-logs?objectType=plan_version&objectId=${encodeURIComponent(candPvId)}&size=100`);
const actions = (audit.items || []).map(it => it.action);
assert(actions.includes('PLAN_SUBMIT_REVIEW') && actions.includes('PLAN_REVIEW_APPROVE') && actions.includes('PLAN_PUBLISH'),
  `审计链 SUBMIT→APPROVE→PUBLISH（实际 ${actions.join(',')}，基线一致）`);

const dash = await api(opts, '/dashboard');
assert(dash.currentPlan && dash.currentPlan.id === candPvId,
  `dashboard.currentPlan 为新发布版本（实际 ${dash.currentPlan?.id}）`);
assert(dash.currentPlan?.kpi?.cMaxMinutes === EXPECT_KPI.cMaxMinutes,
  `dashboard 复核 cMax=${dash.currentPlan?.kpi?.cMaxMinutes}（基线 dashboard 复核一致）`);

emitResult({
  scenario: 's01-kpi-replay',
  basePlanVersionId: basePvId,
  eventId: evt.eventId,
  rescheduleTaskId: reTask.taskId,
  candidatePlanVersionId: candPvId,
  candidateVersionCode: pv.versionCode,
  kpi: { cMaxMinutes: kpi.cMaxMinutes, weightedTardinessMinutes: kpi.weightedTardinessMinutes, loadImbalance: kpi.loadImbalance, deltaPlan },
  baselineKpi: { ...EXPECT_KPI, deltaPlan: 0.128166 },
  auditActions: actions,
});
process.exit(exitCode());

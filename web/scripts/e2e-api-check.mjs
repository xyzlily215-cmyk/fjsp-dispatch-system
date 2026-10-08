// e2e-api-check.mjs — 模拟前端依赖的完整流程，校验每个接口的字段名与结构
// 用法: node scripts/e2e-api-check.mjs（可用 FJSP_AUTH_USER/FJSP_AUTH_PASSWORD 覆盖登录账号）
const API = process.env.FJSP_API || 'http://localhost:8081/api/v1';
const AUTH_USER = process.env.FJSP_AUTH_USER || 'admin';
const AUTH_PASS = process.env.FJSP_AUTH_PASSWORD || 'Fj@123456';
let failures = 0;
let TOKEN = null;

function assert(cond, msg) {
  if (cond) { console.log('PASS ' + msg); }
  else { failures++; console.log('FAIL ' + msg); }
}
function hasFields(obj, fields, ctx) {
  for (const f of fields) assert(obj && Object.prototype.hasOwnProperty.call(obj, f), `${ctx} 含字段 ${f}`);
}

async function call(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (TOKEN) headers['Authorization'] = 'Bearer ' + TOKEN;
  if (body) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers['Idempotency-Key'] = crypto.randomUUID();
  const resp = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await resp.json();
  assert(json && typeof json.requestId === 'string' && typeof json.code === 'string'
    && typeof json.message === 'string' && Object.prototype.hasOwnProperty.call(json, 'data'),
    `${method} ${path} 响应包络 {requestId,code,message,data}`);
  if (json.code !== 'OK') throw new Error(`${method} ${path} -> ${json.code}: ${json.message}`);
  return json.data;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
/* 相对当前时间的 ISO 时间（分钟偏移）——仿真起点为 RELATIVE 模式（seed 基准=当前时间） */
const relIso = (minutesFromNow) => new Date(Date.now() + minutesFromNow * 60000).toISOString();

// 0. 未认证请求应 401；随后登录拿 token
console.log('== auth ==');
{
  const raw = await fetch(API + '/machines');
  assert(raw.status === 401, `未认证 GET /machines 返回 401（实际 ${raw.status}）`);
  const resp = await fetch(API + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: AUTH_USER, password: AUTH_PASS }),
  });
  const json = await resp.json();
  assert(json && json.code === 'OK', `登录成功 user=${AUTH_USER}`);
  hasFields(json.data || {}, ['token', 'username', 'role', 'displayName', 'expiresAt'], 'auth/login');
  if (!json.data || !json.data.token) throw new Error('登录失败，无法继续: ' + JSON.stringify(json));
  TOKEN = json.data.token;
  const me = await call('/auth/me');
  assert(me.username === AUTH_USER, `auth/me 返回当前用户 ${AUTH_USER}`);
}

async function waitTask(taskId, label) {
  for (let i = 0; i < 60; i++) {
    const t = await call('/schedule-tasks/' + taskId);
    if (!['PENDING', 'RUNNING'].includes(t.status)) return t;
    await sleep(1000);
  }
  throw new Error(label + ' 轮询超时');
}

// 1. 重置演示数据
console.log('== demo/reset ==');
const reset = await call('/demo/reset', { method: 'POST', body: {} });
hasFields(reset, ['reset', 'seed'], 'demo/reset');

// 2. 基础数据接口（轻量页依赖）
console.log('== 基础数据 ==');
const machines = await call('/machines');
hasFields(machines[0], ['machineId', 'machineCode', 'workCenterId', 'calendarId', 'productFamilies', 'status'], 'machines[0]');
const orders = await call('/orders');
hasFields(orders[0], ['orderId', 'orderCode', 'productFamily', 'quantity', 'arrivalAt', 'dueAt', 'priority', 'status', 'operations'], 'orders[0]');
hasFields(orders[0].operations[0], ['operationId', 'seqNo', 'status', 'candidates'], 'orders[0].operations[0]');
const templates = await call('/process-templates');
hasFields(templates[0], ['templateId', 'templateCode', 'productFamily', 'templateVersion', 'status', 'operations'], 'templates[0]');
hasFields(templates[0].operations[0], ['sequenceNo', 'operationCode', 'defaultCandidates'], 'templates[0].operations[0]');

// 3. 看板
console.log('== dashboard ==');
let dash = await call('/dashboard');
hasFields(dash, ['currentPlan', 'orderStats', 'machines', 'recentEvents', 'recentTasks', 'exceptions'], 'dashboard');
hasFields(dash.exceptions, ['delayedOrders', 'breakdowns'], 'dashboard.exceptions');
assert(dash.currentPlan === null, '重置后无当前发布计划（看板空状态分支）');

// 4. 创建基线
console.log('== 创建基线 ==');
const created = await call('/schedule-tasks', {
  method: 'POST',
  body: {
    mode: 'BASELINE',
    orderIds: orders.map(o => o.orderId),
    objectiveWeights: { makespan: 0.4, weightedTardiness: 0.4, loadImbalance: 0.2 },
    algorithm: { populationSize: 40, generations: 60, randomSeed: 42, timeLimitSeconds: 30 },
  },
});
hasFields(created, ['taskId', 'taskCode', 'status', 'snapshotHash'], 'createTask');

// 5. 任务轮询
console.log('== 任务轮询 ==');
const task = await waitTask(created.taskId, '基线任务');
hasFields(task, ['taskId', 'taskCode', 'mode', 'status', 'progress', 'resultStatus', 'feasibleSolution',
  'planVersionId', 'kpi', 'conflicts', 'algorithmVersion', 'randomSeed', 'elapsedMs', 'startedAt', 'finishedAt'], 'task detail');
assert(task.status === 'SUCCESS', `基线任务成功（实际 ${task.status}）`);
hasFields(task.kpi, ['cMaxMinutes', 'weightedTardinessMinutes', 'nTardy', 'loadImbalance', 'utilizationByMachine'], 'task.kpi');

// 6. 版本列表（分页包络）+ 详情（摘要）+ 工序（独立分页端点）
console.log('== 计划版本 ==');
const versionsPage = await call('/plan-versions?page=0&size=20');
hasFields(versionsPage, ['items', 'page', 'size', 'total', 'totalPages'], 'planVersions 分页包络');
const versions = versionsPage.items;
hasFields(versions[0], ['id', 'versionCode', 'parentId', 'candidateGroupId', 'candidateType', 'status', 'kpi', 'version', 'publishedAt', 'createdAt'], 'planVersions.items[0]');
const pvId = task.planVersionId;
const pv = await call('/plan-versions/' + pvId);
hasFields(pv, ['id', 'versionCode', 'status', 'version', 'reviewComment', 'operationCount', 'kpi'], 'planVersion detail');
assert(!('operations' in pv), 'planVersion detail 不再内嵌全量 operations');
assert(pv.operationCount > 0, 'planVersion detail 含工序计数 operationCount');
const pvOpsPage = await call(`/plan-versions/${pvId}/operations?size=5000`);
hasFields(pvOpsPage, ['items', 'page', 'size', 'total', 'totalPages'], 'operations 分页包络');
const pvOps = pvOpsPage.items;
assert(pvOps.length === pv.operationCount, 'operations 端点一次取回全部工序');
hasFields(pvOps[0], ['operationId', 'machineId', 'setupStartAt', 'processStartAt', 'startAt', 'endAt',
  'changeoverMinutes', 'frozen', 'affected', 'reasonCode'], 'operations.items[0]');

// 7. 提交审核 -> 审核通过 -> 发布
console.log('== 审核发布 ==');
await call(`/plan-versions/${pvId}/submit-review`, { method: 'POST', body: { version: pv.version } });
let v = (await call('/plan-versions/' + pvId));
assert(v.status === 'REVIEW_PENDING', 'submit-review 后状态 REVIEW_PENDING');
await call(`/plan-versions/${pvId}/review`, { method: 'POST', body: { decision: 'APPROVE', comment: 'e2e 通过', version: v.version } });
v = (await call('/plan-versions/' + pvId));
assert(v.status === 'REVIEWED', 'review APPROVE 后状态 REVIEWED');
await call(`/plan-versions/${pvId}/publish`, { method: 'POST', body: { version: v.version } });
v = (await call('/plan-versions/' + pvId));
assert(['PUBLISHED', 'EXECUTING'].includes(v.status), `publish 后状态 ${v.status}`);

dash = await call('/dashboard');
assert(dash.currentPlan && dash.currentPlan.id === pvId, 'dashboard.currentPlan 指向已发布版本');
hasFields(dash.currentPlan, ['id', 'versionCode', 'status', 'publishedAt', 'kpi'], 'dashboard.currentPlan');

// 8. 执行反馈（actualStartAt 取计划开始+5min，落在该工序计划窗口内）
console.log('== 执行反馈 ==');
const op0 = pvOps[0];
const actualStartAt = new Date(new Date(op0.startAt).getTime() + 5 * 60000).toISOString();
const fb = await call(`/operations/${encodeURIComponent(op0.operationId)}/execution`, {
  method: 'POST', body: { status: 'RUNNING', actualStartAt },
});
hasFields(fb, ['executionRecordId', 'operationId', 'status', 'planVersionId'], 'execution feedback');

// 9. 故障事件 -> 影响集合
console.log('== 故障事件 ==');
const bd = await call('/events/breakdowns', {
  method: 'POST',
  body: { machineId: 'M-03', occurredAt: relIso(24 * 60), repairDurationMinutes: 120, source: 'e2e', note: 'e2e 故障' },
});
hasFields(bd, ['eventId', 'eventCode', 'machineId', 'occurredAt', 'repairEndAt', 'impactSummary'], 'breakdown resp');
hasFields(bd.impactSummary, ['total', 'byType'], 'breakdown impactSummary');
const ev = await call('/events/' + bd.eventId);
hasFields(ev, ['eventId', 'eventCode', 'eventType', 'machineId', 'occurredAt', 'repairEndAt', 'status', 'impacts'], 'event detail');
const evPage = await call('/events?eventType=BREAKDOWN&page=0&size=10');
hasFields(evPage, ['items', 'page', 'size', 'total', 'totalPages'], 'events 分页包络');
assert(evPage.items.some(e => e.eventId === bd.eventId), 'events 过滤 BREAKDOWN 含新事件');
if (ev.impacts.length) hasFields(ev.impacts[0], ['operationId', 'impactType', 'impactReason', 'lockType', 'reasonCode'], 'event.impacts[0]');

// 10. 局部重调度 -> 轮询 -> diff
console.log('== 重调度 + diff ==');
const rs = await call('/schedule-tasks', {
  method: 'POST',
  body: { mode: 'LOCAL_RESCHEDULE', oldPlanVersionId: pvId, eventId: bd.eventId },
});
const rsTask = await waitTask(rs.taskId, '重调度任务');
assert(rsTask.status === 'SUCCESS', `重调度任务成功（实际 ${rsTask.status}）`);
hasFields(rsTask, ['oldPlanVersionId', 'eventId', 'planVersionId'], 'reschedule task detail');
const newPv = rsTask.planVersionId;
const diff = await call(`/plan-versions/${newPv}/diff?baselineVersionId=${pvId}`);
hasFields(diff, ['baselineVersionId', 'baselineVersionCode', 'candidateVersionId', 'candidateVersionCode', 'summary', 'kpiDiff', 'operations'], 'diff');
hasFields(diff.summary, ['comparedOperations', 'addedOperations', 'removedOperations', 'timeShiftedCount', 'machineChangedCount', 'sequenceChangedCount'], 'diff.summary');
hasFields(diff.operations[0], ['operationId', 'timeShiftMinutes', 'machineChanged', 'sequenceChanged',
  'oldMachineId', 'newMachineId', 'oldStartAt', 'newStartAt', 'frozen', 'reasonCode', 'impactType'], 'diff.operations[0]');

// 11. 插单事件
console.log('== 插单事件 ==');
const io = await call('/events/new-orders', {
  method: 'POST',
  body: {
    subType: 'URGENT_INSERT', orderCode: 'ORD-E2E-001', productFamily: '壳体C', quantity: 10,
    arrivalAt: relIso(24 * 60), dueAt: relIso(60 * 60), priority: 1,
    occurredAt: relIso(25 * 60), note: 'e2e 插单',
  },
});
hasFields(io, ['eventId', 'eventCode', 'orderId', 'orderCode', 'operationIds', 'impactSummary'], 'new-order resp');

console.log(failures ? `\n${failures} 项校验失败` : '\n全部校验通过');
process.exit(failures ? 1 : 0);

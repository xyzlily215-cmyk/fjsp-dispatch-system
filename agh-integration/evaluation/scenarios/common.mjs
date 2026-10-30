// common.mjs — Golden 评估集场景脚本公共助手
// 用法约定与 scripts/e2e-api-check.mjs、scripts/simulate-execution.mjs 一致：
// - base URL / 凭据走环境变量（FJSP_API_BASE / FJSP_AUTH_USER / FJSP_AUTH_PASSWORD），
//   默认值与 scripts/demo-common.sh 相同，不硬编码口令之外的任何环境差异；
// - 非 GET 请求自动携带 Idempotency-Key（业务侧强制，IdempotencyService.requireKey）；
// - 场景脚本结束打印一行 `SCENARIO_RESULT {json}`（场景名、触发了什么、关键业务对象 ID），
//   供任务 0.3 的采集器解析；断言失败时进程退出码非 0。

export const GOLDEN_SEED = 20260916; // 与 seed/demo_instance.json 的 algorithm.randomSeed 一致
export const GOLDEN_ALGORITHM = { populationSize: 40, maxGenerations: 60, timeLimitSeconds: 30, randomSeed: GOLDEN_SEED };
export const GOLDEN_WEIGHTS = { makespan: 0.4, weightedTardiness: 0.4, loadImbalance: 0.2 };

const DEFAULTS = {
  base: process.env.FJSP_API_BASE || process.env.FJSP_API || 'http://localhost:8081/api/v1',
  user: process.env.FJSP_AUTH_USER || 'admin',
  password: process.env.FJSP_AUTH_PASSWORD || 'Fj@123456',
  reset: true,
};

export function parseArgs(argv, usage) {
  const opts = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--base': opts.base = next(); break;
      case '--user': opts.user = next(); break;
      case '--password': opts.password = next(); break;
      case '--no-reset': opts.reset = false; break;
      case '-h': case '--help':
        console.log(usage);
        process.exit(0);
        break;
      default:
        console.error(`未知参数: ${a}（--help 查看用法）`);
        process.exit(2);
    }
  }
  opts.base = opts.base.replace(/\/+$/, '');
  return opts;
}

// ---- 断言计数：脚本末尾用 exitCode() 收尾 ----
let failures = 0;
export function assert(cond, msg) {
  if (cond) { console.log('PASS ' + msg); }
  else { failures++; console.log('FAIL ' + msg); }
}
export function exitCode() { return failures ? 1 : 0; }

let TOKEN = null;

// 统一调用：校验响应包络 {requestId,code,message,data}；expectError=true 时返回错误响应而不抛异常
export async function api(opts, path, { method = 'GET', body, idem, expectError = false } = {}) {
  const headers = {};
  if (TOKEN) headers['Authorization'] = 'Bearer ' + TOKEN;
  if (body) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers['Idempotency-Key'] = idem || crypto.randomUUID();
  let resp;
  try {
    resp = await fetch(opts.base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    throw new Error(`无法连接业务服务 ${opts.base}（${e.cause?.code || e.message}）——请确认服务已启动，或用 --base 指定地址`);
  }
  const json = await resp.json().catch(() => null);
  if (expectError) return { status: resp.status, code: json?.code, message: json?.message, data: json?.data };
  if (!resp.ok || !json || json.code !== 'OK') {
    throw new Error(`${method} ${path} -> HTTP ${resp.status} ${json?.code || ''}: ${json?.message || resp.statusText}`);
  }
  return json.data;
}

export async function login(opts) {
  const resp = await fetch(opts.base + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: opts.user, password: opts.password }),
  });
  const json = await resp.json().catch(() => null);
  if (!resp.ok || !json?.data?.token) {
    throw new Error(`登录业务服务失败: ${opts.base}（HTTP ${resp.status} ${json?.code || ''}）`);
  }
  TOKEN = json.data.token;
  console.log(`== 登录 ${opts.base}（user=${opts.user}）==`);
}

// ---- 快照复位：POST /demo/reset 并校验演示规模（20 订单 / 8 设备 / 3 产品族模板 / 76 工序）----
// 返回 seed 摘要（含 simulationStartAt，作为场景时间锚点）。
export async function resetSnapshot(opts) {
  console.log('== 复位快照（/demo/reset）==');
  const data = await api(opts, '/demo/reset', { method: 'POST', body: {}, idem: 'golden-reset-' + Date.now() });
  assert(data && data.reset === true, 'demo/reset 返回 reset=true');
  const seed = data.seed || {};
  assert(seed.machines === 8, `seed 设备数=8（实际 ${seed.machines}）`);
  assert(seed.processTemplates === 3, `seed 工艺模板数=3（实际 ${seed.processTemplates}）`);
  assert(seed.orders === 20, `seed 订单数=20（实际 ${seed.orders}）`);
  assert(seed.operations === 76, `seed 工序数=76（实际 ${seed.operations}）`);
  assert(typeof seed.simulationStartAt === 'string', `seed 含 simulationStartAt（${seed.simulationStartAt}）`);
  console.log(`[快照] simulationStartAt=${seed.simulationStartAt}`);
  return seed;
}

// 相对仿真起点的 ISO 时间（分钟偏移）
export const relMin = (simStartIso, minutes) =>
  new Date(new Date(simStartIso).getTime() + minutes * 60000).toISOString();

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function waitTask(opts, taskId, label) {
  for (let i = 0; i < 90; i++) {
    const t = await api(opts, '/schedule-tasks/' + taskId);
    if (!['PENDING', 'RUNNING', 'RETRY_WAIT'].includes(t.status)) return t;
    await sleep(1000);
  }
  throw new Error(label + ' 轮询超时');
}

// ---- 确定性前置：建基线 → 提审 → 审批通过 → 发布（纯 API，无 agent 推理）----
// 返回 { taskId, planVersionId, versionCode, randomSeed }。
export async function buildAndPublishBaseline(opts) {
  console.log('== 前置：基线排程 + 审批发布 ==');
  const orders = await api(opts, '/orders');
  const created = await api(opts, '/schedule-tasks', {
    method: 'POST',
    body: {
      mode: 'BASELINE',
      orderIds: orders.map(o => o.orderId),
      objectiveWeights: GOLDEN_WEIGHTS,
      algorithm: GOLDEN_ALGORITHM,
    },
  });
  const task = await waitTask(opts, created.taskId, '基线任务');
  // GA 触达 timeLimitSeconds 时终态为 TIME_LIMIT + FEASIBLE（solver.py:120），基线仍可用，不算失败
  assert(['SUCCESS', 'TIME_LIMIT'].includes(task.status) && task.resultStatus === 'FEASIBLE',
    `基线任务 SUCCESS/TIME_LIMIT+FEASIBLE（实际 status=${task.status} resultStatus=${task.resultStatus}）`);
  assert(task.randomSeed === GOLDEN_SEED, `任务 randomSeed=${GOLDEN_SEED}（实际 ${task.randomSeed}）`);
  const pvId = task.planVersionId;
  assert(typeof pvId === 'string' && pvId.length > 0, '基线任务产出 planVersionId');

  let pv = await api(opts, '/plan-versions/' + pvId);
  await api(opts, `/plan-versions/${pvId}/submit-review`, { method: 'POST', body: { version: pv.version } });
  pv = await api(opts, '/plan-versions/' + pvId);
  assert(pv.status === 'REVIEW_PENDING', `submit-review 后 REVIEW_PENDING（实际 ${pv.status}）`);
  await api(opts, `/plan-versions/${pvId}/review`, {
    method: 'POST', body: { decision: 'APPROVE', comment: 'golden 评估前置自动通过', version: pv.version },
  });
  pv = await api(opts, '/plan-versions/' + pvId);
  assert(pv.status === 'REVIEWED', `review APPROVE 后 REVIEWED（实际 ${pv.status}）`);
  await api(opts, `/plan-versions/${pvId}/publish`, { method: 'POST', body: { version: pv.version } });
  pv = await api(opts, '/plan-versions/' + pvId);
  assert(['PUBLISHED', 'EXECUTING'].includes(pv.status), `publish 后 ${pv.status}`);
  console.log(`[基线] planVersionId=${pvId} versionCode=${pv.versionCode} status=${pv.status}`);
  return { taskId: task.taskId ?? created.taskId, planVersionId: pvId, versionCode: pv.versionCode, randomSeed: task.randomSeed };
}

// ---- 场景结果输出：单行结构化 JSON，供 0.3 采集 ----
export function emitResult(obj) {
  console.log('SCENARIO_RESULT ' + JSON.stringify(obj));
}

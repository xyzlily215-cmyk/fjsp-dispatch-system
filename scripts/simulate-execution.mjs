// simulate-execution.mjs — 执行状态自动模拟器：按已发布计划的工序顺序自动上报 RUNNING→COMPLETED，
// 让车间加工状态随时间自动推进，支撑"某工件在哪台设备、还剩几道工序"的实时查询演示。
// 用法: node scripts/simulate-execution.mjs [--speed 60] [--base http://localhost:8081/api/v1]
//        [--user admin] [--password Fj@123456] [--max-ops 20] [--dry-run]
//   --speed    加速倍率：1 秒真实时间 = speed 秒计划时间（默认 60）
//   --max-ops  只模拟按计划开始时间升序的前 n 道工序
//   --dry-run  只打印将执行的动作，不上报
// 说明：上报 actualStartAt/actualEndAt 取计划窗口值，避免触发 EXECUTION_DEVIATION 偏差标记；
// 已 COMPLETED 的工序跳过，RUNNING 的补 COMPLETED，PAUSED 的先 RESUMED 再 COMPLETED（幂等可重跑）。
const DEFAULTS = { speed: 60, base: 'http://localhost:8081/api/v1', user: 'admin', password: 'Fj@123456', maxOps: Infinity, dryRun: false };
const WAIT_CAP_SECONDS = 30; // 单工序真实等待上限，避免长工序拖慢演示

function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--speed': opts.speed = Number(next()); break;
      case '--base': opts.base = next(); break;
      case '--user': opts.user = next(); break;
      case '--password': opts.password = next(); break;
      case '--max-ops': opts.maxOps = Number(next()); break;
      case '--dry-run': opts.dryRun = true; break;
      case '-h': case '--help':
        console.log('用法: node scripts/simulate-execution.mjs [--speed 60] [--base URL] [--user U] [--password P] [--max-ops N] [--dry-run]');
        process.exit(0);
      default:
        console.error(`未知参数: ${a}（--help 查看用法）`);
        process.exit(2);
    }
  }
  if (!(opts.speed > 0)) { console.error('--speed 必须是正数'); process.exit(2); }
  if (!(opts.maxOps > 0)) { console.error('--max-ops 必须是正整数'); process.exit(2); }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const API = opts.base.replace(/\/+$/, '');
let TOKEN = null;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function call(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (TOKEN) headers['Authorization'] = 'Bearer ' + TOKEN;
  if (body) headers['Content-Type'] = 'application/json';
  let resp;
  try {
    resp = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    throw new Error(`无法连接业务服务 ${API}（${e.cause?.code || e.message}）——请确认服务已启动，或用 --base 指定地址`);
  }
  let json = null;
  try { json = await resp.json(); } catch { /* 非 JSON 响应 */ }
  if (!resp.ok || (json && json.code !== 'OK')) {
    const msg = json?.message || resp.statusText;
    const err = new Error(`${method} ${path} -> HTTP ${resp.status} ${json?.code || ''}: ${msg}`);
    err.status = resp.status;
    throw err;
  }
  return json.data;
}

// ---- 中断友好：Ctrl+C 时报告进度再退出 ----
let progress = { done: 0, total: 0 };
process.on('SIGINT', () => {
  console.log(`\n[中断] 收到 SIGINT，已推进 ${progress.done}/${progress.total} 道工序，退出`);
  process.exit(130);
});

// 1. 登录
console.log(`== 登录 ${API}（user=${opts.user}）==`);
try {
  const auth = await call('/auth/login', { method: 'POST', body: { username: opts.user, password: opts.password } });
  TOKEN = auth.token;
} catch (e) {
  console.error(`[失败] 登录失败：${e.message}`);
  process.exit(1);
}

// 2. 当前发布计划
const dash = await call('/dashboard');
const plan = dash.currentPlan;
if (!plan || !plan.id) {
  console.error('[失败] 当前没有已发布计划（dashboard.currentPlan 为空）——请先在系统中完成排程、审核并发布一个计划版本');
  process.exit(1);
}
console.log(`[计划] ${plan.versionCode}（${plan.id}，status=${plan.status}）`);

// 3. 计划工序 + 当前执行状态（幂等依据）
const opsPage = await call(`/plan-versions/${encodeURIComponent(plan.id)}/operations?size=5000`);
let ops = opsPage.items
  .slice()
  .sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
const orders = await call('/orders');
const liveStatus = new Map();
for (const o of orders) for (const op of (o.operations || [])) liveStatus.set(op.operationId, op.status);

if (opts.maxOps < ops.length) ops = ops.slice(0, opts.maxOps);
progress.total = ops.length;
console.log(`[工序] 共 ${opsPage.total} 道，本次模拟 ${ops.length} 道，speed=${opts.speed}x${opts.dryRun ? '（dry-run，不上报）' : ''}`);

// 4. 逐工序推进：RUNNING → 等计划时长/speed（封顶）→ COMPLETED
let skipped = 0, failed = 0;
for (let i = 0; i < ops.length; i++) {
  const op = ops[i];
  const label = `[${i + 1}/${ops.length}] ${op.orderCode}-${op.sequenceNo} @ ${op.machineId}`;
  const plannedMs = new Date(op.endAt) - new Date(op.startAt);
  const waitMs = Math.min(plannedMs / opts.speed, WAIT_CAP_SECONDS * 1000);
  const cur = liveStatus.get(op.operationId) || op.operationStatus || 'NOT_STARTED';
  try {
    if (cur === 'COMPLETED') {
      skipped++; progress.done++;
      console.log(`${label} 已 COMPLETED，跳过`);
      continue;
    }
    if (opts.dryRun) {
      const action = cur === 'RUNNING' ? 'COMPLETED'
        : cur === 'PAUSED' ? 'RESUMED→COMPLETED'
        : `RUNNING→(等 ${(waitMs / 1000).toFixed(1)}s)→COMPLETED`;
      progress.done++;
      console.log(`${label} [dry-run] ${action}`);
      continue;
    }
    if (cur === 'PAUSED') {
      await call(`/operations/${encodeURIComponent(op.operationId)}/execution`, { method: 'POST', body: { status: 'RESUMED' } });
    }
    if (cur !== 'RUNNING' && cur !== 'PAUSED') {
      await call(`/operations/${encodeURIComponent(op.operationId)}/execution`, {
        method: 'POST', body: { status: 'RUNNING', actualStartAt: op.startAt, remark: 'simulate-execution 自动上报' },
      });
      await sleep(waitMs);
    }
    await call(`/operations/${encodeURIComponent(op.operationId)}/execution`, {
      method: 'POST', body: { status: 'COMPLETED', actualEndAt: op.endAt },
    });
    progress.done++;
    console.log(`${label} ${cur}→RUNNING→COMPLETED`);
  } catch (e) {
    failed++; progress.done++;
    console.log(`${label} [错误] ${e.message}，跳过继续`);
  }
}

console.log(`\n[完成] 推进 ${progress.done - skipped - failed} 道，跳过 ${skipped} 道（已完工），失败 ${failed} 道`);
process.exit(failed && failed === progress.done - skipped ? 1 : 0);

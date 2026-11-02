// workflow/e2e-regression.mts — P2 恢复回归 + 评估集复测驱动（任务 3.5）。
//
// 半真实端到端：真实 business-service（回归环境，FJSP_SIMULATION_MODE=FIXED）+ 真实
// agent-bff 审批链路（本进程内起独立端口实例，真实 JWT 内检）+ 真实 fjsp-tools HTTP 调用；
// agent 决策节点不注入（落 DEFAULT_STRATEGY 确定性兜底，不接真实 LLM，属披露降级）。
//
// 子命令（每个为一个故障模式/评估场景，均先复位快照 + 发布基线，互不依赖）：
//   s01      设备故障全流程：跑到 WAITING_APPROVAL → BFF 真实批准 → COMPLETED
//   s05      重复告警：业务三层（同键回放/换键 409）+ 工作流触发去重（同 dedupeKey 返回已有 wfId）
//   s06      审批拒绝：真实 BFF 拒绝 → 流程 TERMINATED，候选停留 REVIEW_PENDING，无发布副作用
//   s03      混合扰动口径：两条独立单事件流程先后跑完，验证不产生 E_PLAN_STALE 候选链
//   restart  崩溃恢复：子进程跑到 poll-task intent 被 kill -9 → recover() → 复用原幂等键续跑
//            → 挂起后再次 recover() 核对 BFF pending 审批 → 批准 → COMPLETED，全程无重复写
//   timeout  轮询超时：fjsp_task_status 脚本化恒返 RUNNING 快照 → 达 maxAttempts → FAILED 转人工
//   stale    乐观锁冲突：submit-review 前注入过期 version → E_VERSION_STALE → 重读重试成功
//   child-run  内部子命令（restart 的被杀子进程），请勿直接调用
//
// 环境变量：FJSP_API_BASE（默认 http://localhost:${FJSP_REG_BUSINESS_PORT||18081}/api/v1）、
//   FJSP_AUTH_USER/FJSP_AUTH_PASSWORD、AGENT_BFF_PORT（默认 14184）、
//   E2E_WORK_DIR（检查点/BFF 临时文件，默认 $TMPDIR/fjsp-regression/workflow-e2e）、
//   EVIDENCE_DIR（给定时把指标 JSON、日志与终态检查点拷贝进去）。
// 退出码：全部断言 PASS 为 0，任一 FAIL 为 1。
import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// ---- env bootstrap：必须先于任何 workflow / fjsp-tools / server.mts 的动态 import ----
const REG_PORT = process.env.FJSP_REG_BUSINESS_PORT || '18081'
process.env.FJSP_API_BASE = (process.env.FJSP_API_BASE || `http://localhost:${REG_PORT}/api/v1`).replace(/\/+$/, '')
process.env.FJSP_AUTH_USER = process.env.FJSP_AUTH_USER || 'admin'
process.env.FJSP_AUTH_PASSWORD = process.env.FJSP_AUTH_PASSWORD || 'Fj@123456'
const BFF_PORT = Number(process.env.AGENT_BFF_PORT || 14184)
const BFF = `http://127.0.0.1:${BFF_PORT}/agent-api`
process.env.FJSP_RAG_URL = `${BFF}/rag/experience-query`
const WORK = process.env.E2E_WORK_DIR || join(process.env.TMPDIR || '/tmp', 'fjsp-regression', 'workflow-e2e')
const EVIDENCE = process.env.EVIDENCE_DIR || ''
const MODE = process.argv[2] || ''
// child-run 的工作目录由父进程经 E2E_MODE_DIR 指定（共享同一检查点目录）；
// 其余子命令每次运行重置本模式工作目录（检查点去重键跨运行复用会导致陈旧检查点干扰）
const MODE_DIR = process.env.E2E_MODE_DIR || join(WORK, MODE || 'misc')
if (MODE && MODE !== 'child-run' && !process.env.E2E_MODE_DIR) rmSync(MODE_DIR, { recursive: true, force: true })
mkdirSync(MODE_DIR, { recursive: true })
// 审批/BFF/经验库/检查点全部隔离到本次运行工作目录，绝不写 ~/.agh 或演示侧文件
process.env.FJSP_WORKFLOW_DIR = join(MODE_DIR, 'checkpoints')
process.env.FJSP_EXPERIENCE_FILE = join(MODE_DIR, 'experience.jsonl')
process.env.AGENT_BFF_PORT = String(BFF_PORT)
process.env.AGENT_BFF_HOST = '127.0.0.1'
process.env.AGENT_BFF_STORE_FILE = join(MODE_DIR, 'bff-store.json')
process.env.AGENT_BFF_SESSION_ID_FILE = join(MODE_DIR, 'bff-session-id')
process.env.AGENT_BFF_AUDIT_FILE = join(MODE_DIR, 'bff-audit.jsonl')
process.env.AGENT_BFF_APPROVALS_FILE = join(MODE_DIR, 'bff-approvals.json')
process.env.AGH_OWNER_FILE = join(MODE_DIR, 'no-owner.json') // 不存在 → daemon absent

const BASE = process.env.FJSP_API_BASE
const CONV_ID = `wf-e2e-${MODE || 'misc'}`

// ---- 断言计数 ----
let failures = 0
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`PASS ${msg}`)
  else { failures++; console.log(`FAIL ${msg}`) }
}
const logLines: string[] = []
const flog = (m: string) => { logLines.push(m); console.log(`[flow] ${m}`) }

// ---- 业务 API（独立于 evaluation/common.mjs，避免其 parseArgs 副作用）----
let TOKEN = ''
async function bizLogin() {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.FJSP_AUTH_USER, password: process.env.FJSP_AUTH_PASSWORD }),
  })
  const json = (await res.json()) as { data?: { token?: string } }
  if (!res.ok || !json.data?.token) throw new Error(`登录失败 HTTP ${res.status}`)
  TOKEN = json.data.token
  console.log(`== 登录 ${BASE}（user=${process.env.FJSP_AUTH_USER}）==`)
}
async function biz(path: string, opts: { method?: string; body?: unknown; idem?: string; expectError?: boolean } = {}) {
  const method = opts.method || 'GET'
  const headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` }
  if (opts.body) headers['Content-Type'] = 'application/json'
  if (method !== 'GET') headers['Idempotency-Key'] = opts.idem || crypto.randomUUID()
  const res = await fetch(`${BASE}${path}`, { method, headers, body: opts.body ? JSON.stringify(opts.body) : undefined })
  const json = (await res.json().catch(() => null)) as { code?: string; data?: any } | null
  if (opts.expectError) return { status: res.status, code: json?.code, data: json?.data }
  if (!res.ok || !json || json.code !== 'OK') throw new Error(`${method} ${path} -> HTTP ${res.status} ${json?.code || ''}`)
  return json.data
}

// ---- 快照复位 + 确定性基线发布（与 evaluation/scenarios/common.mjs 同参数）----
const GOLDEN_WEIGHTS = { makespan: 0.4, weightedTardiness: 0.4, loadImbalance: 0.2 }
const GOLDEN_ALGORITHM = { populationSize: 40, maxGenerations: 60, timeLimitSeconds: 30, randomSeed: 20260916 }
const relMin = (simStartIso: string, minutes: number) => new Date(new Date(simStartIso).getTime() + minutes * 60000).toISOString()

async function resetAndBaseline() {
  const reset = await biz('/demo/reset', { method: 'POST', body: {}, idem: `wf-e2e-reset-${Date.now()}` })
  const seed = reset.seed || {}
  assert(seed.machines === 8 && seed.orders === 20 && seed.operations === 76, `快照复位规模 8 设备/20 订单/76 工序（实际 ${seed.machines}/${seed.orders}/${seed.operations}）`)
  const simStart = seed.simulationStartAt as string
  const orders = await biz('/orders')
  const created = await biz('/schedule-tasks', {
    method: 'POST',
    body: { mode: 'BASELINE', orderIds: orders.map((o: any) => o.orderId), objectiveWeights: GOLDEN_WEIGHTS, algorithm: GOLDEN_ALGORITHM },
  })
  let task: any
  for (let i = 0; i < 90; i++) {
    task = await biz(`/schedule-tasks/${created.taskId}`)
    if (!['PENDING', 'RUNNING', 'RETRY_WAIT'].includes(task.status)) break
    await new Promise((r) => setTimeout(r, 1000))
  }
  assert(['SUCCESS', 'TIME_LIMIT'].includes(task.status) && task.resultStatus === 'FEASIBLE',
    `基线任务终态可行（实际 ${task.status}/${task.resultStatus}）`)
  const pvId = task.planVersionId as string
  let pv = await biz(`/plan-versions/${pvId}`)
  await biz(`/plan-versions/${pvId}/submit-review`, { method: 'POST', body: { version: pv.version } })
  pv = await biz(`/plan-versions/${pvId}`)
  await biz(`/plan-versions/${pvId}/review`, { method: 'POST', body: { decision: 'APPROVE', comment: 'wf-e2e 前置自动通过', version: pv.version } })
  pv = await biz(`/plan-versions/${pvId}`)
  await biz(`/plan-versions/${pvId}/publish`, { method: 'POST', body: { version: pv.version } })
  pv = await biz(`/plan-versions/${pvId}`)
  assert(['PUBLISHED', 'EXECUTING'].includes(pv.status), `基线已发布（实际 ${pv.status}）`)
  console.log(`[基线] planVersionId=${pvId} ${pv.versionCode}`)
  return { simStart, baselinePvId: pvId }
}

// ---- BFF（本进程内真实实例，指向回归 business）----
async function bootBff() {
  await import('../agent-bff/server.mts')
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BFF}/health`)
      if (res.ok) { console.log(`== BFF 已起 ${BFF} ==`); return }
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('BFF 启动超时')
}
async function bffDecide(requestId: string, verdict: 'allowed-once' | 'rejected') {
  const res = await fetch(`${BFF}/permission`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: CONV_ID, requestId, verdict }),
  })
  const json = (await res.json().catch(() => null)) as any
  return { status: res.status, json }
}

// ---- 真实工具面（fjsp-tools 同一份实现，AGH 插件/MCP 共用）----
type Structured = { ok: boolean; error?: { code: string; message?: string }; [k: string]: any }
async function makeTools(wraps: Record<string, (out: Structured, args: any) => Structured | Promise<Structured>> = {}) {
  const { tools } = await import('../fjsp-tools/index.mjs')
  const map = new Map((tools as any[]).map((t) => [t.name, t]))
  const counts: Record<string, number> = {}
  return {
    counts,
    async call(name: string, args: Record<string, unknown> = {}): Promise<Structured> {
      const tool = map.get(name) as any
      if (!tool) throw new Error(`fjsp-tools 中不存在工具 ${name}`)
      counts[name] = (counts[name] || 0) + 1
      let out = (await tool.execute(args)).structured as Structured
      if (wraps[name]) out = await wraps[name](out, args)
      return out
    },
  }
}

async function flowDeps() {
  const { CheckpointStore } = await import('./checkpoint.mts')
  const { buildDisturbanceFlow } = await import('./disturbance-flow.mts')
  const { runWorkflow } = await import('./runner.mts')
  const { createBffApprovalChannel, settleApprovalOutcome, makeApprovalChecker } = await import('./bff-approval.mts')
  const { recover } = await import('./recovery.mts')
  const store = new CheckpointStore(process.env.FJSP_WORKFLOW_DIR)
  const bffOpts = { baseUrl: BFF, token: TOKEN, conversationId: CONV_ID }
  return { store, buildDisturbanceFlow, runWorkflow, settleApprovalOutcome, recover, makeApprovalChecker, approvalChannel: createBffApprovalChannel(bffOpts), bffOpts }
}

// 触发一次扰动流程（不注入 agent → DEFAULT_STRATEGY 兜底），返回终态检查点
async function triggerFlow(d: Awaited<ReturnType<typeof flowDeps>>, tools: any, dedupeKey: string, detail: Record<string, unknown>, maxPollAttempts = 8) {
  const created = d.store.create({ type: 'DISTURBANCE', trigger: { source: 'wf-e2e', dedupeKey, detail } })
  const nodes = d.buildDisturbanceFlow().map((n: any) => (n.name === 'poll-task' ? { ...n, maxAttempts: maxPollAttempts } : n))
  const cp = await d.runWorkflow(created.checkpoint.workflowId, nodes, { store: d.store, tools, approvalChannel: d.approvalChannel, log: flog })
  return { cp, nodes, deduplicated: created.deduplicated }
}

async function approveAndSettle(d: Awaited<ReturnType<typeof flowDeps>>, wfId: string, nodes: any[], tools: any, verdict: 'approved' | 'rejected') {
  const cp = d.store.load(wfId)!
  const reqId = cp.pendingApproval!.requestId
  const dec = await bffDecide(reqId, verdict === 'approved' ? 'allowed-once' : 'rejected')
  assert(dec.status === 202, `BFF 裁决 ${verdict} 受理（HTTP ${dec.status}）`)
  const { pollApprovalDecision } = await import('./bff-approval.mts')
  const outcome = await pollApprovalDecision(d.bffOpts, cp.pendingApproval!, { pollMs: 300 })
  assert(outcome === verdict, `轮询审批结果=${verdict}（实际 ${outcome}）`)
  return d.settleApprovalOutcome(d.store, wfId, nodes, { store: d.store, tools, approvalChannel: d.approvalChannel, log: flog }, outcome)
}

function metricsAndEvidence(mode: string, data: Record<string, unknown>) {
  const rec = { mode, finishedAt: new Date().toISOString(), tokens: 'N/A（未接真实 LLM）', ...data }
  if (EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true })
    writeFileSync(join(EVIDENCE, `${mode}.json`), JSON.stringify(rec, null, 2))
    writeFileSync(join(EVIDENCE, `${mode}.log`), logLines.join('\n') + '\n')
    for (const f of readdirSync(process.env.FJSP_WORKFLOW_DIR!)) {
      if (f.endsWith('.json')) copyFileSync(join(process.env.FJSP_WORKFLOW_DIR!, f), join(EVIDENCE, `${mode}-checkpoint-${f}`))
    }
  }
  console.log(`WF_E2E_RESULT ${JSON.stringify(rec)}`)
}

const bdEvent = (simStart: string, machineId = 'M-03', atMin = 24 * 60, repair = 120) => ({
  eventType: 'BREAKDOWN' as const, machineId, occurredAt: relMin(simStart, atMin), repairDurationMinutes: repair, note: 'wf-e2e 回归触发',
})
const taskTotal = async () => (await biz('/schedule-tasks?page=0&size=100')).total as number
const bdEventTotal = async () => (await biz('/events?eventType=BREAKDOWN&page=0&size=1')).total as number
const planAudit = async (pvId: string) => ((await biz(`/audit-logs?objectType=plan_version&objectId=${encodeURIComponent(pvId)}&size=100`)).items || []).map((i: any) => i.action)

// ================= s01：设备故障全流程（happy path + 真实 BFF 批准） =================
async function modeS01() {
  const { simStart } = await resetAndBaseline()
  await bootBff()
  const d = await flowDeps()
  const tools = await makeTools()
  const t0 = Date.now()
  const detail = bdEvent(simStart)
  const { cp, nodes } = await triggerFlow(d, tools, `BREAKDOWN:${detail.machineId}:${detail.occurredAt}`, detail)
  assert(cp.status === 'WAITING_APPROVAL', `流程挂起待审批（实际 ${cp.status}）`)
  assert(!!cp.pendingApproval?.requestId, `审批已登记 BFF requestId=${cp.pendingApproval?.requestId}`)
  const pvId = cp.refs.planVersionId!
  const ev = await biz(`/events/${cp.refs.eventId}`)
  assert(['CONFIRMED', 'USED_FOR_SOLVE'].includes(ev.status) && Array.isArray(ev.impacts) && ev.impacts.length > 0,
    `事件已确认且影响集合已计算（status=${ev.status}，impacts=${ev.impacts?.length} 条；CONFIRMED 被重调度消费后转 USED_FOR_SOLVE）`)
  let pv = await biz(`/plan-versions/${pvId}`)
  assert(pv.status === 'REVIEW_PENDING', `候选版本已提交评审（实际 ${pv.status}）`)
  const after = await approveAndSettle(d, cp.workflowId, nodes, tools, 'approved')
  assert(after.status === 'COMPLETED', `审批批准后流程 COMPLETED（实际 ${after.status}）`)
  pv = await biz(`/plan-versions/${pvId}`)
  assert(pv.status === 'REVIEW_PENDING', `工作流批准不代替业务评审：候选停留 REVIEW_PENDING 待人工在业务侧评审（实际 ${pv.status}）`)
  const kpi = (after.completedSteps.find((s: any) => s.node === 'poll-task')?.result as any)?.kpi ?? null
  metricsAndEvidence('s01', {
    scenario: 's01-machine-breakdown', workflowId: cp.workflowId, terminal: after.status,
    steps: after.completedSteps.length, approvalPoints: 1, wallMs: Date.now() - t0,
    eventId: cp.refs.eventId, taskId: cp.refs.taskId, planVersionId: pvId, candidateKpi: kpi,
  })
}

// ================= s05：重复告警 =================
async function modeS05() {
  const { simStart } = await resetAndBaseline()
  await bootBff()
  // a) 业务侧三层（与 golden s05 同体）：同键回放 / 换键 409 / 总数净增
  const before = await bdEventTotal()
  const body = { machineId: 'M-05', occurredAt: relMin(simStart, 26 * 60), repairDurationMinutes: 90, source: 'wf-e2e', note: 'wf-e2e s05 重复告警' }
  const r1 = await biz('/events/breakdowns', { method: 'POST', idem: 'wf-e2e-s05-dup-key', body })
  const r2 = await biz('/events/breakdowns', { method: 'POST', idem: 'wf-e2e-s05-dup-key', body })
  assert(r2.eventId === r1.eventId, `同键同体第 2 次投递回放首次 eventId=${r2.eventId}`)
  const r3 = await biz('/events/breakdowns', { method: 'POST', idem: 'wf-e2e-s05-dup-key-2', body, expectError: true })
  assert(r3.status === 409 && r3.code === 'E_DUPLICATE', `换键同体第 3 次被拒 HTTP ${r3.status} ${r3.code}`)
  // b) 工作流侧：同一事件指纹触发两次 → 第二次返回已有 workflowId，不产生第二次写入
  const d = await flowDeps()
  const tools = await makeTools()
  const t0 = Date.now()
  const detail = bdEvent(simStart, 'M-05', 30 * 60, 60)
  const fp = `BREAKDOWN:${detail.machineId}:${detail.occurredAt}`
  const first = await triggerFlow(d, tools, fp, detail)
  assert(first.cp.status === 'WAITING_APPROVAL', `首次触发的流程跑到挂起（实际 ${first.cp.status}）`)
  const settled = await approveAndSettle(d, first.cp.workflowId, first.nodes, tools, 'approved')
  assert(settled.status === 'COMPLETED', `首次流程 COMPLETED（实际 ${settled.status}）`)
  const second = await triggerFlow(d, tools, fp, detail)
  assert(second.deduplicated === true && second.cp.workflowId === first.cp.workflowId,
    `重复触发返回已有 workflowId=${second.cp.workflowId}（deduplicated=${second.deduplicated}）`)
  assert(second.cp.status === 'COMPLETED', `重复触发不推进（状态仍 ${second.cp.status}）`)
  const afterTotal = await bdEventTotal()
  assert(afterTotal - before === 2, `BREAKDOWN 事件净增恰为 2（业务侧 1 + 工作流 1；实际 ${before} -> ${afterTotal}）`)
  assert((tools.counts['fjsp_report_breakdown'] || 0) === 1, `工作流侧事件登记写恰好 1 次（实际 ${tools.counts['fjsp_report_breakdown']}）`)
  assert((tools.counts['fjsp_reschedule'] || 0) === 1, `重调度写恰好 1 次，重复告警未重复发起（实际 ${tools.counts['fjsp_reschedule']}）`)
  metricsAndEvidence('s05', {
    scenario: 's05-duplicate-alert', workflowId: first.cp.workflowId, terminal: settled.status,
    steps: settled.completedSteps.length, approvalPoints: 1, wallMs: Date.now() - t0,
    idempotentReplay: r2.eventId === r1.eventId, fingerprintRejected: r3.status === 409 && r3.code === 'E_DUPLICATE',
    eventCountDelta: afterTotal - before, workflowDeduped: second.deduplicated,
  })
}

// ================= s06：审批拒绝（真实 BFF 拒绝路径） =================
async function modeS06() {
  const { simStart, baselinePvId } = await resetAndBaseline()
  await bootBff()
  const d = await flowDeps()
  const tools = await makeTools()
  const t0 = Date.now()
  const detail = bdEvent(simStart)
  const { cp, nodes } = await triggerFlow(d, tools, `BREAKDOWN:${detail.machineId}:${detail.occurredAt}`, detail)
  assert(cp.status === 'WAITING_APPROVAL', `流程挂起待审批（实际 ${cp.status}）`)
  const pvId = cp.refs.planVersionId!
  const after = await approveAndSettle(d, cp.workflowId, nodes, tools, 'rejected')
  assert(after.status === 'TERMINATED', `审批拒绝后流程 TERMINATED（实际 ${after.status}）`)
  assert((after.statusReason || '').includes('审批被拒绝'), `终止原因含「审批被拒绝」（实际 ${after.statusReason}）`)
  const pv = await biz(`/plan-versions/${pvId}`)
  assert(pv.status === 'REVIEW_PENDING', `候选版本停留 REVIEW_PENDING、未发布（实际 ${pv.status}）`)
  const pub = await biz(`/plan-versions/${pvId}/publish`, { method: 'POST', body: { version: pv.version }, expectError: true })
  assert(pub.status === 409 && pub.code === 'E_STATE_CONFLICT', `REVIEW_PENDING 上直接 publish 被拒 HTTP ${pub.status} ${pub.code}（不绕过评审）`)
  const actions = await planAudit(pvId)
  assert(actions.includes('PLAN_SUBMIT_REVIEW'), `审计含 PLAN_SUBMIT_REVIEW（实际 ${actions.join(',')}）`)
  assert(!actions.includes('PLAN_PUBLISH'), '审计不含 PLAN_PUBLISH（无发布副作用）')
  const dash = await biz('/dashboard')
  assert(dash.currentPlan?.id === baselinePvId, '发布中的计划仍是基线（未被替换）')
  metricsAndEvidence('s06', {
    scenario: 's06-review-reject', workflowId: cp.workflowId, terminal: after.status,
    steps: after.completedSteps.length, approvalPoints: 1, wallMs: Date.now() - t0,
    planVersionId: pvId, planStatus: pv.status, auditActions: actions,
  })
}

// ================= s03：混合扰动口径（两条独立单事件流程） =================
async function modeS03() {
  const { simStart } = await resetAndBaseline()
  await bootBff()
  const d = await flowDeps()
  const tools = await makeTools()
  const t0 = Date.now()
  // 流程 A：M-03 故障（与 golden s03 同参数）
  const dA = bdEvent(simStart)
  const a = await triggerFlow(d, tools, `BREAKDOWN:${dA.machineId}:${dA.occurredAt}`, dA)
  assert(a.cp.status === 'WAITING_APPROVAL', `流程 A（故障）挂起待审批（实际 ${a.cp.status}）`)
  const aSettled = await approveAndSettle(d, a.cp.workflowId, a.nodes, tools, 'approved')
  assert(aSettled.status === 'COMPLETED', `流程 A COMPLETED（实际 ${aSettled.status}）`)
  const pvA = a.cp.refs.planVersionId!
  // 流程 B：插单 ORD-GOLDEN-S03（盘类B ×10，与 golden s03 同参数）
  const dB = {
    eventType: 'NEW_ORDER' as const, subType: 'URGENT_INSERT', orderCode: 'ORD-GOLDEN-S03',
    productFamily: '盘类B', quantity: 10, arrivalAt: relMin(simStart, 25 * 60), dueAt: relMin(simStart, 31 * 60),
    priority: 1, occurredAt: relMin(simStart, 25 * 60), note: 'wf-e2e s03 插单',
  }
  const b = await triggerFlow(d, tools, `NEW_ORDER:${dB.orderCode}:${dB.occurredAt}`, dB)
  assert(b.cp.status === 'WAITING_APPROVAL', `流程 B（插单）挂起待审批（实际 ${b.cp.status}）`)
  const bSettled = await approveAndSettle(d, b.cp.workflowId, b.nodes, tools, 'approved')
  assert(bSettled.status === 'COMPLETED', `流程 B COMPLETED（实际 ${bSettled.status}）`)
  const pvB = b.cp.refs.planVersionId!
  const staleInLog = logLines.some((l) => l.includes('E_PLAN_STALE') || l.includes('E_VERSION_STALE'))
  assert(!staleInLog, '两条流程全程未出现 E_PLAN_STALE / E_VERSION_STALE（候选链问题结构性消除）')
  const ops = await biz(`/plan-versions/${pvB}/operations?size=5000`)
  const hasInsert = (ops.items || []).some((o: any) => o.orderCode === 'ORD-GOLDEN-S03' || o.orderId === 'ORD-GOLDEN-S03')
  assert(hasInsert, '流程 B 候选版本含插单 ORD-GOLDEN-S03 工序')
  metricsAndEvidence('s03', {
    scenario: 's03-mixed-disturbance', workflowIds: [a.cp.workflowId, b.cp.workflowId], terminal: 'COMPLETED×2',
    steps: aSettled.completedSteps.length + bSettled.completedSteps.length, approvalPoints: 2, wallMs: Date.now() - t0,
    planVersionIds: [pvA, pvB], planStaleOccurred: staleInLog,
    note: 'workflow 为单事件流程且候选版本审批前不发布，E_PLAN_STALE 候选链问题结构性不发生（与基线链式重排口径不同）',
  })
}

// ================= restart：崩溃恢复（真实 kill -9） =================
async function modeRestart() {
  const { simStart } = await resetAndBaseline()
  await bootBff()
  const beforeEvents = await bdEventTotal()
  const beforeTasks = await taskTotal()
  const t0 = Date.now()
  // 子进程跑流程（共享同一 FJSP_WORKFLOW_DIR；审批通道指向本进程 BFF）
  const detail = bdEvent(simStart)
  const tsx = process.env.FJSP_TSX || 'tsx'
  const child = spawn(tsx, [new URL(import.meta.url).pathname, 'child-run'], {
    env: {
      ...process.env,
      E2E_TRIGGER_JSON: JSON.stringify({ dedupeKey: `BREAKDOWN:${detail.machineId}:${detail.occurredAt}`, detail }),
      E2E_BFF_URL: BFF, E2E_TOKEN: TOKEN, E2E_CONV_ID: CONV_ID, E2E_MODE_DIR: MODE_DIR,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  let wfId = ''
  child.stdout.on('data', (buf) => {
    const line = String(buf)
    process.stdout.write(`[child] ${line}`)
    const m = line.match(/^WFID (\S+)/m)
    if (m) wfId = m[1]
  })
  const { CheckpointStore } = await import('./checkpoint.mts')
  const store = new CheckpointStore(process.env.FJSP_WORKFLOW_DIR)
  // 等子进程把流程推进到 poll-task 的 intent（重调度任务已创建、正在轮询）
  let killed = false
  for (let i = 0; i < 600 && !killed; i++) {
    await new Promise((r) => setTimeout(r, 200))
    if (!wfId) continue
    const cp = store.load(wfId)
    if (cp?.current?.node === 'poll-task' && cp.current.phase === 'intent' && cp.refs.taskId) {
      child.kill('SIGKILL')
      killed = true
    }
  }
  assert(killed, '子进程在 poll-task intent（任务已创建、轮询进行中）被 kill -9')
  const preCp = store.load(wfId)!
  const preTaskId = preCp.refs.taskId
  const prePollKey = preCp.current!.idempotencyKey
  console.log(`[现场] wfId=${wfId} taskId=${preTaskId} pollKey=${prePollKey}`)

  // 恢复（本进程 = 另一进程实例；真实业务现态 + 真实 BFF 审批核对）
  const d = await flowDeps()
  const tools = await makeTools()
  const dec1 = await d.recover(store, wfId, { checkApproval: d.makeApprovalChecker(d.bffOpts) })
  assert(dec1.action === 'resume' && (dec1 as any).skipExecute === false,
    `recover() 判定 resume 重做当前步骤（实际 ${JSON.stringify(dec1)}）`)
  assert((dec1 as any).idempotencyKey === prePollKey, `恢复复用原幂等键 ${prePollKey}`)
  const nodes = d.buildDisturbanceFlow().map((n: any) => (n.name === 'poll-task' ? { ...n, maxAttempts: 8 } : n))
  const resumed = await d.runWorkflow(wfId, nodes, { store, tools, approvalChannel: d.approvalChannel, log: flog })
  assert(resumed.status === 'WAITING_APPROVAL', `恢复续跑至挂起待审批（实际 ${resumed.status}）`)
  assert(resumed.refs.taskId === preTaskId, `恢复后 taskId 不变（${resumed.refs.taskId}），重调度未重复创建`)
  assert((await taskTotal()) - beforeTasks === 1, `调度任务净增恰为 1（重调度未重复写入）`)
  assert((await bdEventTotal()) - beforeEvents === 1, '事件净增恰为 1（登记未重复）')

  // 挂起状态再恢复一次：BFF 审批 pending 有效 → 继续等（消除 3.1 误作废）
  const dec2 = await d.recover(store, wfId, { checkApproval: d.makeApprovalChecker(d.bffOpts) })
  assert(dec2.action === 'await-approval', `挂起态 recover() 核对到 BFF pending 审批 → 继续等（实际 ${JSON.stringify(dec2)}）`)
  const settled = await approveAndSettle({ ...d, store }, wfId, nodes, tools, 'approved')
  assert(settled.status === 'COMPLETED', `批准后流程 COMPLETED（实际 ${settled.status}）`)
  const pollStep = settled.completedSteps.find((s: any) => s.node === 'poll-task')
  assert(pollStep?.idempotencyKey === prePollKey, `poll-task 完成记录沿用原幂等键 ${pollStep?.idempotencyKey}`)
  const actions = await planAudit(resumed.refs.planVersionId!)
  assert(actions.filter((a: string) => a === 'PLAN_SUBMIT_REVIEW').length === 1, `候选版本 PLAN_SUBMIT_REVIEW 恰 1 次（实际 ${actions.join(',')}）`)
  metricsAndEvidence('restart', {
    scenario: 'fault-restart', workflowId: wfId, terminal: settled.status,
    steps: settled.completedSteps.length, approvalPoints: 1, wallMs: Date.now() - t0,
    killPoint: 'poll-task intent（任务已创建、轮询进行中）', taskIdPreserved: resumed.refs.taskId === preTaskId,
    taskCountDelta: 1, eventCountDelta: 1, recoveredAtSuspend: dec2.action === 'await-approval',
  })
}

// child-run：restart 的被杀子进程（跑到天荒地老，由父进程 SIGKILL）
async function modeChildRun() {
  const { detail, dedupeKey } = JSON.parse(process.env.E2E_TRIGGER_JSON || '{}')
  const d = await flowDeps()
  // 子进程不启动 BFF：审批通道指向父进程的 BFF
  const { createBffApprovalChannel } = await import('./bff-approval.mts')
  const channel = createBffApprovalChannel({ baseUrl: process.env.E2E_BFF_URL!, token: process.env.E2E_TOKEN!, conversationId: process.env.E2E_CONV_ID! })
  const tools = await makeTools()
  const created = d.store.create({ type: 'DISTURBANCE', trigger: { source: 'wf-e2e', dedupeKey, detail } })
  console.log(`WFID ${created.checkpoint.workflowId}`)
  const nodes = d.buildDisturbanceFlow().map((n: any) => (n.name === 'poll-task' ? { ...n, maxAttempts: 8 } : n))
  await d.runWorkflow(created.checkpoint.workflowId, nodes, { store: d.store, tools, approvalChannel: channel, log: flog })
  setInterval(() => {}, 1000) // 保持进程存活，等待父进程 SIGKILL
}

// ================= timeout：轮询超时 → maxAttempts → FAILED 转人工 =================
async function modeTimeout() {
  const { simStart } = await resetAndBaseline()
  await bootBff()
  const beforeTasks = await taskTotal()
  const d = await flowDeps()
  // 脚本化 mock 轮询超时路径：fjsp_task_status 恒返 RUNNING 快照（非终态），写路径全真实
  const tools = await makeTools({
    fjsp_task_status: (out) => ({ ...out, ok: true, task: { ...(out.task || {}), status: 'RUNNING', resultStatus: null, planVersionId: null } }),
  })
  const t0 = Date.now()
  const detail = bdEvent(simStart)
  const { cp } = await triggerFlow(d, tools, `BREAKDOWN:${detail.machineId}:${detail.occurredAt}`, detail, 3)
  assert(cp.status === 'FAILED', `轮询超时达 maxAttempts 后 FAILED（实际 ${cp.status}）`)
  assert((cp.statusReason || '').includes('转人工'), `失败原因含「转人工」（实际 ${cp.statusReason}）`)
  assert(cp.current?.node === 'poll-task', `停在 poll-task 节点（实际 ${cp.current?.node}）`)
  assert((await taskTotal()) - beforeTasks === 1, '重调度任务恰创建 1 次（重试复用同键，无重复写）')
  assert(!cp.refs.planVersionId, '未产出候选版本（无污染下游）')
  metricsAndEvidence('timeout', {
    scenario: 'fault-timeout', workflowId: cp.workflowId, terminal: cp.status,
    steps: cp.completedSteps.length, approvalPoints: 0, wallMs: Date.now() - t0,
    taskId: cp.refs.taskId, taskCountDelta: 1, note: 'fjsp_task_status 恒返 RUNNING 快照为脚本化 mock；创建任务为真实写',
  })
}

// ================= stale：乐观锁冲突 → 重读重试 =================
async function modeStale() {
  const { simStart } = await resetAndBaseline()
  await bootBff()
  const d = await flowDeps()
  // 提交评审前人为使 version 过期：compare-plans 完成后武装，下一次 fjsp_get_plan 返回 version-1
  let armed = false
  let injected = false
  const tools = await makeTools({
    fjsp_compare_plans: (out) => { armed = true; return out },
    fjsp_get_plan: (out) => {
      if (armed && !injected && typeof out.plan?.version === 'number') {
        injected = true
        return { ...out, plan: { ...out.plan, version: out.plan.version - 1 } }
      }
      return out
    },
  })
  const t0 = Date.now()
  const detail = bdEvent(simStart)
  const { cp, nodes } = await triggerFlow(d, tools, `BREAKDOWN:${detail.machineId}:${detail.occurredAt}`, detail)
  assert(injected, '已在 submit-review 前注入过期 version（模拟并发修改）')
  assert(logLines.some((l) => l.includes('E_VERSION_STALE')), 'submit-review 首次尝试命中 E_VERSION_STALE')
  const submitStep = cp.completedSteps.find((s: any) => s.node === 'submit-review')
  assert(submitStep?.attempt === 2, `submit-review 重读最新 version 后第 2 次尝试成功（attempt=${submitStep?.attempt}）`)
  assert(cp.status === 'WAITING_APPROVAL', `冲突恢复后流程挂起待审批（实际 ${cp.status}）`)
  const pvId = cp.refs.planVersionId!
  const pv = await biz(`/plan-versions/${pvId}`)
  assert(pv.status === 'REVIEW_PENDING', `最终态正确：候选 REVIEW_PENDING（实际 ${pv.status}）`)
  const actions = await planAudit(pvId)
  assert(actions.filter((a: string) => a === 'PLAN_SUBMIT_REVIEW').length === 1, `PLAN_SUBMIT_REVIEW 恰 1 次，无重复写（实际 ${actions.join(',')}）`)
  const settled = await approveAndSettle(d, cp.workflowId, nodes, tools, 'approved')
  assert(settled.status === 'COMPLETED', `批准后流程 COMPLETED（实际 ${settled.status}）`)
  metricsAndEvidence('stale', {
    scenario: 'fault-optimistic-lock', workflowId: cp.workflowId, terminal: settled.status,
    steps: settled.completedSteps.length, approvalPoints: 1, wallMs: Date.now() - t0,
    planVersionId: pvId, submitAttempts: submitStep?.attempt,
    note: '过期 version 由驱动在 fjsp_get_plan 首次读取时注入（version-1），模拟提交评审前的并发修改',
  })
}

const MODES: Record<string, () => Promise<void>> = {
  s01: modeS01, s05: modeS05, s06: modeS06, s03: modeS03,
  restart: modeRestart, timeout: modeTimeout, stale: modeStale, 'child-run': modeChildRun,
}

if (!MODES[MODE]) {
  console.error(`用法: tsx e2e-regression.mts <${Object.keys(MODES).filter((m) => m !== 'child-run').join('|')}>`)
  process.exit(2)
}
if (MODE !== 'child-run') await bizLogin()
try {
  await MODES[MODE]()
} catch (e) {
  failures++
  console.error(`FAIL 未捕获异常：${String(e)}`)
}
console.log(failures ? `结果：${failures} 项断言失败` : '结果：全部断言通过')
process.exit(failures ? 1 : 0)

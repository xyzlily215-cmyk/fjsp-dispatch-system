// test-security-e2e: P0 安全回归的端到端版本（任务 1.3）——真实 business-service 内检 + 真实 JWT。
// 与 test-approval.mts（mock 内检）的关系：审批注入沿用 server.mts 导出的 onPermissionRequest
// （回归环境不拉 AGH daemon），其余全部走真实 HTTP：BFF 实例真实监听端口、/permission 等请求
// 真实过网络、token 来自真实 business-service 登录、内检真实打到 FJSP_API_BASE。
//
// 安全守卫：必须显式提供 FJSP_API_BASE 且不得指向演示端口 8081——本脚本只准打隔离回归环境
// （scripts/run-regression.sh，回归业务默认 18081，可用 FJSP_REG_BUSINESS_PORT 覆盖）。
//
// 运行（在 agh-integration/agent-bff/ 目录下，先起好回归环境）：
//   FJSP_API_BASE=http://localhost:18081/api/v1 ../agnes-harness/node_modules/.bin/tsx test-security-e2e.mts
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FJSP_API_BASE = (process.env.FJSP_API_BASE ?? '').replace(/\/+$/, '')
if (!FJSP_API_BASE) {
  console.error('FAIL: 必须显式设置 FJSP_API_BASE 指向隔离回归业务服务（拒绝默认演示地址）')
  process.exit(2)
}
if (/:(8081)(\/|$)/.test(FJSP_API_BASE)) {
  console.error(`FAIL: FJSP_API_BASE=${FJSP_API_BASE} 指向演示业务端口 8081，本脚本只允许打隔离回归环境`)
  process.exit(2)
}

const BFF_PORT = Number(process.env.AGENT_BFF_E2E_PORT ?? 14182)
const HUB_PORT = Number(process.env.AGENT_BFF_E2E_HUB_PORT ?? 14183)
const BFF = `http://127.0.0.1:${BFF_PORT}/agent-api`
const APPROVAL_TTL_MS = 2500
const SEED_PASSWORD = process.env.FJSP_REG_AUTH_PASSWORD ?? process.env.FJSP_AUTH_PASSWORD ?? 'Fj@123456'
// business-service local profile 种子账号（UserSeedRunner.java）：角色是内检返回的唯一来源
const REAL_USERS = ['dispatcher', 'reviewer', 'manager', 'admin'] as const

const tmp = mkdtempSync(join(tmpdir(), 'bff-sec-e2e-'))

// 静默 WS hub（同 test-approval：mhs.mts 在 hub ECONNREFUSED 时有已知递归崩溃，与本任务无关）
const mockHub = createServer()
mockHub.on('upgrade', (req, socket) => {
  const accept = createHash('sha1')
    .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )
})

// env 必须在动态 import server.mts 之前设置（模块加载时读取）
process.env.AGENT_BFF_PORT = String(BFF_PORT)
process.env.AGENT_BFF_HOST = '127.0.0.1'
process.env.FJSP_API_BASE = FJSP_API_BASE
process.env.AGENT_BFF_STORE_FILE = join(tmp, 'store.json')
process.env.AGENT_BFF_SESSION_ID_FILE = join(tmp, 'session-id')
process.env.AGENT_BFF_AUDIT_FILE = join(tmp, 'audit.jsonl')
process.env.AGH_OWNER_FILE = join(tmp, 'owner.json') // 不存在 → daemon absent
process.env.AGNES_HUB_URL = `ws://127.0.0.1:${HUB_PORT}/ws/hub`
process.env.AGENT_BFF_APPROVAL_TTL_MS = String(APPROVAL_TTL_MS)

async function loginReal(username: string): Promise<string> {
  // 多角色安全回归需要各角色自己的会话，不能复用同一个 admin token。
  const token = process.env[`FJSP_AUTH_TOKEN_${username.toUpperCase()}`]
  if (token) return token
  const res = await fetch(`${FJSP_API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: SEED_PASSWORD }),
  })
  const json = await res.json().catch(() => null)
  assert.ok(res.ok && json?.data?.token, `真实登录失败: ${username} HTTP ${res.status}；启用验证码后请设置 FJSP_AUTH_TOKEN_${username.toUpperCase()}`)
  return json.data.token as string
}

await new Promise<void>((resolve) => mockHub.listen(HUB_PORT, '127.0.0.1', resolve))
const bff = await import('./server.mts')

type Outcome = { verdict?: string; optionId?: string }

function makeConv(id: string, owner: string): import('./server.mts').Conversation {
  return {
    id, sessionId: null, owner, session: null, starting: null,
    pumping: false, busy: false, lastEventId: 0, buffer: [],
    subscribers: new Set(), pendingPermissions: new Map(),
  }
}

function inject(conv: import('./server.mts').Conversation, tool: string, args: Record<string, unknown>) {
  const before = conv.buffer.length
  const outcome = bff.onPermissionRequest(conv, { toolCall: { name: tool, args }, options: [] }) as Promise<Outcome>
  const entry = conv.buffer.slice(before).find((e) => e.event === 'permission_request')
  assert.ok(entry, 'permission_request 应已广播')
  const payload = JSON.parse(entry.data)
  return { requestId: payload.requestId as string, broadcast: payload, outcome }
}

async function api(method: string, path: string, { token, body }: { token?: string; body?: unknown } = {}) {
  const res = await fetch(BFF + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, data: await res.json().catch(() => ({})) }
}

async function waitReady() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BFF}/health`)
      if (res.status === 200) return
    } catch { /* 未起来 */ }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('BFF 未在 10s 内就绪')
}

function auditLines() {
  return readFileSync(join(tmp, 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

let passed = 0
function ok(name: string) { passed += 1; console.log(`ok ${passed} - ${name}`) }

try {
  await waitReady()

  // 1. 无 token 调 BFF 业务端点 → 401（真实鉴权中间件，不依赖 mock）
  const noTokenChat = await api('POST', '/chat', { body: { conversationId: 'x', text: 'hi' } })
  assert.equal(noTokenChat.status, 401)
  const noTokenTicket = await api('POST', '/stream-ticket', { body: {} })
  assert.equal(noTokenTicket.status, 401)
  ok('无 token 调 /chat 与 /stream-ticket → 401')

  // 2. 伪造 token → 401（真实内检打到真实 business-service /auth/me 被拒）
  const forged = await api('POST', '/stream-ticket', {
    token: 'forged.' + 'a'.repeat(64) + '.signature',
    body: {},
  })
  assert.equal(forged.status, 401)
  ok('伪造 token → 401（真实内检拒绝）')

  // 3. 真实登录 4 个种子角色，确认内检链路可用（role 来自 business-service）
  const tokens: Record<string, string> = {}
  for (const u of REAL_USERS) tokens[u] = await loginReal(u)
  const meCheck = await fetch(`${FJSP_API_BASE}/auth/me`, {
    headers: { Authorization: `Bearer ${tokens.dispatcher}` },
  })
  const me = await meCheck.json()
  assert.equal(me.data.role, 'DISPATCHER')
  ok('真实登录 dispatcher/reviewer/manager/admin 成功，内检链路可用（role=DISPATCHER 核实）')

  const convDisp = makeConv('conv-dispatcher', 'dispatcher')
  const convMgr = makeConv('conv-manager', 'manager')
  const convRev = makeConv('conv-reviewer', 'reviewer')
  for (const c of [convDisp, convMgr, convRev]) bff.conversations.set(c.id, c)

  // 4. 低角色越权批准：真实 DISPATCHER 批准自己会话的 fjsp_publish（HIGH_RISK，需 PRODUCTION_MANAGER）
  //    → 403 approval_forbidden，审批记录不消费，审计记 forbidden
  const r4 = inject(convDisp, 'fjsp_publish', { planVersionId: 'PV-E2E-1001' })
  const deny = await api('POST', '/permission', {
    token: tokens.dispatcher,
    body: { conversationId: 'conv-dispatcher', requestId: r4.requestId, verdict: 'allowed-once' },
  })
  assert.equal(deny.status, 403)
  assert.equal(deny.data.error, 'approval_forbidden')
  assert.equal(bff.approvals.get(r4.requestId)!.status, 'pending')
  ok('真实 DISPATCHER 批准 HIGH_RISK fjsp_publish → 403 approval_forbidden，记录不消费')

  // 5. 跨用户会话审批：真实 PRODUCTION_MANAGER（角色本身有权）裁决 dispatcher 会话的审批
  //    → 403 conversation_forbidden（归属先于角色），有审计留痕
  const cross = await api('POST', '/permission', {
    token: tokens.manager,
    body: { conversationId: 'conv-dispatcher', requestId: r4.requestId, verdict: 'allowed-once' },
  })
  assert.equal(cross.status, 403)
  assert.equal(cross.data.error, 'conversation_forbidden')
  const crossAudit = auditLines().find((l) => l.by === 'manager' && l.requestId === r4.requestId && l.result === 'forbidden')
  assert.ok(crossAudit && /归属/.test(crossAudit.detail), '跨用户裁决应记 forbidden 审计')
  ok('跨用户审批（manager 裁决 dispatcher 会话）→ 403 conversation_forbidden + 审计留痕')

  // 属主拒绝收尾（拒绝不受角色闸限制，避免承诺悬挂）
  const reject4 = await api('POST', '/permission', {
    token: tokens.dispatcher,
    body: { conversationId: 'conv-dispatcher', requestId: r4.requestId, verdict: 'rejected' },
  })
  assert.equal(reject4.status, 202)
  assert.deepEqual(await r4.outcome, { verdict: 'rejected' })

  // 6. 正常对照：真实 PRODUCTION_MANAGER 批准自己会话的 fjsp_publish → 202 allowed-once
  const r6 = inject(convMgr, 'fjsp_publish', { planVersionId: 'PV-E2E-3003' })
  const allow = await api('POST', '/permission', {
    token: tokens.manager,
    body: { conversationId: 'conv-manager', requestId: r6.requestId, verdict: 'allowed-once' },
  })
  assert.equal(allow.status, 202, JSON.stringify(allow.data))
  assert.deepEqual(await r6.outcome, { verdict: 'allowed-once' })
  ok('真实 PRODUCTION_MANAGER 批准 fjsp_publish → 202 allowed-once（角色闸非一刀切）')

  // 7. 重复裁决 → 409 approval_already_decided
  const dup = await api('POST', '/permission', {
    token: tokens.manager,
    body: { conversationId: 'conv-manager', requestId: r6.requestId, verdict: 'rejected' },
  })
  assert.equal(dup.status, 409)
  assert.equal(dup.data.error, 'approval_already_decided')
  ok('重复裁决同一 requestId → 409 approval_already_decided')

  // 8. 过期审批 → 410 approval_expired，daemon 承诺按 rejected 结算
  const r8 = inject(convMgr, 'fjsp_publish', { planVersionId: 'PV-E2E-2002' })
  await new Promise((r) => setTimeout(r, APPROVAL_TTL_MS + 500))
  const expired = await api('POST', '/permission', {
    token: tokens.manager,
    body: { conversationId: 'conv-manager', requestId: r8.requestId, verdict: 'allowed-once' },
  })
  assert.equal(expired.status, 410)
  assert.equal(expired.data.error, 'approval_expired')
  assert.deepEqual(await r8.outcome, { verdict: 'rejected' })
  ok('过期审批请求 → 410 approval_expired，承诺按 rejected 结算')

  // 9. 角色映射另一支：真实 REVIEWER 批准 fjsp_approve_review（HIGH_RISK → REVIEWER/ADMIN）→ 202
  const r9 = inject(convRev, 'fjsp_approve_review', { planVersionId: 'PV-E2E-4004', decision: 'APPROVE' })
  const allowRev = await api('POST', '/permission', {
    token: tokens.reviewer,
    body: { conversationId: 'conv-reviewer', requestId: r9.requestId, verdict: 'allowed-once' },
  })
  assert.equal(allowRev.status, 202, JSON.stringify(allowRev.data))
  assert.deepEqual(await r9.outcome, { verdict: 'allowed-once' })
  ok('真实 REVIEWER 批准 fjsp_approve_review → 202（评审/发布角色分离核实）')

  // 10. 审计 JSONL：越权/归属不符/批准/拒绝/过期齐全，by 为真实用户名，可按业务对象回溯
  const lines = auditLines()
  const results = new Set(lines.map((l) => l.result))
  assert.ok(results.has('forbidden') && results.has('approved') && results.has('rejected') && results.has('expired'),
    `audit results: ${[...results]}`)
  const trace = lines.filter((l) => l.bizObject?.planVersionId === 'PV-E2E-1001')
  assert.deepEqual(trace.map((l) => l.result), ['forbidden', 'forbidden', 'rejected'])
  const approved = lines.find((l) => l.result === 'approved')
  assert.equal(approved.by, 'manager')
  ok(`审计 JSONL ${lines.length} 条：越权/归属不符/批准/拒绝/过期齐全，by 为真实用户名，可按业务对象回溯`)

  console.log(`\nPASS ${passed} 组断言全部通过（真实内检 ${FJSP_API_BASE}）`)
  process.exitCode = 0
} catch (err) {
  console.error('FAIL:', err)
  process.exitCode = 1
} finally {
  mockHub.close()
  // 取证场景保留临时目录（含 audit.jsonl）：AGENT_BFF_E2E_KEEP_TMP=1
  if (process.env.AGENT_BFF_E2E_KEEP_TMP === '1') {
    console.log(`[keep] 临时目录保留：${tmp}（含 audit.jsonl）`)
  } else {
    rmSync(tmp, { recursive: true, force: true })
  }
  setTimeout(() => process.exit(process.exitCode ?? 0), 200)
}

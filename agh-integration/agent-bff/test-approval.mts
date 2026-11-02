// test-approval: agent-bff 审批身份绑定的脚本级测试（P0：五要素审批记录 + 批准时重校验
// + MCP _confirm 处置）。与 test-auth.mjs 的隔离思路一致：mock business-service
// （只实现 /auth/me 内检）+ mock WS hub；BFF 经 tsx 在本进程内 import（env 先隔离到
// 临时目录与独立端口 14179），不触碰正在运行的真实服务。
// 审批请求不依赖 daemon：直接调用 server.mts 导出的 onPermissionRequest 注入
// （server.mts 无 test-only HTTP 端点）。覆盖：五要素齐全放行；过期拒绝；重复裁决拒绝；
// 低角色批准 HIGH_RISK/DESTRUCTIVE 拒绝；跨用户审批 403；ticket 路径携带 role；
// 未知工具默认拒绝；审计 JSONL 可按会话/业务对象回溯；MCP 带 _confirm 直调写工具不放行。
//
// 运行：../agnes-harness/node_modules/.bin/tsx test-approval.mts（在 agh-integration/agent-bff/ 目录下）
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MOCK_PORT = 18098
const HUB_PORT = 18097
const BFF_PORT = 14179
const BFF = `http://127.0.0.1:${BFF_PORT}/agent-api`
const APPROVAL_TTL_MS = 2500

const USERS: Record<string, { username: string; role: string; displayName: string }> = {
  'tok-alice': { username: 'alice', role: 'DISPATCHER', displayName: '调度员A' },
  'tok-bob': { username: 'bob', role: 'REVIEWER', displayName: '审核员B' },
  'tok-carol': { username: 'carol', role: 'PRODUCTION_MANAGER', displayName: '生产主管C' },
  'tok-dave': { username: 'dave', role: 'ADMIN', displayName: '管理员D' },
}

const tmp = mkdtempSync(join(tmpdir(), 'bff-approval-test-'))

const mockAuth = createServer((req, res) => {
  if (req.url === '/api/v1/auth/me') {
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '')
    const user = USERS[token]
    res.writeHead(user ? 200 : 401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(user
      ? { code: 'OK', data: user }
      : { code: 'E_UNAUTHORIZED', message: '未认证或凭证已失效', data: null }))
    return
  }
  res.writeHead(404).end()
})

// 静默 WS hub（同 test-auth：死端口会触发 mhs.mts 的 ECONNREFUSED 递归崩溃，与本任务无关）
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

// env 必须在动态 import server.mts 之前设置（模块加载时读取）；mock 服务也必须先于
// import 就绪——mhsHub.start() 在模块加载时立即连 AGNES_HUB_URL，连不上会触发
// mhs.mts 已知的 ECONNREFUSED error→close 递归崩溃（非本任务范围）。
process.env.AGENT_BFF_PORT = String(BFF_PORT)
process.env.AGENT_BFF_HOST = '127.0.0.1'
process.env.FJSP_API_BASE = `http://127.0.0.1:${MOCK_PORT}/api/v1`
process.env.AGENT_BFF_STORE_FILE = join(tmp, 'store.json')
process.env.AGENT_BFF_SESSION_ID_FILE = join(tmp, 'session-id')
process.env.AGENT_BFF_AUDIT_FILE = join(tmp, 'audit.jsonl')
process.env.AGH_OWNER_FILE = join(tmp, 'owner.json') // 不存在 → daemon absent
process.env.AGNES_HUB_URL = `ws://127.0.0.1:${HUB_PORT}/ws/hub`
process.env.AGENT_BFF_APPROVAL_TTL_MS = String(APPROVAL_TTL_MS)

await new Promise<void>((resolve) => mockAuth.listen(MOCK_PORT, '127.0.0.1', resolve))
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

// 注入一次 daemon 审批请求；返回 requestId 与裁决 promise（settles 时取回 outcome）
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

async function mcpCall(server: ReturnType<typeof spawn>, pending: Map<string, (m: never) => void>,
  seqRef: { seq: number }, method: string, params: unknown = {}) {
  const id = String(++seqRef.seq)
  return new Promise<Record<string, unknown>>((resolve) => {
    pending.set(id, resolve as never)
    server.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}

let passed = 0
function ok(name: string) { passed += 1; console.log(`ok ${passed} - ${name}`) }

try {
  await waitReady()

  const convAlice = makeConv('conv-alice', 'alice')
  const convBob = makeConv('conv-bob', 'bob')
  const convCarol = makeConv('conv-carol', 'carol')
  const convDave = makeConv('conv-dave', 'dave')
  for (const c of [convAlice, convBob, convCarol, convDave]) bff.conversations.set(c.id, c)

  // 1. 五要素审批记录：工具名/参数摘要/业务对象/有效期/可审批角色 + 广播人类可读摘要
  const r1 = inject(convAlice, 'fjsp_publish', { planVersionId: 'PV-1001' })
  const rec1 = bff.approvals.get(r1.requestId)
  assert.ok(rec1)
  assert.equal(rec1.tool, 'fjsp_publish')
  assert.equal(rec1.risk, 'HIGH_RISK')
  assert.deepEqual(rec1.requiredRoles, ['PRODUCTION_MANAGER', 'ADMIN'])
  assert.deepEqual(rec1.bizObject, { planVersionId: 'PV-1001' })
  assert.match(rec1.argsDigest, /^[0-9a-f]{64}$/)
  assert.equal(rec1.expiresAt - rec1.createdAt, APPROVAL_TTL_MS)
  assert.equal(rec1.status, 'pending')
  assert.ok(r1.broadcast.approval.summary.includes('fjsp_publish'))
  assert.ok(r1.broadcast.approval.summary.includes('PV-1001'))
  ok('五要素审批记录：工具/风险级/角色/业务对象/摘要/指纹/有效期齐全，广播带人类可读摘要')

  // 1b. 审批 TTL env 非法值兜底（终审 M1）：Number('abc')=NaN 会让 expiresAt=NaN、
  // Date.now() > expiresAt 恒 false，审批永不过期（fail-open）；非数字回退默认 5 分钟
  assert.equal(bff.resolveApprovalTtlMs('abc'), 5 * 60_000)
  assert.equal(bff.resolveApprovalTtlMs(undefined), 5 * 60_000)
  assert.equal(bff.resolveApprovalTtlMs('2500'), 2500)
  ok('AGENT_BFF_APPROVAL_TTL_MS 非数字配置回退默认 5 分钟（不 fail-open）')

  // 2. 低角色属主批准自己会话的 HIGH_RISK → 403 approval_forbidden（记录仍 pending）
  const denyAlice = await api('POST', '/permission', {
    token: 'tok-alice',
    body: { conversationId: 'conv-alice', requestId: r1.requestId, verdict: 'allowed-once' },
  })
  assert.equal(denyAlice.status, 403)
  assert.equal(denyAlice.data.error, 'approval_forbidden')
  assert.equal(bff.approvals.get(r1.requestId)!.status, 'pending')
  ok('低角色（DISPATCHER）批准 HIGH_RISK fjsp_publish → 403 approval_forbidden，记录不消费')

  // 3. 跨用户审批 → 403 conversation_forbidden（会话归属校验先于一切：
  // 即使 bob 是 REVIEWER 也摸不到 alice 会话里的审批）
  const crossUser = await api('POST', '/permission', {
    token: 'tok-bob',
    body: { conversationId: 'conv-alice', requestId: r1.requestId, verdict: 'allowed-once' },
  })
  assert.equal(crossUser.status, 403)
  assert.equal(crossUser.data.error, 'conversation_forbidden')
  ok('跨用户审批（bob 裁决 alice 的会话）→ 403 conversation_forbidden')

  // 属主拒绝不受角色闸限制（安全操作，避免承诺悬挂）
  const rejectR1 = await api('POST', '/permission', {
    token: 'tok-alice',
    body: { conversationId: 'conv-alice', requestId: r1.requestId, verdict: 'rejected' },
  })
  assert.equal(rejectR1.status, 202)
  assert.deepEqual(await r1.outcome, { verdict: 'rejected' })

  // 4. 五要素齐全 + 角色匹配 + 属主本人 → 放行（allowed-once 回到 daemon 承诺）
  const r4 = inject(convCarol, 'fjsp_publish', { planVersionId: 'PV-3003' })
  const allow = await api('POST', '/permission', {
    token: 'tok-carol',
    body: { conversationId: 'conv-carol', requestId: r4.requestId, verdict: 'allowed-once' },
  })
  assert.equal(allow.status, 202, JSON.stringify(allow.data))
  assert.equal(allow.data.verdict, 'allowed-once')
  assert.deepEqual(await r4.outcome, { verdict: 'allowed-once' })
  assert.equal(bff.approvals.get(r4.requestId)!.status, 'approved')
  ok('PRODUCTION_MANAGER 属主批准 fjsp_publish → 202，daemon 承诺收到 allowed-once')

  // 5. 重复裁决 → 409 approval_already_decided（一次性）
  const dup = await api('POST', '/permission', {
    token: 'tok-carol',
    body: { conversationId: 'conv-carol', requestId: r4.requestId, verdict: 'rejected' },
  })
  assert.equal(dup.status, 409)
  assert.equal(dup.data.error, 'approval_already_decided')
  ok('重复裁决同一 requestId → 409 approval_already_decided')

  // 6. WRITE 工具角色映射：REVIEWER 属主批自己会话 → 403；DISPATCHER 属主 → 202
  const r6a = inject(convBob, 'fjsp_create_baseline', { name: '基线A' })
  const denyBob = await api('POST', '/permission', {
    token: 'tok-bob',
    body: { conversationId: 'conv-bob', requestId: r6a.requestId, verdict: 'allowed-once' },
  })
  assert.equal(denyBob.status, 403)
  assert.equal(denyBob.data.error, 'approval_forbidden')
  await api('POST', '/permission', {
    token: 'tok-bob',
    body: { conversationId: 'conv-bob', requestId: r6a.requestId, verdict: 'rejected' },
  })
  await r6a.outcome
  const r6b = inject(convAlice, 'fjsp_create_baseline', { name: '基线B' })
  const allowAlice = await api('POST', '/permission', {
    token: 'tok-alice',
    body: { conversationId: 'conv-alice', requestId: r6b.requestId, verdict: 'allowed-once' },
  })
  assert.equal(allowAlice.status, 202)
  assert.deepEqual(await r6b.outcome, { verdict: 'allowed-once' })
  ok('WRITE 工具：REVIEWER 403，DISPATCHER 202 放行')

  // 7. DESTRUCTIVE 仅 ADMIN：PRODUCTION_MANAGER 属主 403，ADMIN 属主 202
  const r7a = inject(convCarol, 'fjsp_reset_demo', {})
  const denyCarol = await api('POST', '/permission', {
    token: 'tok-carol',
    body: { conversationId: 'conv-carol', requestId: r7a.requestId, verdict: 'allowed-once' },
  })
  assert.equal(denyCarol.status, 403)
  await api('POST', '/permission', {
    token: 'tok-carol',
    body: { conversationId: 'conv-carol', requestId: r7a.requestId, verdict: 'rejected' },
  })
  await r7a.outcome
  const r7b = inject(convDave, 'fjsp_reset_demo', {})
  const allowDave = await api('POST', '/permission', {
    token: 'tok-dave',
    body: { conversationId: 'conv-dave', requestId: r7b.requestId, verdict: 'allowed-once' },
  })
  assert.equal(allowDave.status, 202)
  assert.deepEqual(await r7b.outcome, { verdict: 'allowed-once' })
  ok('DESTRUCTIVE 工具：PRODUCTION_MANAGER 403，ADMIN 202 放行')

  // 8. ticket 路径携带 role：alice 用 ticket 批准自己会话的 WRITE → 202（旧实现 role:'' 会 403）
  const ticketRes = await api('POST', '/stream-ticket', { token: 'tok-alice', body: {} })
  assert.equal(ticketRes.status, 200)
  const r8 = inject(convAlice, 'fjsp_insert_order', { orderId: 'WO-9' })
  const viaTicket = await api(
    'POST',
    `/permission?ticket=${encodeURIComponent(ticketRes.data.ticket)}`,
    { body: { conversationId: 'conv-alice', requestId: r8.requestId, verdict: 'allowed-once' } },
  )
  assert.equal(viaTicket.status, 202, JSON.stringify(viaTicket.data))
  assert.deepEqual(await r8.outcome, { verdict: 'allowed-once' })
  ok('ticket 路径补 role：ticket 批准 WRITE → 202（role 随票传递）')

  // 9. 未知工具默认拒绝批准（requiredRoles 为空，ADMIN 也不可批），但属主可拒绝
  const r9 = inject(convDave, 'shell', { cmd: 'ls' })
  assert.equal(bff.approvals.get(r9.requestId)!.risk, 'UNKNOWN')
  const denyUnknown = await api('POST', '/permission', {
    token: 'tok-dave',
    body: { conversationId: 'conv-dave', requestId: r9.requestId, verdict: 'allowed-once' },
  })
  assert.equal(denyUnknown.status, 403)
  assert.equal(denyUnknown.data.error, 'approval_forbidden')
  const rejectUnknown = await api('POST', '/permission', {
    token: 'tok-dave',
    body: { conversationId: 'conv-dave', requestId: r9.requestId, verdict: 'rejected' },
  })
  assert.equal(rejectUnknown.status, 202) // 拒绝不受角色闸限制，避免承诺悬挂
  assert.deepEqual(await r9.outcome, { verdict: 'rejected' })
  ok('未知工具/未知级别：批准 fail-closed（ADMIN 也 403），拒绝放行')

  // 10. 过期请求 → 410 approval_expired，daemon 承诺收到 rejected，审计记 expired
  const r10 = inject(convDave, 'fjsp_publish', { planVersionId: 'PV-2002' })
  await new Promise((r) => setTimeout(r, APPROVAL_TTL_MS + 400))
  const expired = await api('POST', '/permission', {
    token: 'tok-dave',
    body: { conversationId: 'conv-dave', requestId: r10.requestId, verdict: 'allowed-once' },
  })
  assert.equal(expired.status, 410)
  assert.equal(expired.data.error, 'approval_expired')
  assert.deepEqual(await r10.outcome, { verdict: 'rejected' })
  assert.equal(bff.approvals.get(r10.requestId)!.status, 'expired')
  ok('过期审批请求 → 410 approval_expired，承诺按 rejected 结算')

  // 11. 审计写失败 fail-closed：批准不生效（503 audit_unavailable），记录不消费可重试
  const goodAuditFile = process.env.AGENT_BFF_AUDIT_FILE!
  process.env.AGENT_BFF_AUDIT_FILE = join(tmp, 'no-such-dir', 'audit.jsonl') // 目录不存在 → 写必败
  const r11 = inject(convCarol, 'fjsp_publish', { planVersionId: 'PV-4004' })
  const blocked = await api('POST', '/permission', {
    token: 'tok-carol',
    body: { conversationId: 'conv-carol', requestId: r11.requestId, verdict: 'allowed-once' },
  })
  assert.equal(blocked.status, 503)
  assert.equal(blocked.data.error, 'audit_unavailable')
  assert.equal(bff.approvals.get(r11.requestId)!.status, 'pending') // 未消费
  process.env.AGENT_BFF_AUDIT_FILE = goodAuditFile
  const retry = await api('POST', '/permission', {
    token: 'tok-carol',
    body: { conversationId: 'conv-carol', requestId: r11.requestId, verdict: 'allowed-once' },
  })
  assert.equal(retry.status, 202, JSON.stringify(retry.data))
  assert.deepEqual(await r11.outcome, { verdict: 'allowed-once' })
  ok('审计写失败：批准 fail-closed（503 audit_unavailable，记录仍 pending），恢复后重试放行')

  // 12. 404 探测留痕：属主对自己会话发不存在的 requestId → 404 + 会话级审计
  const probe = await api('POST', '/permission', {
    token: 'tok-alice',
    body: { conversationId: 'conv-alice', requestId: 'req-bogus', verdict: 'allowed-once' },
  })
  assert.equal(probe.status, 404)
  assert.equal(probe.data.error, 'permission_not_found')
  ok('不存在 requestId 的裁决探测 → 404 permission_not_found（留痕见下）')

  // 13. 审计：批准/拒绝/过期/越权/归属不符/404 探测均落 JSONL，可按会话/业务对象回溯
  const lines = auditLines()
  const results = new Set(lines.map((l) => l.result))
  assert.ok(results.has('approved') && results.has('rejected') && results.has('forbidden') && results.has('expired'),
    `audit results: ${[...results]}`)
  const approved = lines.find((l) => l.result === 'approved' && l.tool === 'fjsp_publish')
  assert.equal(approved.by, 'carol')
  assert.equal(approved.conversationId, 'conv-carol')
  assert.match(approved.argsDigest, /^[0-9a-f]{64}$/)
  // 按业务对象回溯：PV-1001 的全部裁决轨迹（属主越权 → 跨用户归属不符 → 属主拒绝）
  const trace = lines.filter((l) => l.bizObject?.planVersionId === 'PV-1001')
  assert.deepEqual(trace.map((l) => l.result), ['forbidden', 'forbidden', 'rejected'])
  // 跨用户裁决留审计痕：bob 的 403 conversation_forbidden 有 forbidden 记录
  const crossAudit = lines.find((l) => l.by === 'bob' && l.result === 'forbidden' && l.requestId === r1.requestId)
  assert.ok(crossAudit && /归属/.test(crossAudit.detail), '跨用户裁决应记 forbidden 审计')
  // 404 探测留痕：会话级审计条目（tool 为空，detail 注明探测）
  const probeAudit = lines.find((l) => l.requestId === 'req-bogus' && l.by === 'alice')
  assert.ok(probeAudit && probeAudit.result === 'forbidden' && /404 探测/.test(probeAudit.detail), '404 探测应记会话级审计')
  assert.ok(lines.every((l) => l.ts && l.requestId && l.by && (l.tool !== undefined)))
  ok(`审计 JSONL ${lines.length} 条：批准/拒绝/越权/过期/归属不符/404 探测齐全，可按会话与业务对象回溯`)

  // 14. MCP：_confirm 不再是批准证据，WRITE/DESTRUCTIVE 直调一律拒绝
  // FJSP_API_BASE 指向死端口：即便回归发生也不会触达真实 business-service
  const tsx = new URL('../agnes-harness/node_modules/.bin/tsx', import.meta.url).pathname
  const mcp = spawn(tsx, [new URL('./mcp-server.mts', import.meta.url).pathname], {
    env: { ...process.env, FJSP_API_BASE: 'http://127.0.0.1:9/api/v1' },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const pending = new Map<string, (m: never) => void>()
  const seqRef = { seq: 0 }
  let buf = ''
  mcp.stdout!.on('data', (chunk) => {
    buf += chunk
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      if (!line.trim()) continue
      const msg = JSON.parse(line)
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)!(msg)
        pending.delete(msg.id)
      }
    }
  })
  try {
    await mcpCall(mcp, pending, seqRef, 'initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-approval', version: '0' },
    })
    for (const tool of ['fjsp_create_baseline', 'fjsp_reset_demo']) {
      const r = await mcpCall(mcp, pending, seqRef, 'tools/call', {
        name: tool, arguments: { _confirm: true, name: 'x' },
      })
      const result = r.result as { isError?: boolean; content: { text: string }[] }
      assert.ok(result.isError, `${tool} 带 _confirm 仍被执行`)
      const payload = JSON.parse(result.content[0].text)
      assert.equal(payload.error.code, 'APPROVAL_CHANNEL_REQUIRED')
    }
    ok('MCP：_confirm:true 直调 WRITE/DESTRUCTIVE 工具 → APPROVAL_CHANNEL_REQUIRED，不放行')
  } finally {
    mcp.kill()
  }

  console.log(`\nPASS ${passed} 组断言全部通过`)
  process.exitCode = 0
} catch (err) {
  console.error('FAIL:', err)
  process.exitCode = 1
} finally {
  mockAuth.close()
  mockHub.close()
  rmSync(tmp, { recursive: true, force: true })
  // 本进程内 import 的 BFF 仍在监听、pending 定时器未清，直接退出
  setTimeout(() => process.exit(process.exitCode ?? 0), 200)
}

// test-approval-status: agent-bff 审批查询/登记端点与持久化测试（任务 3.4）。
// 与 test-approval.mts 同一隔离思路：mock business-service（只实现 /auth/me 内检）
// + 静默 WS hub；BFF 经 tsx 在本进程内 import（env 先隔离到临时目录与独立端口 14181）。
// 覆盖：POST /approvals 登记（五要素服务端生成 + SSE 卡片下发 + 持久化落盘）；
// GET /approvals/:requestId（未认证 401 / 跨用户 403 / 未知 404 / 属主 200 五要素+状态）；
// 无 daemon 承诺的裁决路径（批准 202 / 拒绝无角色闸 / 重复裁决 409 / 过期 410）；
// 惰性过期；loadApprovalsFromFile 重启恢复语义（pending → expired，旧批准不回放）。
//
// 运行：../agnes-harness/node_modules/.bin/tsx test-approval-status.mts（在 agh-integration/agent-bff/ 目录下）
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MOCK_PORT = 18102
const HUB_PORT = 18101
const BFF_PORT = 14181
const BFF = `http://127.0.0.1:${BFF_PORT}/agent-api`
const APPROVAL_TTL_MS = 1500

const USERS: Record<string, { username: string; role: string; displayName: string }> = {
  'tok-alice': { username: 'alice', role: 'DISPATCHER', displayName: '调度员A' },
  'tok-bob': { username: 'bob', role: 'REVIEWER', displayName: '审核员B' },
}

const tmp = mkdtempSync(join(tmpdir(), 'bff-approval-status-test-'))

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

// 静默 WS hub（同 test-approval：mhs.mts 连不上 hub 会触发已知的 ECONNREFUSED 递归崩溃）
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
process.env.FJSP_API_BASE = `http://127.0.0.1:${MOCK_PORT}/api/v1`
process.env.AGENT_BFF_STORE_FILE = join(tmp, 'store.json')
process.env.AGENT_BFF_SESSION_ID_FILE = join(tmp, 'session-id')
process.env.AGENT_BFF_AUDIT_FILE = join(tmp, 'audit.jsonl')
process.env.AGENT_BFF_APPROVALS_FILE = join(tmp, 'approvals.json')
process.env.AGH_OWNER_FILE = join(tmp, 'owner.json') // 不存在 → daemon absent
process.env.AGNES_HUB_URL = `ws://127.0.0.1:${HUB_PORT}/ws/hub`
process.env.AGENT_BFF_APPROVAL_TTL_MS = String(APPROVAL_TTL_MS)

await new Promise<void>((resolve) => mockAuth.listen(MOCK_PORT, '127.0.0.1', resolve))
await new Promise<void>((resolve) => mockHub.listen(HUB_PORT, '127.0.0.1', resolve))
const bff = await import('./server.mts')

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

function persisted(): Record<string, { status: string }> {
  return JSON.parse(readFileSync(join(tmp, 'approvals.json'), 'utf8'))
}

let passed = 0
function ok(name: string) { passed += 1; console.log(`ok ${passed} - ${name}`) }

try {
  await waitReady()

  // 1. 登记端点未认证 → 401
  const noAuth = await api('POST', '/approvals', { body: { conversationId: 'conv-bob', toolCall: { name: 'fjsp_approve_review', args: { planVersionId: 'PV-7' } } } })
  assert.equal(noAuth.status, 401)
  ok('POST /approvals 未认证 → 401')

  // 2. bob 登记审批（fjsp_approve_review，HIGH_RISK）：五要素服务端生成 + SSE 卡片下发 + 持久化
  const reg = await api('POST', '/approvals', {
    token: 'tok-bob',
    body: { conversationId: 'conv-bob', toolCall: { name: 'fjsp_approve_review', args: { planVersionId: 'PV-7' } } },
  })
  assert.equal(reg.status, 202, JSON.stringify(reg.data))
  const rec = reg.data.approval
  assert.ok(typeof rec.requestId === 'string' && rec.requestId.length > 0)
  assert.equal(rec.conversationId, 'conv-bob')
  assert.equal(rec.tool, 'fjsp_approve_review')
  assert.equal(rec.risk, 'HIGH_RISK')
  assert.deepEqual(rec.requiredRoles, ['REVIEWER', 'ADMIN'])
  assert.deepEqual(rec.bizObject, { planVersionId: 'PV-7' })
  assert.match(rec.argsDigest, /^[0-9a-f]{64}$/)
  assert.ok(rec.argsSummary.includes('PV-7'))
  assert.equal(rec.expiresAt - rec.createdAt, APPROVAL_TTL_MS)
  assert.equal(rec.status, 'pending')
  // SSE 卡片下发（web-vue 审批卡片契约不变）
  const convBob = bff.conversations.get('conv-bob')!
  const card = convBob.buffer.find((e) => e.event === 'permission_request')
  assert.ok(card, '登记后应向会话广播 permission_request')
  const cardPayload = JSON.parse(card!.data)
  assert.equal(cardPayload.requestId, rec.requestId)
  assert.ok(cardPayload.approval.summary.includes('PV-7'))
  // 持久化落盘
  assert.equal(persisted()[rec.requestId]?.status, 'pending')
  ok('POST /approvals 登记：五要素服务端生成 + permission_request 卡片下发 + 持久化落盘')

  // 3. GET 未认证 → 401
  const getNoAuth = await api('GET', `/approvals/${rec.requestId}`)
  assert.equal(getNoAuth.status, 401)
  ok('GET /approvals/:id 未认证 → 401')

  // 4. GET 跨用户 → 403 conversation_forbidden（记 forbidden 审计）
  const cross = await api('GET', `/approvals/${rec.requestId}`, { token: 'tok-alice' })
  assert.equal(cross.status, 403)
  assert.equal(cross.data.error, 'conversation_forbidden')
  ok('GET 跨用户查询 → 403 conversation_forbidden（留痕见第 11 项）')

  // 5. GET 未知 requestId → 404 approval_not_found
  const notFound = await api('GET', '/approvals/req-bogus', { token: 'tok-bob' })
  assert.equal(notFound.status, 404)
  assert.equal(notFound.data.error, 'approval_not_found')
  ok('GET 未知 requestId → 404 approval_not_found')

  // 6. GET 属主 → 200 pending + 五要素摘要
  const got = await api('GET', `/approvals/${rec.requestId}`, { token: 'tok-bob' })
  assert.equal(got.status, 200)
  assert.equal(got.data.approval.status, 'pending')
  assert.equal(got.data.approval.tool, 'fjsp_approve_review')
  assert.deepEqual(got.data.approval.bizObject, { planVersionId: 'PV-7' })
  ok('GET 属主查询 → 200 pending + 五要素摘要')

  // 7. 无 daemon 承诺的裁决：REVIEWER 属主批准 → 202；GET → approved；重复裁决 → 409
  const approve = await api('POST', '/permission', {
    token: 'tok-bob',
    body: { conversationId: 'conv-bob', requestId: rec.requestId, verdict: 'allowed-once' },
  })
  assert.equal(approve.status, 202, JSON.stringify(approve.data))
  const after = await api('GET', `/approvals/${rec.requestId}`, { token: 'tok-bob' })
  assert.equal(after.data.approval.status, 'approved')
  assert.equal(persisted()[rec.requestId]?.status, 'approved', '裁决结果应持久化')
  const resolved = convBob.buffer.find((e) => e.event === 'permission_resolved')
  assert.ok(resolved, '裁决后应广播 permission_resolved')
  const dup = await api('POST', '/permission', {
    token: 'tok-bob',
    body: { conversationId: 'conv-bob', requestId: rec.requestId, verdict: 'rejected' },
  })
  assert.equal(dup.status, 409)
  assert.equal(dup.data.error, 'approval_already_decided')
  ok('登记审批裁决：批准 202 → GET approved → 重复裁决 409（一次性）')

  // 8. 拒绝不受角色闸限制：alice（DISPATCHER，非可审批角色）登记 fjsp_approve_review 后可拒绝自己会话
  const regAlice = await api('POST', '/approvals', {
    token: 'tok-alice',
    body: { conversationId: 'conv-alice', toolCall: { name: 'fjsp_approve_review', args: { planVersionId: 'PV-8' } } },
  })
  assert.equal(regAlice.status, 202)
  const denyApprove = await api('POST', '/permission', {
    token: 'tok-alice',
    body: { conversationId: 'conv-alice', requestId: regAlice.data.approval.requestId, verdict: 'allowed-once' },
  })
  assert.equal(denyApprove.status, 403)
  assert.equal(denyApprove.data.error, 'approval_forbidden')
  const reject = await api('POST', '/permission', {
    token: 'tok-alice',
    body: { conversationId: 'conv-alice', requestId: regAlice.data.approval.requestId, verdict: 'rejected' },
  })
  assert.equal(reject.status, 202)
  const afterReject = await api('GET', `/approvals/${regAlice.data.approval.requestId}`, { token: 'tok-alice' })
  assert.equal(afterReject.data.approval.status, 'rejected')
  ok('登记审批：低角色批准 403 approval_forbidden，属主拒绝放行 → rejected')

  // 9. 过期：a) 登记后等 TTL 过 → GET 惰性过期报 expired；b) 另一个请求过期后直接裁决 → 410
  const regExp = await api('POST', '/approvals', {
    token: 'tok-bob',
    body: { conversationId: 'conv-bob', toolCall: { name: 'fjsp_publish', args: { planVersionId: 'PV-9' } } },
  })
  const regExp2 = await api('POST', '/approvals', {
    token: 'tok-bob',
    body: { conversationId: 'conv-bob', toolCall: { name: 'fjsp_publish', args: { planVersionId: 'PV-10' } } },
  })
  assert.equal(regExp.status, 202)
  assert.equal(regExp2.status, 202)
  await new Promise((r) => setTimeout(r, APPROVAL_TTL_MS + 400))
  const getExpired = await api('GET', `/approvals/${regExp.data.approval.requestId}`, { token: 'tok-bob' })
  assert.equal(getExpired.status, 200)
  assert.equal(getExpired.data.approval.status, 'expired')
  const lateDecide = await api('POST', '/permission', {
    token: 'tok-bob',
    body: { conversationId: 'conv-bob', requestId: regExp2.data.approval.requestId, verdict: 'allowed-once' },
  })
  assert.equal(lateDecide.status, 410)
  assert.equal(lateDecide.data.error, 'approval_expired')
  ok('过期：GET 惰性过期报 expired，过期后裁决 → 410 approval_expired')

  // 9b. 到期定时器：登记后无人 GET、无人裁决，到期也应主动落 expired + 审计 + 广播收口
  const regIdle = await api('POST', '/approvals', {
    token: 'tok-bob',
    body: { conversationId: 'conv-bob', toolCall: { name: 'fjsp_publish', args: { planVersionId: 'PV-11' } } },
  })
  assert.equal(regIdle.status, 202)
  const idleId = regIdle.data.approval.requestId
  await new Promise((r) => setTimeout(r, APPROVAL_TTL_MS + 400))
  assert.equal(persisted()[idleId]?.status, 'expired', '定时器应把无人处理的登记审批落 expired')
  const idleAudit = auditLines().find((l) => l.requestId === idleId && l.result === 'expired')
  assert.ok(idleAudit && idleAudit.by === 'system' && /定时过期/.test(idleAudit.detail), '定时过期应以 system 身份留痕')
  const idleResolved = bff.conversations.get('conv-bob')!.buffer
    .find((e) => e.event === 'permission_resolved' && JSON.parse(e.data).requestId === idleId)
  assert.ok(idleResolved, '定时过期应广播 permission_resolved 收起前端卡片')
  const idleDecide = await api('POST', '/permission', {
    token: 'tok-bob', body: { conversationId: 'conv-bob', requestId: idleId, verdict: 'allowed-once' },
  })
  assert.equal(idleDecide.status, 410, '定时过期后裁决仍报 410（不是 409 已裁决）')
  ok('到期定时器：无人 GET 也落 expired + system 审计 + permission_resolved，之后裁决 410')

  // 9c. 跨用户登记：alice 不能在 bob 的会话里登记审批
  const crossReg = await api('POST', '/approvals', {
    token: 'tok-alice',
    body: { conversationId: 'conv-bob', toolCall: { name: 'fjsp_publish', args: { planVersionId: 'PV-12' } } },
  })
  assert.equal(crossReg.status, 403, JSON.stringify(crossReg.data))
  ok('POST /approvals 跨用户登记 → 403')

  // 9d. 文件权限：审批记录与审计 JSONL 均为 0600
  assert.equal(statSync(join(tmp, 'approvals.json')).mode & 0o777, 0o600, '.approvals.json 应为 0600')
  assert.equal(statSync(join(tmp, 'audit.jsonl')).mode & 0o777, 0o600, '审计 JSONL 应为 0600')
  ok('审批记录与审计文件权限 0600')

  // 10. 持久化文件可供重启恢复；loadApprovalsFromFile 把遗留 pending 置 expired（旧批准不回放）
  const staged = join(tmp, 'approvals-restart.json')
  writeFileSync(staged, JSON.stringify({
    'req-pending': { requestId: 'req-pending', conversationId: 'conv-bob', tool: 'fjsp_publish', risk: 'HIGH_RISK', argsDigest: 'a'.repeat(64), argsSummary: 'x', bizObject: null, requiredRoles: ['ADMIN'], createdAt: 1, expiresAt: Date.now() + 60_000, status: 'pending' },
    'req-approved': { requestId: 'req-approved', conversationId: 'conv-bob', tool: 'fjsp_publish', risk: 'HIGH_RISK', argsDigest: 'b'.repeat(64), argsSummary: 'y', bizObject: null, requiredRoles: ['ADMIN'], createdAt: 1, expiresAt: 2, status: 'approved' },
  }))
  const converted: string[] = []
  const loaded = bff.loadApprovalsFromFile(staged, (r) => converted.push(r.requestId))
  assert.equal(loaded.length, 2)
  assert.deepEqual(converted, ['req-pending'], 'pending 记录应被转换')
  assert.equal(loaded.find((r) => r.requestId === 'req-pending')!.status, 'expired', '重启后遗留 pending 一律 expired（不回放）')
  assert.equal(loaded.find((r) => r.requestId === 'req-approved')!.status, 'approved', '已裁决记录状态原样恢复')
  ok('重启恢复：遗留 pending → expired（旧批准不回放），已裁决状态原样保留')

  // 11. 审计：登记审批的批准/拒绝/过期/越权查询均落 JSONL
  const lines = auditLines()
  const byReq = (id: string) => lines.filter((l) => l.requestId === id).map((l) => l.result)
  assert.ok(byReq(rec.requestId).includes('approved'), '批准应落审计')
  assert.ok(byReq(regAlice.data.approval.requestId).includes('forbidden'), '越权批准应落审计')
  assert.ok(byReq(regAlice.data.approval.requestId).includes('rejected'), '拒绝应落审计')
  assert.ok(byReq(regExp.data.approval.requestId).includes('expired'), '惰性过期应落审计')
  const crossAudit = lines.find((l) => l.by === 'alice' && l.result === 'forbidden' && l.requestId === rec.requestId)
  assert.ok(crossAudit && /归属/.test(crossAudit.detail), '跨用户查询应记 forbidden 审计')
  ok(`审计 JSONL ${lines.length} 条：批准/拒绝/过期/越权查询齐全`)

  console.log(`\nPASS ${passed} 组断言全部通过`)
  process.exitCode = 0
} catch (err) {
  console.error('FAIL:', err)
  process.exitCode = 1
} finally {
  mockAuth.close()
  mockHub.close()
  rmSync(tmp, { recursive: true, force: true })
  // 本进程内 import 的 BFF 仍在监听，直接退出
  setTimeout(() => process.exit(process.exitCode ?? 0), 200)
}

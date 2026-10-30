// test-auth: agent-bff 鉴权与会话归属的脚本级测试（P0：BFF 身份验证 + 会话绑定用户）。
// 起两个隔离实例：mock business-service（只实现 /auth/me 内检）+ 独立 BFF（14178），
// BFF 的存储/session-id/daemon owner 文件全部指向临时目录，不触碰正在运行的真实服务。
// 覆盖：无 token → 401；伪造/过期 token → 401；跨用户访问会话 → 403；legacy（无属主）
// 历史会话 → 403；SSE ticket 换票与建连；公开端点（health、panel、grid）不要求鉴权；
// 已授权请求能穿过鉴权到达业务逻辑（daemon 缺席时 chat 返回 503 而非 401/403）。
//
// 运行：node test-auth.mjs   （在 agh-integration/agent-bff/ 目录下）
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MOCK_PORT = 18099
const HUB_PORT = 18100
const BFF_PORT = 14178
const BFF = `http://127.0.0.1:${BFF_PORT}/agent-api`

const USERS = {
  'tok-alice': { username: 'alice', role: 'DISPATCHER', displayName: '调度员A' },
  'tok-bob': { username: 'bob', role: 'REVIEWER', displayName: '审核员B' },
  // tok-expired / 其他任意 token：mock 一律 401，等价于过期或伪造
}

const tmp = mkdtempSync(join(tmpdir(), 'bff-auth-test-'))
// 预置旧格式（id → sessionId 字符串）存储：无属主，应按 legacy 拒绝
writeFileSync(join(tmp, 'store.json'), JSON.stringify({ 'legacy-conv': 'sess-old' }))

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

// 静默 WS hub：完成握手后不说话（mhs 握手 RPC 超时后走既有重连路径；
// 不能用死端口——mhs.mts 在 ECONNREFUSED 时 error→close 递归导致栈溢出，与本任务无关）
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

const tsx = new URL('../agnes-harness/node_modules/.bin/tsx', import.meta.url).pathname
const serverMts = new URL('./server.mts', import.meta.url).pathname
const bff = spawn(tsx, [serverMts], {
  env: {
    ...process.env,
    AGENT_BFF_PORT: String(BFF_PORT),
    AGENT_BFF_HOST: '127.0.0.1',
    FJSP_API_BASE: `http://127.0.0.1:${MOCK_PORT}/api/v1`,
    AGENT_BFF_STORE_FILE: join(tmp, 'store.json'),
    AGENT_BFF_SESSION_ID_FILE: join(tmp, 'session-id'),
    AGH_OWNER_FILE: join(tmp, 'owner.json'), // 不存在 → daemon absent，chat 走到 503
    AGNES_HUB_URL: `ws://127.0.0.1:${HUB_PORT}/ws/hub`, // mock hub，不连真实 MHS
  },
  stdio: ['ignore', 'pipe', 'inherit'],
})
bff.stdout.on('data', (chunk) => process.stdout.write(`[bff] ${chunk}`))

async function api(method, path, { token, body, raw } = {}) {
  const res = await fetch(BFF + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (raw) return res
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

let passed = 0
function ok(name) { passed += 1; console.log(`ok ${passed} - ${name}`) }

try {
  await new Promise((resolve) => mockAuth.listen(MOCK_PORT, '127.0.0.1', resolve))
  await new Promise((resolve) => mockHub.listen(HUB_PORT, '127.0.0.1', resolve))
  await waitReady()

  // 1. 公开端点：健康检查无需鉴权
  const health = await api('GET', '/health')
  assert.equal(health.status, 200)
  assert.equal(health.data.daemon, 'absent') // AGH_OWNER_FILE 指向不存在路径
  ok('health 公开（200，无 token）')

  // 2. 无 token → 401
  for (const [method, path, body] of [
    ['POST', '/chat', { message: 'hi' }],
    ['POST', '/cancel', { conversationId: 'x' }],
    ['POST', '/permission', { conversationId: 'x', requestId: 'y', verdict: 'rejected' }],
    ['POST', '/stream-ticket', {}],
    ['GET', '/twin/snapshot'],
    ['GET', '/stream?conversationId=x'],
    ['GET', '/twin/stream'],
    ['POST', '/rag/experience-query', {}],
  ]) {
    const r = await api(method, path, { body })
    assert.equal(r.status, 401, `${method} ${path} 应为 401，实际 ${r.status}`)
    assert.equal(r.data.error, 'unauthorized')
  }
  ok('无 token：chat/cancel/permission/stream-ticket/snapshot/stream/twin-stream/rag 全部 401')

  // 3. 伪造 token → 401；过期 token → 401（mock 对未知 token 一律 401）
  for (const token of ['tok-forged', 'tok-expired']) {
    const r = await api('POST', '/chat', { token, body: { message: 'hi' } })
    assert.equal(r.status, 401, `${token} 应为 401，实际 ${r.status}`)
  }
  ok('伪造/过期 token → 401')

  // 4. 换票 + SSE 建连（alice 创建会话 conv-a 并绑定属主）
  const badTicketStream = await api('GET', '/stream?conversationId=conv-a&ticket=bogus', { raw: true })
  assert.equal(badTicketStream.status, 401)
  const t1 = await api('POST', '/stream-ticket', { token: 'tok-alice' })
  assert.equal(t1.status, 200)
  assert.ok(t1.data.ticket)
  // ticket 不能续票（ticket 出现在 URL，泄露面大）
  const remint = await api('POST', `/stream-ticket?ticket=${encodeURIComponent(t1.data.ticket)}`, { body: {} })
  assert.equal(remint.status, 401)
  ok('换票：仅接受 Bearer JWT，ticket 续票 401')
  const sse = await api('GET', `/stream?conversationId=conv-a&ticket=${encodeURIComponent(t1.data.ticket)}`, { raw: true })
  assert.equal(sse.status, 200)
  assert.match(sse.headers.get('content-type'), /text\/event-stream/)
  const reader = sse.body.getReader()
  const firstFrame = await reader.read().then((r) => Buffer.from(r.value).toString('utf8'))
  assert.match(firstFrame, /: conversation conv-a/)
  await reader.cancel()
  ok('SSE：坏 ticket 401；alice 换票建连成功（conv-a 归属 alice）')

  // 5. 已授权请求穿过鉴权到达业务逻辑：daemon 缺席 → 503 而非 401/403
  const chatAlice = await api('POST', '/chat', { token: 'tok-alice', body: { conversationId: 'conv-a', message: 'hi' } })
  assert.equal(chatAlice.status, 503, JSON.stringify(chatAlice.data))
  assert.equal(chatAlice.data.error, 'daemon_unavailable')
  ok('alice 对自己的会话发消息：通过鉴权，daemon 缺席返回 503')

  // 6. 跨用户访问 → 403
  const t2 = await api('POST', '/stream-ticket', { token: 'tok-bob' })
  const chatBob = await api('POST', '/chat', { token: 'tok-bob', body: { conversationId: 'conv-a', message: 'hi' } })
  assert.equal(chatBob.status, 403)
  assert.equal(chatBob.data.error, 'conversation_forbidden')
  const streamBob = await api('GET', `/stream?conversationId=conv-a&ticket=${encodeURIComponent(t2.data.ticket)}`, { raw: true })
  assert.equal(streamBob.status, 403)
  streamBob.body?.cancel()
  const cancelBob = await api('POST', '/cancel', { token: 'tok-bob', body: { conversationId: 'conv-a' } })
  assert.equal(cancelBob.status, 403)
  ok('bob 访问 alice 的会话：chat/stream/cancel 全部 403 conversation_forbidden')

  // 7. 属主本人 cancel：会话无 daemon session → 404（归属校验先于存在性之后通过）
  const cancelAlice = await api('POST', '/cancel', { token: 'tok-alice', body: { conversationId: 'conv-a' } })
  assert.equal(cancelAlice.status, 404)
  assert.equal(cancelAlice.data.error, 'conversation_not_found')
  ok('alice cancel 自己的会话：归属通过，无活动会话 404')

  // 8. legacy 会话（旧格式存储、无属主）→ 任何人 403
  const legacyStream = await api('GET', `/stream?conversationId=legacy-conv&ticket=${encodeURIComponent(t1.data.ticket)}`, { raw: true })
  assert.equal(legacyStream.status, 403)
  legacyStream.body?.cancel()
  const legacyChat = await api('POST', '/chat', { token: 'tok-alice', body: { conversationId: 'legacy-conv', message: 'hi' } })
  assert.equal(legacyChat.status, 403)
  assert.equal(legacyChat.data.error, 'conversation_legacy')
  ok('legacy 历史会话：stream/chat 均 403 conversation_legacy')

  // 9. 已授权 twin/rag 读路径可用
  const snap = await api('GET', '/twin/snapshot', { token: 'tok-alice' })
  assert.equal(snap.status, 200)
  const rag = await api('POST', '/rag/experience-query', { token: 'tok-bob', body: { limit: 1 } })
  assert.equal(rag.status, 200)
  ok('授权用户：twin/snapshot 200、rag/experience-query 200')

  // 10. panel/grid 图片端点保持公开（<img> 无法带请求头）：无 token 不应 401
  for (const path of ['/twin/grid', '/twin/device/cnc-m01/panel']) {
    const r = await api('GET', path, { raw: true })
    assert.notEqual(r.status, 401, `${path} 不应要求鉴权`)
    r.body?.cancel()
  }
  ok('panel/grid 图片端点公开（无 token 不返回 401）')

  console.log(`\nPASS ${passed} 组断言全部通过`)
  process.exitCode = 0
} catch (err) {
  console.error('FAIL:', err)
  process.exitCode = 1
} finally {
  bff.kill()
  mockAuth.close()
  mockHub.close()
  rmSync(tmp, { recursive: true, force: true })
}

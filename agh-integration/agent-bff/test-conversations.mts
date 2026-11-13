// test-conversations: 多会话列表 / 重命名 / 删除端点（属主隔离、进行中保护、持久化合并）。
// 隔离方式同 test-approval-status：mock business-service /auth/me + 静默 WS hub，BFF 本进程 import。
// 运行：../agnes-harness/node_modules/.bin/tsx test-conversations.mts（在 agh-integration/agent-bff/ 目录下）
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MOCK_PORT = 18112
const HUB_PORT = 18111
const BFF_PORT = 14191
const BFF = `http://127.0.0.1:${BFF_PORT}/agent-api`
const USERS: Record<string, { username: string; role: string; displayName: string }> = {
  'tok-alice': { username: 'alice', role: 'DISPATCHER', displayName: '调度员A' },
  'tok-bob': { username: 'bob', role: 'REVIEWER', displayName: '审核员B' },
}
const tmp = mkdtempSync(join(tmpdir(), 'bff-conversations-test-'))
// 预置：alice 两个历史会话（一个旧格式无标题）、bob 一个、legacy 一个
writeFileSync(join(tmp, 'store.json'), JSON.stringify({
  'conv-a1': { sessionId: 's1', owner: 'alice', title: '基线排程', createdAt: 1000, updatedAt: 5000 },
  'conv-a2': { sessionId: 's2', owner: 'alice' },
  'conv-b1': { sessionId: 's3', owner: 'bob', title: 'bob 的会话', createdAt: 1, updatedAt: 9000 },
  'conv-legacy': 'sess-old',
}))

const mockAuth = createServer((req, res) => {
  if (req.url === '/api/v1/auth/me') {
    const user = USERS[(req.headers.authorization ?? '').replace(/^Bearer /, '')]
    res.writeHead(user ? 200 : 401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(user ? { code: 'OK', data: user } : { code: 'E_UNAUTHORIZED', data: null }))
    return
  }
  res.writeHead(404).end()
})
const mockHub = createServer()
mockHub.on('upgrade', (req, socket) => {
  const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
})

process.env.AGENT_BFF_PORT = String(BFF_PORT)
process.env.AGENT_BFF_HOST = '127.0.0.1'
process.env.FJSP_API_BASE = `http://127.0.0.1:${MOCK_PORT}/api/v1`
process.env.AGENT_BFF_STORE_FILE = join(tmp, 'store.json')
process.env.AGENT_BFF_SESSION_ID_FILE = join(tmp, 'session-id')
process.env.AGENT_BFF_AUDIT_FILE = join(tmp, 'audit.jsonl')
process.env.AGENT_BFF_APPROVALS_FILE = join(tmp, 'approvals.json')
process.env.AGH_OWNER_FILE = join(tmp, 'owner.json')
process.env.AGNES_HUB_URL = `ws://127.0.0.1:${HUB_PORT}/ws/hub`

await new Promise<void>((r) => mockAuth.listen(MOCK_PORT, '127.0.0.1', r))
await new Promise<void>((r) => mockHub.listen(HUB_PORT, '127.0.0.1', r))
const bff = await import('./server.mts')

async function api(method: string, path: string, { token, body }: { token?: string; body?: unknown } = {}) {
  const res = await fetch(BFF + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, data: await res.json().catch(() => ({})) }
}
async function waitReady() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BFF}/health`)).status === 200) return } catch { /* 未起来 */ }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('BFF 未在 10s 内就绪')
}
const store = () => JSON.parse(readFileSync(join(tmp, 'store.json'), 'utf8'))
let passed = 0
function ok(name: string) { passed += 1; console.log(`ok ${passed} - ${name}`) }
try {
  await waitReady()

  // 1. 未认证 401；属主隔离：alice 只看到自己的两个会话，按 updatedAt 倒序，旧格式无标题回退"未命名会话"
  assert.equal((await api('GET', '/conversations')).status, 401)
  const listA = await api('GET', '/conversations', { token: 'tok-alice' })
  assert.equal(listA.status, 200, JSON.stringify(listA.data))
  assert.deepEqual(listA.data.conversations.map((c: { id: string }) => c.id), ['conv-a1', 'conv-a2'])
  assert.equal(listA.data.conversations[0].title, '基线排程')
  assert.equal(listA.data.conversations[1].title, '未命名会话')
  assert.equal(listA.data.conversations[0].running, false)
  assert.equal(listA.data.conversations[0].pendingApprovals, 0)
  ok('GET /conversations：401 / 属主隔离 / 最近活动倒序 / 缺标题回退')

  // 2. 只建未发言的空会话不进列表
  bff.conversations.set('conv-empty', { ...bff.conversations.get('conv-a1') ?? {}, id: 'conv-empty', owner: 'alice', title: null, sessionId: null, session: null, starting: null, pumping: false, busy: false, lastEventId: 0, buffer: [], subscribers: new Set(), pendingPermissions: new Map(), createdAt: Date.now(), updatedAt: Date.now() } as never)
  const listEmpty = await api('GET', '/conversations', { token: 'tok-alice' })
  assert.ok(!listEmpty.data.conversations.some((c: { id: string }) => c.id === 'conv-empty'), '空会话不应出现在列表')
  ok('空会话（无标题无 AGH 会话）不进列表')

  // 3. 重命名：属主 200 并持久化；跨用户 403；空标题/超长 400；未知 404；legacy 403
  const ren = await api('POST', '/conversations/conv-a2/rename', { token: 'tok-alice', body: { title: '  M-03 故障处置  ' } })
  assert.equal(ren.status, 200, JSON.stringify(ren.data))
  assert.equal(ren.data.title, 'M-03 故障处置')
  assert.equal(store()['conv-a2'].title, 'M-03 故障处置')
  assert.equal(store()['conv-b1'].title, 'bob 的会话', '保存时不得丢掉未加载到内存的其他会话')
  assert.equal((await api('POST', '/conversations/conv-b1/rename', { token: 'tok-alice', body: { title: 'x' } })).status, 403)
  assert.equal((await api('POST', '/conversations/conv-a2/rename', { token: 'tok-alice', body: { title: '   ' } })).status, 400)
  assert.equal((await api('POST', '/conversations/conv-a2/rename', { token: 'tok-alice', body: { title: '长'.repeat(61) } })).status, 400)
  assert.equal((await api('POST', '/conversations/conv-nope/rename', { token: 'tok-alice', body: { title: 'x' } })).status, 404)
  assert.equal((await api('POST', '/conversations/conv-legacy/rename', { token: 'tok-alice', body: { title: 'x' } })).status, 403)
  ok('POST rename：属主 200 持久化（不丢其他会话）/ 跨用户 403 / 非法标题 400 / 未知 404 / legacy 403')

  // 4. 删除：进行中 409；跨用户 403；属主删除后不在列表、不在存储，快照 404
  // conv-a1 只在磁盘上：先经重命名把它载入内存，再模拟进行中
  assert.equal((await api('POST', '/conversations/conv-a1/rename', { token: 'tok-alice', body: { title: '基线排程' } })).status, 200)
  bff.conversations.get('conv-a1')!.busy = true
  const busyDel = await api('POST', '/conversations/conv-a1/delete', { token: 'tok-alice', body: {} })
  assert.equal(busyDel.status, 409)
  assert.equal(busyDel.data.error, 'conversation_active')
  bff.conversations.get('conv-a1')!.busy = false
  assert.equal((await api('POST', '/conversations/conv-b1/delete', { token: 'tok-alice', body: {} })).status, 403)
  const del = await api('POST', '/conversations/conv-a1/delete', { token: 'tok-alice', body: {} })
  assert.equal(del.status, 200, JSON.stringify(del.data))
  assert.equal(store()['conv-a1'], undefined)
  assert.ok(store()['conv-b1'], 'bob 的会话保留')
  const after = await api('GET', '/conversations', { token: 'tok-alice' })
  assert.deepEqual(after.data.conversations.map((c: { id: string }) => c.id), ['conv-a2'])
  assert.equal((await api('GET', '/conversations/conv-a1/snapshot', { token: 'tok-alice' })).status, 404)
  ok('POST delete：进行中 409 / 跨用户 403 / 删除后列表与存储移除、快照 404')

  // 5. 有待审批的会话不可删除（审批记录需要会话属主可查）
  const reg = await api('POST', '/approvals', { token: 'tok-alice', body: { conversationId: 'conv-a2', toolCall: { name: 'fjsp_publish', args: { planVersionId: 'PV-1' } } } })
  assert.equal(reg.status, 202, JSON.stringify(reg.data))
  const list2 = await api('GET', '/conversations', { token: 'tok-alice' })
  assert.equal(list2.data.conversations[0].pendingApprovals, 1)
  assert.equal((await api('POST', '/conversations/conv-a2/delete', { token: 'tok-alice', body: {} })).status, 409)
  ok('有待审批：列表显示待审批数，删除 409')

  // 6. 标题生成：剥掉 formatContext 前缀、压单行、按字截断
  assert.equal(bff.conversationTitleFrom('[操作员上下文 — 当前页面：计划调度 / 基线排程。回答中如需引用页面元素，请使用该上下文。]\n\n帮我做一次基线排程'), '帮我做一次基线排程')
  assert.equal(bff.conversationTitleFrom('  第一行\n第二行  '), '第一行 第二行')
  assert.equal(bff.conversationTitleFrom('长'.repeat(40)), '长'.repeat(28) + '…')
  ok('标题生成：剥上下文前缀 / 压单行 / 28 字截断')

  console.log(`\nPASS ${passed} 组断言全部通过`)
  process.exitCode = 0
} catch (err) {
  console.error('FAIL:', err)
  process.exitCode = 1
} finally {
  mockAuth.close()
  mockHub.close()
  rmSync(tmp, { recursive: true, force: true })
  setTimeout(() => process.exit(process.exitCode ?? 0), 200)
}

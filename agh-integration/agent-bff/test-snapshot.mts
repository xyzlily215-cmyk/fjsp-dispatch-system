// test-snapshot: agent-bff 会话快照与断线恢复测试（任务 4.1）。
// 与 test-contract-api.mts 同一隔离思路：mock business-service（只实现 /auth/me 内检）
// + 静默 WS hub + tsx spawn 独立端口 BFF；存储/审计/审批文件全部指向临时目录，
// 不触碰正在运行的真实服务。AGH daemon 缺席（owner.json 不存在）→ 快照消息重建走
// messagesComplete 退化路径；窗口越界路径用 AGENT_BFF_BUFFER_CAP=3 缩小缓冲构造。
//
// 覆盖：
//   1. 鉴权与归属：未认证 401 / 未知会话 404 / 跨用户 403 / legacy 会话 403。
//   2. 快照字段完整：ok/conversationId/sessionId/running/lastEventId/replayFrom/
//      messages/messagesComplete/pendingApprovals（五要素摘要齐全）。
//   3. 快照-订阅衔接：快照后以 sinceId=lastEventId 订阅，只收到快照后的新事件
//      （不漏不重）；sinceId 出回放缓冲窗口时先收 resync_required 再关闭。
//   4. 审批有效性：过期的审批不进 pendingApprovals，裁决 410；已裁决的不进
//      pendingApprovals，重复裁决 409。
//   5. 模拟重启重建：杀掉实例 A，用同一临时目录起实例 B——会话自存储重建归属、
//      遗留 pending 审批重启即 expired（审计留痕）、不进快照、裁决 409/410。
//
// 运行：../agnes-harness/node_modules/.bin/tsx test-snapshot.mts（在 agh-integration/agent-bff/ 目录下）
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MOCK_PORT = 18106
const HUB_PORT = 18105
const BFF_PORT_A = 14182
const BFF_PORT_B = 14183
const APPROVAL_TTL_MS = 1500

const USERS: Record<string, { username: string; role: string; displayName: string }> = {
  'tok-alice': { username: 'alice', role: 'DISPATCHER', displayName: '调度员A' },
  'tok-bob': { username: 'bob', role: 'REVIEWER', displayName: '审核员B' },
}

const tmp = mkdtempSync(join(tmpdir(), 'bff-snapshot-test-'))
// 预置持久化会话存储：conv-legacy 为旧格式（无属主 → legacy）；conv-bob 由测试 2 的
// 登记路径在内存中建立（POST /approvals 不落 saveStore，重启测试 5 会补写 bob 条目）
writeFileSync(join(tmp, 'store.json'), JSON.stringify({ 'conv-legacy': 'sess-old' }))

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

// 静默 WS hub（同 test-auth：不能用死端口，mhs.mts ECONNREFUSED 递归会栈溢出）
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

function startBff(port: number): ChildProcess {
  const bff = spawn(tsx, [serverMts], {
    env: {
      ...process.env,
      AGENT_BFF_PORT: String(port),
      AGENT_BFF_HOST: '127.0.0.1',
      FJSP_API_BASE: `http://127.0.0.1:${MOCK_PORT}/api/v1`,
      AGENT_BFF_STORE_FILE: join(tmp, 'store.json'),
      AGENT_BFF_SESSION_ID_FILE: join(tmp, 'session-id'),
      AGH_OWNER_FILE: join(tmp, 'owner.json'), // 不存在 → daemon absent
      AGNES_HUB_URL: `ws://127.0.0.1:${HUB_PORT}/ws/hub`,
      AGENT_BFF_AUDIT_FILE: join(tmp, 'audit.jsonl'),
      AGENT_BFF_APPROVALS_FILE: join(tmp, 'approvals.json'),
      AGENT_BFF_APPROVAL_TTL_MS: String(APPROVAL_TTL_MS),
      AGENT_BFF_BUFFER_CAP: '3', // 缩小回放缓冲，构造 sinceId 越窗路径
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  bff.stdout?.on('data', (chunk) => process.stdout.write(`[bff:${port}] ${chunk}`))
  return bff
}

let BFF = `http://127.0.0.1:${BFF_PORT_A}/agent-api`

async function api(method: string, path: string, opts: { token?: string; body?: unknown; raw?: boolean } = {}) {
  const res = await fetch(BFF + path, {
    method,
    headers: {
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
  if (opts.raw) return res
  return { status: res.status, data: await res.json().catch(() => ({} as Record<string, unknown>)) }
}

async function waitReady(port: number) {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/agent-api/health`)
      if (res.status === 200) return
    } catch { /* 未起来 */ }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`BFF(:${port}) 未在 10s 内就绪`)
}

/** 收集 SSE 帧直到满足条件或超时；返回 [{id, event, data}]。 */
async function collectSse(path: string, done: (frames: { id: number | null; event: string; data: string }[]) => boolean, timeoutMs = 5000) {
  const res = await api('GET', path, { raw: true }) as Response
  assert.equal(res.status, 200, `SSE 连接应 200，实际 ${res.status}`)
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const frames: { id: number | null; event: string; data: string }[] = []
  const deadline = Date.now() + timeoutMs
  try {
    while (Date.now() < deadline) {
      const { value, done: eof } = await reader.read()
      if (eof) break
      buf += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        if (raw.startsWith(':')) continue // 注释帧（会话横幅/心跳）
        const frame: { id: number | null; event: string; data: string } = { id: null, event: '', data: '' }
        for (const line of raw.split('\n')) {
          if (line.startsWith('id: ')) frame.id = Number(line.slice(4))
          else if (line.startsWith('event: ')) frame.event = line.slice(7)
          else if (line.startsWith('data: ')) frame.data = line.slice(6)
        }
        frames.push(frame)
      }
      if (done(frames)) return { frames, closed: false }
    }
    return { frames, closed: false }
  } finally {
    reader.cancel().catch(() => {})
  }
}

function auditLines() {
  try {
    return readFileSync(join(tmp, 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

let passed = 0
function ok(name: string) { passed += 1; console.log(`ok ${passed} - ${name}`) }

let bffA: ChildProcess | null = null
let bffB: ChildProcess | null = null

try {
  await new Promise<void>((resolve) => mockAuth.listen(MOCK_PORT, '127.0.0.1', resolve))
  await new Promise<void>((resolve) => mockHub.listen(HUB_PORT, '127.0.0.1', resolve))
  bffA = startBff(BFF_PORT_A)
  await waitReady(BFF_PORT_A)

  // 1. 鉴权与归属
  const noAuth = await api('GET', '/conversations/conv-bob/snapshot')
  assert.equal(noAuth.status, 401)
  const unknown = await api('GET', '/conversations/conv-nobody/snapshot', { token: 'tok-bob' })
  assert.equal(unknown.status, 404)
  assert.equal(unknown.data.error, 'conversation_not_found')
  const legacy = await api('GET', '/conversations/conv-legacy/snapshot', { token: 'tok-bob' })
  assert.equal(legacy.status, 403)
  assert.equal(legacy.data.error, 'conversation_legacy')
  ok('快照鉴权：未认证 401 / 未知会话 404 / legacy 会话 403')

  // 2. bob 登记审批（fjsp_approve_review，HIGH_RISK）建立会话 + 一条待审批
  const reg1 = await api('POST', '/approvals', {
    token: 'tok-bob',
    body: { conversationId: 'conv-bob', toolCall: { name: 'fjsp_approve_review', args: { planVersionId: 'PV-21' } } },
  })
  assert.equal(reg1.status, 202, JSON.stringify(reg1.data))
  const rec1 = reg1.data.approval
  const cross = await api('GET', '/conversations/conv-bob/snapshot', { token: 'tok-alice' })
  assert.equal(cross.status, 403)
  assert.equal(cross.data.error, 'conversation_forbidden')
  ok('快照归属：跨用户查询 → 403 conversation_forbidden')

  // 3. 快照字段完整
  const snap1 = await api('GET', '/conversations/conv-bob/snapshot', { token: 'tok-bob' })
  assert.equal(snap1.status, 200, JSON.stringify(snap1.data))
  const s1 = snap1.data
  assert.equal(s1.ok, true)
  assert.equal(s1.conversationId, 'conv-bob')
  assert.equal(s1.sessionId, null, 'daemon 缺席，无 sessionId')
  assert.equal(s1.running, false)
  assert.equal(typeof s1.lastEventId, 'number')
  assert.ok(s1.lastEventId >= 1, '登记审批已广播一条 permission_request')
  assert.equal(s1.replayFrom, 0)
  assert.ok(Array.isArray(s1.messages))
  assert.equal(s1.messagesComplete, true, '会话从未建立（无 sessionId），空消息即完整')
  assert.ok(Array.isArray(s1.pendingApprovals))
  const pa1 = s1.pendingApprovals.find((a: { requestId: string }) => a.requestId === rec1.requestId)
  assert.ok(pa1, '快照应含仍有效的待审批')
  assert.equal(pa1.status, 'pending')
  assert.equal(pa1.tool, 'fjsp_approve_review')
  assert.deepEqual(pa1.requiredRoles, ['REVIEWER', 'ADMIN'])
  assert.deepEqual(pa1.bizObject, { planVersionId: 'PV-21' })
  ok('快照字段完整：lastEventId/replayFrom/messages/messagesComplete/pendingApprovals（五要素）')

  // 4. 快照-订阅衔接：快照时刻 lastEventId=L，登记新审批（事件 L+1），以 sinceId=L 订阅
  //    应只收到新事件——不漏（L+1 到达）不重（无 id ≤ L 的重放）。
  const L = s1.lastEventId as number
  const ticketBob = await api('POST', '/stream-ticket', { token: 'tok-bob' })
  assert.equal(ticketBob.status, 200)
  const ticket = ticketBob.data.ticket as string
  const reg2Promise = api('POST', '/approvals', {
    token: 'tok-bob',
    body: { conversationId: 'conv-bob', toolCall: { name: 'fjsp_publish', args: { planVersionId: 'PV-22' } } },
  })
  const seam = await collectSse(
    `/stream?conversationId=conv-bob&ticket=${encodeURIComponent(ticket)}&sinceId=${L}`,
    (frames) => frames.some((f) => f.id !== null && f.id > L),
  )
  const reg2 = await reg2Promise
  assert.equal(reg2.status, 202)
  const replayed = seam.frames.filter((f) => f.event)
  assert.ok(replayed.length >= 1, '应收到快照后的新事件')
  assert.ok(replayed.every((f) => f.id !== null && f.id > L), '衔接：不重放 id ≤ lastEventId 的旧事件')
  const newCard = replayed.find((f) => f.event === 'permission_request' && JSON.parse(f.data).requestId === reg2.data.approval.requestId)
  assert.ok(newCard, '衔接：快照到订阅之间的新事件不丢')
  assert.equal(newCard!.id, L + 1, '新事件序号紧接快照 lastEventId')
  ok('快照-订阅衔接：sinceId=lastEventId 只收新事件（不漏不重，序号紧接）')

  // 5. sinceId 已出回放缓冲窗口：BUFFER_CAP=3，当前 buffer 只留最近 3 条。
  //    再登记若干审批把事件 1..L+1 挤出窗口，然后以越窗 sinceId 订阅 → resync_required。
  for (let i = 0; i < 4; i++) {
    const r = await api('POST', '/approvals', {
      token: 'tok-bob',
      body: { conversationId: 'conv-bob', toolCall: { name: 'fjsp_publish', args: { planVersionId: `PV-3${i}` } } },
    })
    assert.equal(r.status, 202)
  }
  const snap2 = await api('GET', '/conversations/conv-bob/snapshot', { token: 'tok-bob' })
  const floor = snap2.data.replayFrom as number
  assert.ok(floor > 0, `窗口已滑动，replayFrom=${floor} 应 > 0`)
  assert.equal(snap2.data.lastEventId, floor + 3, '缓冲满窗口：lastEventId = replayFrom + 容量')
  const resync = await collectSse(
    `/stream?conversationId=conv-bob&ticket=${encodeURIComponent(ticket)}&sinceId=${floor - 1}`,
    (frames) => frames.some((f) => f.event === 'resync_required'),
  )
  const resyncFrame = resync.frames.find((f) => f.event === 'resync_required')
  assert.ok(resyncFrame, '越窗订阅应收到 resync_required')
  assert.equal(JSON.parse(resyncFrame!.data).lastEventId, snap2.data.lastEventId)
  assert.equal(resyncFrame!.id, null, '控制帧不占会话事件序号')
  assert.ok(!resync.frames.some((f) => f.id !== null), '越窗订阅不得重放任何缓冲事件')
  // 边界：sinceId = replayFrom 恰好可用（不 < floor），应正常回放最近窗口
  const atFloor = await collectSse(
    `/stream?conversationId=conv-bob&ticket=${encodeURIComponent(ticket)}&sinceId=${floor}`,
    (frames) => frames.filter((f) => f.id !== null).length >= 3,
  )
  const atFloorEvents = atFloor.frames.filter((f) => f.id !== null)
  assert.equal(atFloorEvents.length, 3, 'sinceId=replayFrom 应回放窗口内全部 3 条')
  assert.ok(atFloorEvents.every((f) => f.id! > floor))
  ok('窗口越界：sinceId<replayFrom → resync_required 控制帧后关闭；边界值正常回放')

  // 6. 审批有效性：先在 TTL 内裁决 rec2（拒绝 202，重复裁决 409，不进快照）；
  //    再等 rec1 超 TTL → 快照惰性过期核销，不进 pendingApprovals，GET 报 expired，
  //    裁决拒绝（已被读取核销走 409；未核销的过期裁决 410 由 test-approval-status 覆盖）。
  // rec2 由属主 bob（REVIEWER ∈ fjsp_publish 所需 [PRODUCTION_MANAGER, ADMIN]？否——用拒绝路径规避角色闸）
  const reject2 = await api('POST', '/permission', {
    token: 'tok-bob',
    body: { conversationId: 'conv-bob', requestId: reg2.data.approval.requestId, verdict: 'rejected' },
  })
  assert.equal(reject2.status, 202, JSON.stringify(reject2.data))
  const dup2 = await api('POST', '/permission', {
    token: 'tok-bob',
    body: { conversationId: 'conv-bob', requestId: reg2.data.approval.requestId, verdict: 'rejected' },
  })
  assert.equal(dup2.status, 409)
  const snap3 = await api('GET', '/conversations/conv-bob/snapshot', { token: 'tok-bob' })
  assert.ok(!snap3.data.pendingApprovals.some((a: { requestId: string }) => a.requestId === reg2.data.approval.requestId),
    '已裁决审批不得出现在快照待批准列表')
  const waitMs = rec1.expiresAt + 100 - Date.now()
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs))
  const snap4 = await api('GET', '/conversations/conv-bob/snapshot', { token: 'tok-bob' })
  assert.ok(!snap4.data.pendingApprovals.some((a: { requestId: string }) => a.requestId === rec1.requestId),
    '过期审批不得出现在快照待批准列表')
  const getRec1 = await api('GET', `/approvals/${rec1.requestId}`, { token: 'tok-bob' })
  assert.equal(getRec1.data.approval.status, 'expired')
  const lateDecide = await api('POST', '/permission', {
    token: 'tok-bob',
    body: { conversationId: 'conv-bob', requestId: rec1.requestId, verdict: 'allowed-once' },
  })
  assert.ok([409, 410].includes(lateDecide.status), `过期审批裁决应拒绝（409/410），实际 ${lateDecide.status}`)
  ok('审批有效性：已裁决不进快照+重复裁决 409；过期不进快照（惰性核销）+裁决拒绝 409/410')

  // 7. 模拟重启重建：杀掉实例 A；补写 conv-bob 的持久化会话条目（真实运行中由
  //    ensureSession 的 saveStore 落盘；daemon 缺席的测试环境手工补写等价形态），
  //    再往 approvals.json 注入一条"重启前仍 pending"的记录，起实例 B：
  //    归属自存储重建、遗留 pending 重启即 expired（审计留痕）、不进快照、裁决 409。
  bffA.kill()
  bffA = null
  const store = JSON.parse(readFileSync(join(tmp, 'store.json'), 'utf8'))
  store['conv-bob'] = { sessionId: null, owner: 'bob' }
  writeFileSync(join(tmp, 'store.json'), JSON.stringify(store, null, 2))
  const stagedApprovals = JSON.parse(readFileSync(join(tmp, 'approvals.json'), 'utf8'))
  stagedApprovals['req-survivor'] = {
    requestId: 'req-survivor', conversationId: 'conv-bob', tool: 'fjsp_publish', risk: 'HIGH_RISK',
    argsDigest: 'c'.repeat(64), argsSummary: 'fjsp_publish {"planVersionId":"PV-99"}',
    bizObject: { planVersionId: 'PV-99' }, requiredRoles: ['PRODUCTION_MANAGER', 'ADMIN'],
    createdAt: Date.now(), expiresAt: Date.now() + 300_000, status: 'pending',
  }
  writeFileSync(join(tmp, 'approvals.json'), JSON.stringify(stagedApprovals, null, 2))

  BFF = `http://127.0.0.1:${BFF_PORT_B}/agent-api`
  bffB = startBff(BFF_PORT_B)
  await waitReady(BFF_PORT_B)

  const snapB = await api('GET', '/conversations/conv-bob/snapshot', { token: 'tok-bob' })
  assert.equal(snapB.status, 200, JSON.stringify(snapB.data))
  assert.equal(snapB.data.conversationId, 'conv-bob')
  assert.equal(snapB.data.lastEventId, 0, '重启后事件缓冲为空')
  assert.equal(snapB.data.replayFrom, 0)
  assert.ok(!snapB.data.pendingApprovals.some((a: { requestId: string }) => a.requestId === 'req-survivor'),
    '重启后遗留 pending 不得作为可批准项出现')
  const crossB = await api('GET', '/conversations/conv-bob/snapshot', { token: 'tok-alice' })
  assert.equal(crossB.status, 403, '重启后归属自持久化存储重建，跨用户仍 403')
  const legacyB = await api('GET', '/conversations/conv-legacy/snapshot', { token: 'tok-bob' })
  assert.equal(legacyB.status, 403)
  assert.equal(legacyB.data.error, 'conversation_legacy')
  const decideSurvivor = await api('POST', '/permission', {
    token: 'tok-bob',
    body: { conversationId: 'conv-bob', requestId: 'req-survivor', verdict: 'allowed-once' },
  })
  assert.ok([409, 410].includes(decideSurvivor.status), `重启后裁决遗留 pending 应拒绝（409/410），实际 ${decideSurvivor.status}`)
  const restartAudit = auditLines().find((l) => l.requestId === 'req-survivor' && l.result === 'expired' && /重启/.test(l.detail ?? ''))
  assert.ok(restartAudit, '重启转换 pending→expired 应落审计')
  ok('重启重建：会话归属自存储重建、遗留 pending → expired（审计留痕、不进快照、裁决拒绝）')

  console.log(`\nPASS ${passed} 组断言全部通过`)
  process.exitCode = 0
} catch (err) {
  console.error('FAIL:', err)
  process.exitCode = 1
} finally {
  bffA?.kill()
  bffB?.kill()
  mockAuth.close()
  mockHub.close()
  rmSync(tmp, { recursive: true, force: true })
}

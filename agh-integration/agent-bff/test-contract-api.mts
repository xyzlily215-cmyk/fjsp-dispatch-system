// test-contract-api: BFF 共享 API/SSE 契约的契约测试（任务 2.C）。
// 与 test-auth.mjs / test-approval.mts 同一隔离思路：mock business-service（只实现
// /auth/me 内检）+ mock WS hub + 独立端口 BFF（tsx spawn），存储/session-id/owner
// 文件全部指向临时目录，不触碰正在运行的真实服务。
//
// 覆盖四部分：
//   A. SSE 事件契约（单元）：每个事件合法样本通过校验；缺版本字段 v 被拒；未知事件名被拒。
//   B. HTTP 端点契约（集成）：合法请求穿过契约层（到达鉴权/业务逻辑而非 400）；
//      非法请求（缺字段/错类型/非法 JSON）400 invalid_request（chat 的 message 保持
//      既有 message_required 错误码）。fault/sim-start 等会触发真实仿真副作用的端点
//      只测契约拦截路径（400 在副作用之前），合法路径不在本测试调用。
//   C. 前后端一致性：web-vue/src/api/agent.ts 的协议类型必须 import 自契约
//      （不允许两份手写定义）；其运行时事件名清单 STREAM_EVENTS 必须是契约
//      注册表的子集；twin.ts 监听的 'twin' 事件必须在契约中；
//      types.ts ↔ events.mts 字段级对齐（字段名/可选性/可空性，文本级断言，
//      检查边界见 EVENTS.md）。
//   D. OpenAPI 导出：GET /agent-api/openapi.json 200，paths 覆盖契约端点表全量。
//
// 运行：../agnes-harness/node_modules/.bin/tsx test-contract-api.mts（在 agh-integration/agent-bff/ 目录下）
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SSE_EVENTS, validateEvent, withVersion } from './contract/events.mts'
import { HTTP_CONTRACT } from './contract/http.mts'

const MOCK_PORT = 18103
const HUB_PORT = 18104
const BFF_PORT = 14180
const BFF = `http://127.0.0.1:${BFF_PORT}/agent-api`

const USERS: Record<string, { username: string; role: string; displayName: string }> = {
  'tok-alice': { username: 'alice', role: 'DISPATCHER', displayName: '调度员A' },
}

const tmp = mkdtempSync(join(tmpdir(), 'bff-contract-test-'))
writeFileSync(join(tmp, 'store.json'), '{}')

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
const bff = spawn(tsx, [serverMts], {
  env: {
    ...process.env,
    AGENT_BFF_PORT: String(BFF_PORT),
    AGENT_BFF_HOST: '127.0.0.1',
    FJSP_API_BASE: `http://127.0.0.1:${MOCK_PORT}/api/v1`,
    AGENT_BFF_STORE_FILE: join(tmp, 'store.json'),
    AGENT_BFF_SESSION_ID_FILE: join(tmp, 'session-id'),
    AGH_OWNER_FILE: join(tmp, 'owner.json'), // 不存在 → daemon absent
    AGNES_HUB_URL: `ws://127.0.0.1:${HUB_PORT}/ws/hub`,
    AGENT_BFF_AUDIT_FILE: join(tmp, 'audit.jsonl'),
  },
  stdio: ['ignore', 'pipe', 'inherit'],
})
bff.stdout.on('data', (chunk) => process.stdout.write(`[bff] ${chunk}`))

async function api(method: string, path: string, opts: { token?: string; body?: unknown; rawBody?: string; raw?: boolean } = {}) {
  const res = await fetch(BFF + path, {
    method,
    headers: {
      ...(opts.body !== undefined || opts.rawBody !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.rawBody ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  })
  if (opts.raw) return res
  return { status: res.status, data: await res.json().catch(() => ({} as Record<string, unknown>)) }
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
function ok(name: string) { passed += 1; console.log(`ok ${passed} - ${name}`) }

// ---- A. SSE 事件契约（单元，不起服务）----

const EVENT_SAMPLES: Record<string, Record<string, unknown>> = {
  user_message: { text: '你好', context: { section: '工作台', title: '数字孪生车间' } },
  turn_start: {},
  assistant_delta: { delta: '正在', offset: 0 },
  assistant_message: { seq: 3, text: '完整回复' },
  tool_call: { seq: 4, name: 'fjsp_get_plan', args: { planVersionId: 'v1' }, toolUseId: 'tu-1' },
  tool_result: { seq: 5, toolUseId: 'tu-1', code: 'ok', isError: false, text: '{}' },
  permission_request: {
    requestId: 'r-1', toolCall: { name: 'fjsp_publish', args: {} }, options: [],
    deadlineMs: Date.now() + 60_000,
    approval: {
      tool: 'fjsp_publish', risk: 'HIGH_RISK', summary: 'fjsp_publish {}', digest: 'abcdef123456',
      bizObject: { planVersionId: 'v1' }, requiredRoles: ['PRODUCTION_MANAGER', 'ADMIN'], expiresAt: Date.now() + 300_000,
    },
  },
  permission_resolved: { requestId: 'r-1', verdict: { verdict: 'allowed-once' } },
  turn_end: { reason: 'completed', stopReason: 'end_turn' },
  turn_error: { message: 'daemon 断连' },
  stream_closed: {},
  resync_required: { lastEventId: 42 },
  twin: { hub: 'connected', time: 1700000000, devices: [], world: null, sim: { running: false } },
}

function partA() {
  // 每个事件的合法样本（注入版本后）通过校验
  for (const [name, sample] of Object.entries(EVENT_SAMPLES)) {
    assert.ok(SSE_EVENTS[name], `契约注册表缺事件 ${name}`)
    const issues = validateEvent(name, withVersion(name, sample))
    assert.deepEqual(issues, [], `${name} 合法样本应通过：${JSON.stringify(issues)}`)
  }
  ok(`SSE：${Object.keys(EVENT_SAMPLES).length} 类事件合法样本全部通过校验`)

  // 缺版本字段 v → 拒
  for (const name of Object.keys(EVENT_SAMPLES)) {
    const issues = validateEvent(name, EVENT_SAMPLES[name])
    assert.ok(issues.length > 0, `${name} 缺 v 应被拒`)
    assert.ok(issues.some((i) => i.path.endsWith('.v')), `${name} 缺 v 的问题应定位到 v 字段`)
  }
  ok('SSE：缺版本字段 v 的事件全部被拒')

  // 未知事件名 → 拒
  const unknown = validateEvent('assistant_fly_to_moon', { v: 1 })
  assert.ok(unknown.length > 0)
  assert.match(unknown[0].message, /未知 SSE 事件名/)
  ok('SSE：未知事件名被拒')

  // 错类型字段 → 拒（assistant_delta.offset 必须整数）
  assert.ok(validateEvent('assistant_delta', { v: 1, delta: 'x', offset: '0' }).length > 0)
  // withVersion 注入版本号
  assert.equal(withVersion('turn_start', {}).v, 1)
  ok('SSE：错类型字段被拒；withVersion 注入 v=1')
}

// ---- C. 前后端一致性（单元，读 web-vue 源码）----

function partC() {
  const agentTs = readFileSync(new URL('../../web-vue/src/api/agent.ts', import.meta.url), 'utf8')
  const twinTs = readFileSync(new URL('../../web-vue/src/api/twin.ts', import.meta.url), 'utf8')

  // C1. 协议类型必须从契约派生（import type 自 contract/types），不允许两份手写定义
  assert.match(agentTs, /import type \{[^}]*\} from '\.\.\/\.\.\/\.\.\/agh-integration\/agent-bff\/contract\/types'/, 'agent.ts 必须从契约 types.ts import type')
  for (const hand of ['export interface AgentStreamEvents', 'export interface ApprovalInfo', 'export interface AgentHealth', 'export interface ChatAccepted', 'export interface AgentPageContext']) {
    assert.ok(!agentTs.includes(hand), `agent.ts 不得再手写 ${hand}（漂移复发）`)
  }
  ok('前后端一致性：agent.ts 协议类型全部派生自契约，无手写定义残留')

  // C2. 前端运行时事件名清单 STREAM_EVENTS 是契约注册表的子集
  const m = agentTs.match(/const STREAM_EVENTS[^=]*=\s*\[([\s\S]*?)\]/)
  assert.ok(m, '未找到 STREAM_EVENTS 数组')
  const used = [...m[1].matchAll(/'([\w-]+)'/g)].map((x) => x[1])
  assert.ok(used.length > 0)
  for (const name of used) {
    assert.ok(SSE_EVENTS[name], `web-vue 监听的事件 ${name} 不在契约注册表中（手写漂移）`)
    assert.equal(SSE_EVENTS[name].stream, 'agent', `${name} 应属 agent 流`)
  }
  ok(`前后端一致性：STREAM_EVENTS ${used.length} 个事件名全部 ∈ 契约注册表（agent 流）`)

  // C3. 契约 agent 流事件全集被前端监听（防 BFF 加了事件前端不知道——只警告级，不断言失败？
  //     不断言：子集方向是简报要求；反向只覆盖现状，保持相等以尽早暴露漂移）
  const contractAgentEvents = Object.entries(SSE_EVENTS).filter(([, d]) => d.stream === 'agent').map(([n]) => n)
  assert.deepEqual([...used].sort(), contractAgentEvents.sort(), '契约 agent 事件全集应与前端监听清单一致')
  ok('前后端一致性：契约 agent 流事件全集与前端监听清单相等')

  // C4. twin.ts 监听的 twin 事件在契约中且属 twin 流
  assert.match(twinTs, /addEventListener\('twin'/)
  assert.equal(SSE_EVENTS['twin']?.stream, 'twin')
  ok('前后端一致性：twin.ts 的 twin 事件 ∈ 契约注册表（twin 流）')

  // C5. types.ts ↔ events.mts 字段级一致性（文本级，防两类定义再次漂移）：
  //     对每条事件比对 字段名集合 / 可选性（?）/ 可空性（| null）。
  //     边界：不校验 TS 类型表达式与 schema 类型的等价性（如 string vs 枚举字面量），
  //     也不覆盖 http.mts 的 HTTP 类型（ChatRequest 等）——见 EVENTS.md「检查边界」。
  const typesTs = readFileSync(new URL('./contract/types.ts', import.meta.url), 'utf8')

  /** 取 marker 之后第一个花括号块的文本（括号配平扫描） */
  function extractBlock(src: string, marker: string): string {
    const at = src.indexOf(marker)
    assert.ok(at >= 0, `types.ts 未找到 ${marker}`)
    const open = src.indexOf('{', at)
    let depth = 0
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') {
        depth--
        if (!depth) return src.slice(open, i + 1)
      }
    }
    throw new Error(`${marker} 花括号不配平`)
  }

  /** 从对象类型块提取字段：name → { optional, nullable }（事件 payload 字段均为单层标量类型） */
  function extractFields(block: string): Map<string, { optional: boolean; nullable: boolean }> {
    const fields = new Map<string, { optional: boolean; nullable: boolean }>()
    for (const m of block.matchAll(/(\w+)(\?)?\s*:\s*([^;}]+)/g)) {
      fields.set(m[1], { optional: !!m[2], nullable: /\bnull\b/.test(m[3]) })
    }
    return fields
  }

  const eventsBlock = extractBlock(typesTs, 'export interface AgentStreamEvents')
  let checkedFields = 0
  for (const [name, def] of Object.entries(SSE_EVENTS)) {
    // types.ts 侧字段表：agent 事件在 AgentStreamEvents 内联，twin 事件在 TwinEventPayload
    const block = def.stream === 'agent' ? extractBlock(eventsBlock, `${name}:`) : extractBlock(typesTs, 'export interface TwinEventPayload')
    const fields = extractFields(block)
    const props = def.schema.properties ?? {}
    const required = new Set(def.schema.required ?? [])
    assert.deepEqual([...fields.keys()].sort(), Object.keys(props).sort(), `${name}：types.ts 与 events.mts 字段名集合不一致`)
    for (const [prop, propSchema] of Object.entries(props)) {
      const f = fields.get(prop)!
      assert.equal(f.optional, !required.has(prop), `${name}.${prop}：可选性不一致（types.ts ${f.optional ? '可选' : '必填'}，schema ${required.has(prop) ? '必填' : '可选'}）`)
      if (propSchema.type) {
        const schemaNullable = Array.isArray(propSchema.type) && propSchema.type.includes('null')
        assert.equal(f.nullable, schemaNullable, `${name}.${prop}：可空性不一致（types.ts ${f.nullable ? '可空' : '非空'}，schema ${schemaNullable ? '可空' : '非空'}）`)
      }
      checkedFields++
    }
  }
  ok(`前后端一致性：types.ts ↔ events.mts 字段级对齐（${Object.keys(SSE_EVENTS).length} 条事件 ${checkedFields} 个字段的名/可选性/可空性）`)
}

// ---- B / D. HTTP 端点契约（集成，独立 BFF 实例）----

async function partBD() {
  await waitReady()

  // B1. 合法请求穿过契约层（到达业务逻辑而非 400）
  const health = await api('GET', '/health')
  assert.equal(health.status, 200)
  assert.equal(health.data.daemon, 'absent')
  const ticket = await api('POST', '/stream-ticket', { token: 'tok-alice' })
  assert.equal(ticket.status, 200)
  assert.equal(typeof ticket.data.ticket, 'string')
  assert.equal(typeof ticket.data.expiresAt, 'number')
  const chatOk = await api('POST', '/chat', { token: 'tok-alice', body: { conversationId: 'conv-c', message: 'hi', context: { section: '工作台' } } })
  assert.equal(chatOk.status, 503, `chat 合法请求应过契约层（daemon 缺席 503），实际 ${chatOk.status}: ${JSON.stringify(chatOk.data)}`)
  assert.equal(chatOk.data.error, 'daemon_unavailable')
  const cancelOk = await api('POST', '/cancel', { token: 'tok-alice', body: { conversationId: 'conv-c' } })
  assert.equal(cancelOk.status, 404) // 过契约层，会话无 daemon session
  const permOk = await api('POST', '/permission', { token: 'tok-alice', body: { conversationId: 'conv-c', requestId: 'r-x', verdict: 'rejected' } })
  assert.equal(permOk.status, 404)
  assert.equal(permOk.data.error, 'permission_not_found')
  const ragOk = await api('POST', '/rag/experience-query', { token: 'tok-alice', body: { limit: 1 } })
  assert.equal(ragOk.status, 200)
  const snap = await api('GET', '/twin/snapshot', { token: 'tok-alice' })
  assert.equal(snap.status, 200)
  assert.ok(Array.isArray(snap.data.devices))
  ok('HTTP：合法请求（health/ticket/chat/cancel/permission/rag/snapshot）全部穿过契约层')

  // B1b. 会话快照端点（任务 4.1）：未认证 401；未知会话 404；登记审批后属主 200 且结构完整
  const snapNoAuth = await api('GET', '/conversations/conv-c/snapshot')
  assert.equal(snapNoAuth.status, 401)
  const snapUnknown = await api('GET', '/conversations/conv-nobody/snapshot', { token: 'tok-alice' })
  assert.equal(snapUnknown.status, 404)
  assert.equal(snapUnknown.data.error, 'conversation_not_found')
  const reg = await api('POST', '/approvals', {
    token: 'tok-alice',
    body: { conversationId: 'conv-c', toolCall: { name: 'fjsp_publish', args: { planVersionId: 'PV-1' } } },
  })
  assert.equal(reg.status, 202)
  const convSnap = await api('GET', '/conversations/conv-c/snapshot', { token: 'tok-alice' })
  assert.equal(convSnap.status, 200, JSON.stringify(convSnap.data))
  const cs = convSnap.data
  assert.equal(cs.ok, true)
  assert.equal(cs.conversationId, 'conv-c')
  assert.equal(typeof cs.running, 'boolean')
  assert.equal(typeof cs.lastEventId, 'number')
  assert.equal(typeof cs.replayFrom, 'number')
  assert.ok(Array.isArray(cs.messages) && typeof cs.messagesComplete === 'boolean')
  assert.ok(cs.pendingApprovals.some((a: { requestId: string }) => a.requestId === reg.data.approval.requestId))
  ok('HTTP：会话快照端点 401/404/200 + 结构完整（lastEventId/replayFrom/messages/pendingApprovals）')

  // B2. 非法请求 400：缺字段
  const chatNoMsg = await api('POST', '/chat', { token: 'tok-alice', body: {} })
  assert.equal(chatNoMsg.status, 400)
  assert.equal(chatNoMsg.data.error, 'message_required') // 既有错误码保持
  const cancelMissing = await api('POST', '/cancel', { token: 'tok-alice', body: {} })
  assert.equal(cancelMissing.status, 400)
  assert.equal(cancelMissing.data.error, 'invalid_request')
  assert.ok(Array.isArray(cancelMissing.data.issues))
  const permMissing = await api('POST', '/permission', { token: 'tok-alice', body: { conversationId: 'conv-c' } })
  assert.equal(permMissing.status, 400)
  assert.equal(permMissing.data.error, 'invalid_request')
  ok('HTTP：缺字段（chat/cancel/permission）400；chat message 保持 message_required 兼容码')

  // B3. 非法请求 400：错类型 / 非法枚举 / 非法 JSON
  const chatBadType = await api('POST', '/chat', { token: 'tok-alice', body: { message: 'hi', conversationId: 42 } })
  assert.equal(chatBadType.status, 400)
  assert.equal(chatBadType.data.error, 'invalid_request')
  const chatBadCtx = await api('POST', '/chat', { token: 'tok-alice', body: { message: 'hi', context: 'x' } })
  assert.equal(chatBadCtx.status, 400)
  const chatMsgType = await api('POST', '/chat', { token: 'tok-alice', body: { message: 42 } })
  assert.equal(chatMsgType.status, 400)
  assert.equal(chatMsgType.data.error, 'message_required')
  const permBadVerdict = await api('POST', '/permission', { token: 'tok-alice', body: { conversationId: 'conv-c', requestId: 'r-x', verdict: 'maybe' } })
  assert.equal(permBadVerdict.status, 400)
  const ragBadLimit = await api('POST', '/rag/experience-query', { token: 'tok-alice', body: { limit: 'x' } })
  assert.equal(ragBadLimit.status, 400)
  const ragBadType = await api('POST', '/rag/experience-query', { token: 'tok-alice', body: { eventType: 1 } })
  assert.equal(ragBadType.status, 400)
  const simBadMachines = await api('POST', '/twin/sim/start', { token: 'tok-alice', body: { machines: 'cnc-m01' } })
  assert.equal(simBadMachines.status, 400) // 契约层拦截，不会触发真实仿真启动
  const badJson = await api('POST', '/chat', { token: 'tok-alice', rawBody: '{not json' })
  assert.equal(badJson.status, 400)
  assert.equal(badJson.data.error, 'invalid_request')
  // I2 回归：sim/start 不得吞掉非法 JSON（旧行为 catch→{} 会按默认机台清单启动仿真进程）
  const simBadJson = await api('POST', '/twin/sim/start', { token: 'tok-alice', rawBody: '{oops' })
  assert.equal(simBadJson.status, 400, `sim/start 非法 JSON 应 400 而非触发仿真，实际 ${simBadJson.status}`)
  assert.equal(simBadJson.data.error, 'invalid_request')
  ok('HTTP：错类型/非法枚举/非法 JSON/sim-start 坏参数全部 400 invalid_request；sim/start 不吞非法 JSON（I2）')

  // B4. /stream 的 conversationId 格式校验（契约化：原静默 fallback 随机会话 → 400）
  const t1 = await api('POST', '/stream-ticket', { token: 'tok-alice' })
  const badConv = await api('GET', `/stream?conversationId=${encodeURIComponent('a'.repeat(81))}&ticket=${encodeURIComponent(t1.data.ticket as string)}`, { raw: true })
  assert.equal((badConv as Response).status, 400)
  ;(badConv as Response).body?.cancel()
  ok('HTTP：/stream conversationId 超契约长度 400')

  // B5. fault/recover 非法设备 id 仍走既有 400 unsupported_device（契约层无 body，语义不变）
  const badDev = await api('POST', '/twin/device/bad-device/fault', { token: 'tok-alice' })
  assert.equal(badDev.status, 400)
  assert.equal(badDev.data.error, 'unsupported_device')
  ok('HTTP：fault 非法设备 400 unsupported_device（既有语义不变，未触碰仿真副作用路径）')

  // D. OpenAPI 导出
  const spec = await api('GET', '/openapi.json')
  assert.equal(spec.status, 200)
  assert.equal(spec.data.openapi, '3.1.0')
  const paths = spec.data.paths as Record<string, Record<string, unknown>>
  for (const ep of HTTP_CONTRACT) {
    assert.ok(paths[ep.path], `openapi.json 缺路径 ${ep.path}`)
    assert.ok(paths[ep.path][ep.method.toLowerCase()], `openapi.json 缺 ${ep.method} ${ep.path}`)
  }
  ok(`OpenAPI：/openapi.json 覆盖契约端点表全量 ${HTTP_CONTRACT.length} 个端点`)
}

try {
  await new Promise((resolve) => mockAuth.listen(MOCK_PORT, '127.0.0.1', resolve))
  await new Promise((resolve) => mockHub.listen(HUB_PORT, '127.0.0.1', resolve))
  partA()
  partC()
  await partBD()
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

// agent-bff: bridges the AGH daemon to the web-vue frontend.
// The daemon only speaks JSON-RPC over a unix socket (SDK) or serves its own
// workbench on :4177; this service gives the Vue app a first-class HTTP/SSE
// API so the agent is native UI instead of an iframe.
//
//   GET  /agent-api/health                     daemon/connectivity status
//   GET  /agent-api/stream?conversationId=...  SSE event stream (replay via sinceId / Last-Event-ID)
//   POST /agent-api/chat       { conversationId?, message, context? }
//   POST /agent-api/cancel     { conversationId }
//   POST /agent-api/permission { conversationId, requestId, verdict: 'allowed-once' | 'rejected' }
//   GET  /agent-api/twin/snapshot              MHS device snapshot (digital twin page)
//   GET  /agent-api/twin/stream                SSE 1Hz device snapshot ticks
//   GET  /agent-api/twin/device/:id/panel      latest panel JPEG of a device
//   GET  /agent-api/twin/grid                  workshop floor-plan PNG
//
// Run:  ../agnes-harness/node_modules/.bin/tsx server.mts
// Env:  AGENT_BFF_PORT (default 4178), AGENT_BFF_HOST (default 127.0.0.1),
//       AGNES_HUB_URL (default ws://127.0.0.1:4180/ws/hub)
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createClient, type PermissionOutcome, type Session } from '../agnes-harness/packages/sdk/src/index.node.ts'
import { mhsHub } from './mhs.mts'
import { simStart, simStatus, simStop } from './sim.mts'
import { experienceQuery } from './rag.mts'

const PORT = Number(process.env.AGENT_BFF_PORT ?? 4178)
const HOST = process.env.AGENT_BFF_HOST ?? '127.0.0.1'
const AGH_HOME = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const OWNER_FILE = `${process.env.HOME}/.agh/data/daemon/owner.json`
const SESSION_ID_FILE = new URL('../.agh-session-id', import.meta.url)
const STORE_FILE = new URL('./.conversations.json', import.meta.url)
const BUFFER_CAP = 1000
const HEARTBEAT_MS = 25_000
const PERMISSION_TIMEOUT_MS = 10 * 60_000

type BufferedEvent = { id: number; event: string; data: string }
type PendingPermission = {
  requestId: string
  toolCall: Record<string, unknown>
  settle: (outcome: PermissionOutcome) => void
  timer: ReturnType<typeof setTimeout>
}
type Conversation = {
  id: string
  sessionId: string | null
  session: Session | null
  starting: Promise<Session> | null
  pumping: boolean
  busy: boolean
  lastEventId: number
  buffer: BufferedEvent[]
  subscribers: Set<ServerResponse>
  pendingPermissions: Map<string, PendingPermission>
}

const conversations = new Map<string, Conversation>()

function loadStore(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(STORE_FILE, 'utf8'))
  } catch {
    return {}
  }
}

function saveStore() {
  const map: Record<string, string> = {}
  for (const [id, conv] of conversations) if (conv.sessionId) map[id] = conv.sessionId
  writeFileSync(STORE_FILE, JSON.stringify(map, null, 2))
}

function getConversation(id?: string): Conversation {
  const convId = id && /^[\w-]{1,80}$/.test(id) ? id : randomUUID()
  let conv = conversations.get(convId)
  if (!conv) {
    conv = {
      id: convId,
      sessionId: loadStore()[convId] ?? null,
      session: null,
      starting: null,
      pumping: false,
      busy: false,
      lastEventId: 0,
      buffer: [],
      subscribers: new Set(),
      pendingPermissions: new Map(),
    }
    conversations.set(convId, conv)
  }
  return conv
}

let clientPromise: Promise<ReturnType<typeof createClient>> | null = null
function getClient() {
  if (!clientPromise) {
    clientPromise = (async () => {
      const owner = JSON.parse(readFileSync(OWNER_FILE, 'utf8'))
      return createClient({
        transport: { kind: 'unix', path: owner.socketPath },
        clientId: 'fjsp-agent-bff',
      })
    })().catch((err) => {
      clientPromise = null
      throw err
    })
  }
  return clientPromise
}

async function ensureSession(conv: Conversation): Promise<Session> {
  if (conv.session) return conv.session
  if (conv.starting) return conv.starting
  conv.starting = (async () => {
    const client = await getClient()
    await client.workspace.add(AGH_HOME).catch(() => {})
    let session: Session
    if (conv.sessionId) {
      try {
        session = await client.session.load(conv.sessionId, { cwd: AGH_HOME })
      } catch {
        session = await client.session.new({ cwd: AGH_HOME, sessionKey: conv.id })
      }
    } else {
      // sessionKey = 前端会话 ID：不传时 daemon 会把同一 workspace 的 new() 归并到
      // 同一个默认会话，多个浏览器会话会互相串历史并撞并发 prompt。
      session = await client.session.new({ cwd: AGH_HOME, sessionKey: conv.id })
    }
    conv.session = session
    conv.sessionId = session.id
    saveStore()
    session.onPermissionRequest((req) => onPermissionRequest(conv, req))
    startPump(conv)
    return session
  })().finally(() => {
    conv.starting = null
  })
  return conv.starting
}

function broadcast(conv: Conversation, event: string, payload: unknown) {
  const entry: BufferedEvent = {
    id: ++conv.lastEventId,
    event,
    data: JSON.stringify(payload),
  }
  conv.buffer.push(entry)
  if (conv.buffer.length > BUFFER_CAP) conv.buffer.splice(0, conv.buffer.length - BUFFER_CAP)
  const frame = `id: ${entry.id}\nevent: ${entry.event}\ndata: ${entry.data}\n\n`
  for (const res of conv.subscribers) res.write(frame)
}

function firstText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('')
}

function startPump(conv: Conversation) {
  if (conv.pumping || !conv.session) return
  conv.pumping = true
  const session = conv.session
  session.onPreview((p) => {
    if (p.stream === 'text' && p.delta) {
      broadcast(conv, 'assistant_delta', { delta: p.delta, offset: p.offset })
    }
  })
  void (async () => {
    try {
      for await (const e of session.events({ preview: true })) {
        if (e.type === 'assistant/message') {
          const text = firstText((e.data as { content?: unknown }).content)
          if (text) broadcast(conv, 'assistant_message', { seq: e.seq, text })
        } else if (e.type === 'tool/call') {
          const d = e.data as { name?: string; args?: unknown; toolUseId?: string }
          broadcast(conv, 'tool_call', {
            seq: e.seq,
            name: d.name ?? 'tool',
            args: d.args ?? null,
            toolUseId: d.toolUseId ?? null,
          })
        } else if (e.type === 'tool/result') {
          const d = e.data as { content?: unknown; code?: string; isError?: boolean; toolUseId?: string }
          broadcast(conv, 'tool_result', {
            seq: e.seq,
            toolUseId: d.toolUseId ?? null,
            code: d.code ?? (d.isError ? 'error' : 'ok'),
            isError: !!d.isError,
            text: firstText(d.content).slice(0, 4000),
          })
        }
      }
    } catch {
      broadcast(conv, 'stream_closed', {})
    } finally {
      conv.pumping = false
    }
  })()
}

function onPermissionRequest(
  conv: Conversation,
  req: { toolCall: Record<string, unknown>; options: unknown[]; deadlineMs?: number },
): Promise<PermissionOutcome> {
  const requestId = randomUUID()
  const timeoutMs = Math.min(
    Math.max((req.deadlineMs ?? Date.now() + PERMISSION_TIMEOUT_MS) - Date.now(), 15_000),
    30 * 60_000,
  )
  broadcast(conv, 'permission_request', {
    requestId,
    toolCall: req.toolCall,
    options: req.options,
    deadlineMs: req.deadlineMs ?? Date.now() + timeoutMs,
  })
  return new Promise<PermissionOutcome>((resolve) => {
    const pending = {} as PendingPermission
    const settle = (outcome: PermissionOutcome) => {
      clearTimeout(pending.timer)
      conv.pendingPermissions.delete(requestId)
      broadcast(conv, 'permission_resolved', { requestId, verdict: outcome })
      resolve(outcome)
    }
    pending.requestId = requestId
    pending.toolCall = req.toolCall
    pending.settle = settle
    pending.timer = setTimeout(() => settle({ verdict: 'rejected' }), timeoutMs)
    conv.pendingPermissions.set(requestId, pending)
  })
}

function formatContext(context: unknown): string {
  if (!context || typeof context !== 'object') return ''
  const c = context as { section?: string; title?: string; route?: string; query?: Record<string, unknown> }
  const parts: string[] = []
  const page = [c.section, c.title].filter(Boolean).join(' / ')
  if (page) parts.push(`当前页面：${page}`)
  const query = c.query && Object.keys(c.query).length ? JSON.stringify(c.query) : ''
  if (query) parts.push(`页面参数：${query}`)
  if (!parts.length) return ''
  return `[操作员上下文 — ${parts.join('；')}。回答中如需引用页面元素，请使用该上下文。]\n\n`
}

async function handleChat(conv: Conversation, body: { message?: unknown; context?: unknown }, res: ServerResponse) {
  const message = typeof body.message === 'string' ? body.message.trim() : ''
  if (!message) return sendJson(res, 400, { error: 'message_required' })
  if (conv.busy) return sendJson(res, 409, { error: 'turn_in_progress', conversationId: conv.id })
  let session: Session
  try {
    session = await ensureSession(conv)
  } catch (err) {
    return sendJson(res, 503, { error: 'daemon_unavailable', detail: String(err) })
  }
  // fjsp-tools runs inside the daemon and cannot see this process's env; the
  // convention file is how the plugin correlates business audit logs to sessions.
  writeFileSync(SESSION_ID_FILE, session.id)
  conv.busy = true
  broadcast(conv, 'user_message', { text: message, context: body.context ?? null })
  broadcast(conv, 'turn_start', {})
  const prompt = formatContext(body.context) + message
  session
    .prompt(prompt, { titleLocale: 'zh-CN' })
    .then((result) => {
      broadcast(conv, 'turn_end', { reason: result.reason, stopReason: result.stopReason })
    })
    .catch((err) => {
      const detail = err && typeof err === 'object' && 'data' in err ? (err as { data?: unknown }).data : undefined
      broadcast(conv, 'turn_error', {
        message: err instanceof Error ? err.message : String(err),
        ...(detail !== undefined ? { detail } : {}),
      })
    })
    .finally(() => {
      conv.busy = false
      for (const p of conv.pendingPermissions.values()) p.settle({ verdict: 'rejected' })
    })
  sendJson(res, 202, { conversationId: conv.id, sessionId: conv.sessionId })
}

function handleStream(conv: Conversation, req: IncomingMessage, res: ServerResponse, url: URL) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write(`: conversation ${conv.id}\n\n`)
  const since = Number(url.searchParams.get('sinceId') ?? req.headers['last-event-id'] ?? 0) || 0
  for (const entry of conv.buffer) {
    if (entry.id > since) res.write(`id: ${entry.id}\nevent: ${entry.event}\ndata: ${entry.data}\n\n`)
  }
  conv.subscribers.add(res)
  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS)
  req.on('close', () => {
    clearInterval(heartbeat)
    conv.subscribers.delete(res)
  })
}

function sendJson(res: ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

// sim 进程状态走 pgrep，缓存 3s 避免每秒 fork（SSE tick 会调用）。
let simCache: { at: number; status: unknown } = { at: 0, status: null }
async function twinSnapshot() {
  if (Date.now() - simCache.at > 3000 || !simCache.status) {
    simCache = { at: Date.now(), status: await simStatus().catch(() => ({ running: false })) }
  }
  return { ...mhsHub.snapshot(), sim: simCache.status }
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 256 * 1024) throw new Error('body_too_large')
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

function cors(req: IncomingMessage, res: ServerResponse) {
  const origin = req.headers.origin ?? ''
  const loopback = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)
  res.setHeader('Access-Control-Allow-Origin', loopback ? origin : 'null')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Last-Event-ID')
}

const server = createServer(async (req, res) => {
  cors(req, res)
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    return res.end()
  }
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const path = url.pathname.replace(/\/$/, '')
  try {
    if (req.method === 'GET' && path === '/agent-api/health') {
      if (!existsSync(OWNER_FILE)) {
        return sendJson(res, 200, { ok: false, daemon: 'absent', hint: 'AGH daemon 未启动（未找到 owner.json），请先运行 agnes serve' })
      }
      try {
        await getClient()
        return sendJson(res, 200, {
          ok: true,
          daemon: 'connected',
          conversations: conversations.size,
          mhs: mhsHub.connected ? 'connected' : 'connecting',
        })
      } catch (err) {
        return sendJson(res, 200, { ok: false, daemon: 'unavailable', hint: String(err) })
      }
    }
    if (req.method === 'GET' && path === '/agent-api/stream') {
      const conv = getConversation(url.searchParams.get('conversationId') ?? undefined)
      return handleStream(conv, req, res, url)
    }
    if (req.method === 'POST' && path === '/agent-api/chat') {
      const body = await readBody(req)
      const conv = getConversation(typeof body.conversationId === 'string' ? body.conversationId : undefined)
      return await handleChat(conv, body, res)
    }
    if (req.method === 'POST' && path === '/agent-api/cancel') {
      const body = await readBody(req)
      const conv = conversations.get(String(body.conversationId ?? ''))
      if (!conv?.session) return sendJson(res, 404, { error: 'conversation_not_found' })
      await conv.session.cancel()
      return sendJson(res, 202, { ok: true })
    }
    if (req.method === 'POST' && path === '/agent-api/permission') {
      const body = await readBody(req)
      const conv = conversations.get(String(body.conversationId ?? ''))
      const pending = conv?.pendingPermissions.get(String(body.requestId ?? ''))
      if (!conv || !pending) return sendJson(res, 404, { error: 'permission_not_found' })
      const verdict = body.verdict === 'allowed-once' ? 'allowed-once' : 'rejected'
      pending.settle({ verdict })
      return sendJson(res, 202, { ok: true, verdict })
    }
    if (req.method === 'GET' && path === '/agent-api/twin/snapshot') {
      return sendJson(res, 200, await twinSnapshot())
    }
    if (req.method === 'GET' && path === '/agent-api/twin/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      const tick = setInterval(async () => {
        res.write(`event: twin\ndata: ${JSON.stringify(await twinSnapshot())}\n\n`)
      }, 1000)
      res.write(`event: twin\ndata: ${JSON.stringify(await twinSnapshot())}\n\n`)
      req.on('close', () => clearInterval(tick))
      return
    }
    if (req.method === 'GET' && path.startsWith('/agent-api/twin/device/') && path.endsWith('/panel')) {
      const id = path.slice('/agent-api/twin/device/'.length, -'/panel'.length)
      const jpeg = await mhsHub.panel(decodeURIComponent(id))
      if (!jpeg) return sendJson(res, 404, { error: 'panel_unavailable' })
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' })
      return res.end(jpeg)
    }
    if (req.method === 'GET' && path === '/agent-api/twin/grid') {
      const grid = await mhsHub.grid()
      if (!grid) return sendJson(res, 404, { error: 'grid_unavailable' })
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=300' })
      return res.end(grid.png)
    }
    if (req.method === 'POST' && path.match(/^\/agent-api\/twin\/device\/[^/]+\/(fault|recover)$/)) {
      // 任意机床故障注入/恢复：写按机台号的触发文件，设备循环下一拍（100ms）消费。
      // 与 machine-m03.py 的约定一致，见该文件头部注释。
      const m = path.match(/^\/agent-api\/twin\/device\/([^/]+)\/(fault|recover)$/)!
      const id = decodeURIComponent(m[1])
      const action = m[2]
      if (!/^cnc-m\d{2}$/.test(id)) return sendJson(res, 400, { error: 'unsupported_device' })
      const st = await simStatus()
      if (!st.running) return sendJson(res, 409, { error: 'sim_not_running' })
      const code = 'M-' + id.slice(5).toUpperCase()
      writeFileSync(`/tmp/mhs-${action}-${code}`, String(Date.now()))
      return sendJson(res, 202, { ok: true, device: id, action })
    }
    if (req.method === 'POST' && path === '/agent-api/twin/sim/start') {
      const body = await readBody(req).catch(() => ({}))
      const machines = Array.isArray(body.machines) ? body.machines.map(String) : undefined
      const r = await simStart(machines)
      return sendJson(res, r.started ? 202 : 409, r)
    }
    if (req.method === 'POST' && path === '/agent-api/twin/sim/stop') {
      return sendJson(res, 202, await simStop())
    }
    if (req.method === 'POST' && path === '/agent-api/rag/experience-query') {
      const body = await readBody(req)
      const result = await experienceQuery({
        eventType: typeof body.eventType === 'string' ? body.eventType : undefined,
        query: typeof body.query === 'string' ? body.query : undefined,
        limit: typeof body.limit === 'number' ? body.limit : undefined,
      })
      return sendJson(res, 200, result)
    }
    sendJson(res, 404, { error: 'not_found' })
  } catch (err) {
    sendJson(res, 500, { error: 'internal', detail: err instanceof Error ? err.message : String(err) })
  }
})

server.listen(PORT, HOST, () => {
  console.log(`[agent-bff] listening on http://${HOST}:${PORT}/agent-api (workspace ${AGH_HOME})`)
  mhsHub.start()
})

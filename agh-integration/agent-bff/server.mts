// agent-bff: bridges the AGH daemon to the web-vue frontend.
// The daemon only speaks JSON-RPC over a unix socket (SDK) or serves its own
// workbench on :4177; this service gives the Vue app a first-class HTTP/SSE
// API so the agent is native UI instead of an iframe.
//
//   GET  /agent-api/health                     daemon/connectivity status（公开）
//   POST /agent-api/stream-ticket              换取 SSE ticket（需 Bearer JWT）
//   GET  /agent-api/stream?conversationId=...&ticket=...  SSE event stream (replay via sinceId / Last-Event-ID)
//   POST /agent-api/chat       { conversationId?, message, context? }
//   POST /agent-api/cancel     { conversationId }
//   POST /agent-api/permission { conversationId, requestId, verdict: 'allowed-once' | 'rejected' }
//   GET  /agent-api/twin/snapshot              MHS device snapshot (digital twin page)
//   GET  /agent-api/twin/stream?ticket=...     SSE 1Hz device snapshot ticks
//   GET  /agent-api/twin/device/:id/panel      latest panel JPEG（公开：<img> 无法带请求头）
//   GET  /agent-api/twin/grid                  workshop floor-plan PNG（公开，同上）
//
// 鉴权：除健康检查与两张孪生图片外，所有端点要求 business-service 签发的 JWT
// （Authorization: Bearer，BFF 向 FJSP_API_BASE/auth/me 内检），SSE 走一次性语义
// 等价的限时 ticket（EventSource 不能带请求头；ticket 60s 内可复用以支持自动重连）。
// 会话绑定属主：创建会话记录 username，跨用户访问 403；无属主的历史会话一律 403（legacy）。
//
// 审批身份绑定（P0）：daemon 的 permission_request 落一条五要素审批记录（工具名 /
// 参数摘要=规范化 JSON 的 SHA-256 + 人类可读摘要 / 业务对象 / 有效期 / 可审批角色），
// /permission 裁决时重校验：会话归属、未过期、角色匹配（ticket 路径同样带 role）、
// 一次性（未裁决过）；全部裁决与越权/过期尝试追加到 .approval-audit.jsonl 审计。
//
// Run:  ../agnes-harness/node_modules/.bin/tsx server.mts
// Env:  AGENT_BFF_PORT (default 4178), AGENT_BFF_HOST (default 127.0.0.1),
//       AGNES_HUB_URL (default ws://127.0.0.1:4180/ws/hub),
//       FJSP_API_BASE (default http://localhost:8081/api/v1，JWT 内检地址),
//       AGENT_BFF_APPROVAL_TTL_MS（审批有效期，默认 5 分钟）,
//       AGH_OWNER_FILE / AGENT_BFF_STORE_FILE / AGENT_BFF_SESSION_ID_FILE / AGENT_BFF_AUDIT_FILE（测试隔离覆盖用）
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createClient, type PermissionOutcome, type Session } from '../agnes-harness/packages/sdk/src/index.node.ts'
import { tools as fjspToolDefs } from '../fjsp-tools/index.mjs'
import { mhsHub } from './mhs.mts'
import { simStart, simStatus, simStop } from './sim.mts'
import { experienceQuery } from './rag.mts'

const PORT = Number(process.env.AGENT_BFF_PORT ?? 4178)
const HOST = process.env.AGENT_BFF_HOST ?? '127.0.0.1'
const AGH_HOME = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const OWNER_FILE = process.env.AGH_OWNER_FILE ?? `${process.env.HOME}/.agh/data/daemon/owner.json`
const SESSION_ID_FILE = process.env.AGENT_BFF_SESSION_ID_FILE ?? new URL('../.agh-session-id', import.meta.url)
const STORE_FILE = process.env.AGENT_BFF_STORE_FILE ?? new URL('./.conversations.json', import.meta.url)
const FJSP_API_BASE = (process.env.FJSP_API_BASE ?? 'http://localhost:8081/api/v1').replace(/\/+$/, '')
const AUTH_CACHE_OK_MS = 30_000
const AUTH_CACHE_BAD_MS = 5_000
const TICKET_TTL_MS = 60_000
const BUFFER_CAP = 1000
const HEARTBEAT_MS = 25_000
const PERMISSION_TIMEOUT_MS = 10 * 60_000
const APPROVAL_TTL_MS = Number(process.env.AGENT_BFF_APPROVAL_TTL_MS ?? 5 * 60_000)
const AUDIT_FILE = process.env.AGENT_BFF_AUDIT_FILE ?? new URL('./.approval-audit.jsonl', import.meta.url)

// ---- 审批风险级 → 可审批角色（显式配置；对齐 business-service 各端点的 @PreAuthorize）----
// 工具风险级以 fjsp-tools/index.mjs 的 meta 为唯一事实来源（MCP 与 AGH 插件共用）。
type RiskLevel = 'READ' | 'WRITE' | 'HIGH_RISK' | 'DESTRUCTIVE'
const RISK_ROLES: Record<RiskLevel, string[]> = {
  READ: [], // 只读工具不触发审批
  WRITE: ['DISPATCHER', 'ADMIN'], // 对齐 EventController/ScheduleTaskController 等写端点
  HIGH_RISK: ['REVIEWER', 'PRODUCTION_MANAGER', 'ADMIN'], // 兜底并集，具体工具见 TOOL_ROLES
  DESTRUCTIVE: ['ADMIN'], // 对齐 DemoController（仅 ADMIN）
}
// 工具级覆盖：HIGH_RISK 下两个工具的审批角色在 business-service 侧并不同级
const TOOL_ROLES: Record<string, string[]> = {
  fjsp_approve_review: ['REVIEWER', 'ADMIN'], // PlanVersionController 评审端点
  fjsp_publish: ['PRODUCTION_MANAGER', 'ADMIN'], // PlanVersionController 发布端点
}
// 未知工具 / 未知级别：requiredRoles 为空 = 默认拒绝任何人批准（fail-closed）

function riskOfMeta(meta: { requiresApproval?: string; isDestructive?: boolean; replay?: string } | undefined): RiskLevel | null {
  if (!meta) return null
  if (meta.requiresApproval === 'never') return 'READ'
  if (meta.isDestructive) return 'DESTRUCTIVE'
  if (meta.replay === 'never') return 'HIGH_RISK'
  return 'WRITE'
}

const TOOL_RISK = new Map<string, RiskLevel>()
for (const t of fjspToolDefs as { name: string; meta?: Parameters<typeof riskOfMeta>[0] }[]) {
  const risk = riskOfMeta(t.meta)
  if (risk) TOOL_RISK.set(t.name, risk)
}

type BufferedEvent = { id: number; event: string; data: string }
type PendingPermission = {
  requestId: string
  toolCall: Record<string, unknown>
  settle: (outcome: PermissionOutcome, result?: string, by?: string) => void
  timer: ReturnType<typeof setTimeout>
}
// 审批记录（五要素绑定）：工具名、参数摘要（规范化 JSON 的 SHA-256 + 人类可读摘要）、
// 业务对象、有效期、可审批角色。内存保存（pending 承诺随进程消亡，持久化无意义），
// 全部裁决结果追加持久化到 AUDIT_FILE（JSONL，可按会话/业务对象回溯）。
type ApprovalRecord = {
  requestId: string
  conversationId: string
  tool: string
  risk: RiskLevel | 'UNKNOWN'
  argsDigest: string
  argsSummary: string
  bizObject: Record<string, string> | null
  requiredRoles: string[]
  createdAt: number
  expiresAt: number
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'timeout'
}
type Conversation = {
  id: string
  sessionId: string | null
  owner: string | null // 属主 username；null = 历史遗留（legacy），一律拒绝访问
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

type StoreEntry = { sessionId: string | null; owner: string | null }

function loadStore(): Record<string, StoreEntry> {
  try {
    const raw = JSON.parse(readFileSync(STORE_FILE, 'utf8')) as Record<string, unknown>
    const out: Record<string, StoreEntry> = {}
    for (const [id, v] of Object.entries(raw)) {
      // 旧格式为 id → sessionId 字符串，无属主记录，按 legacy 处理
      out[id] = typeof v === 'string'
        ? { sessionId: v, owner: null }
        : { sessionId: (v as StoreEntry)?.sessionId ?? null, owner: (v as StoreEntry)?.owner ?? null }
    }
    return out
  } catch {
    return {}
  }
}

function saveStore() {
  const map: Record<string, StoreEntry> = {}
  for (const [id, conv] of conversations) map[id] = { sessionId: conv.sessionId, owner: conv.owner }
  writeFileSync(STORE_FILE, JSON.stringify(map, null, 2))
}

function getConversation(id: string | undefined, owner: string): Conversation {
  const convId = id && /^[\w-]{1,80}$/.test(id) ? id : randomUUID()
  let conv = conversations.get(convId)
  if (!conv) {
    const stored = loadStore()[convId]
    conv = {
      id: convId,
      sessionId: stored?.sessionId ?? null,
      // 已持久化的会话以存储中的属主为准；新会话绑定当前用户
      owner: stored ? stored.owner : owner,
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

// ---- 鉴权：business-service JWT 内检 + SSE 限时 ticket ----
// 与 business-service 共用身份的唯一事实来源：不共享密钥、不本地验签，
// 每次（带 30s 正缓存）把 Bearer token 转发给 /auth/me 内检，tv 失效/停用/删除
// 即时生效（最坏 30s 延迟）。内检不可达时 fail-closed：业务端点 503 auth_unavailable。
type AuthUser = { username: string; role: string; displayName: string }
type AuthResult = AuthUser | null | 'unavailable'

const authCache = new Map<string, { user: AuthUser | null; expiresAt: number }>()

async function introspectToken(token: string): Promise<AuthResult> {
  const cached = authCache.get(token)
  if (cached && cached.expiresAt > Date.now()) return cached.user
  let user: AuthUser | null
  try {
    const res = await fetch(`${FJSP_API_BASE}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    })
    const env = (await res.json().catch(() => null)) as { code?: string; data?: Partial<AuthUser> } | null
    user = res.ok && env?.code === 'OK' && typeof env.data?.username === 'string'
      ? {
          username: env.data.username,
          role: typeof env.data.role === 'string' ? env.data.role : '',
          displayName: typeof env.data.displayName === 'string' ? env.data.displayName : '',
        }
      : null
  } catch {
    return 'unavailable'
  }
  if (authCache.size > 500) {
    const now = Date.now()
    for (const [k, v] of authCache) {
      if (v.expiresAt <= now) authCache.delete(k)
    }
    if (authCache.size > 500) authCache.delete(authCache.keys().next().value as string)
  }
  authCache.set(token, { user, expiresAt: Date.now() + (user ? AUTH_CACHE_OK_MS : AUTH_CACHE_BAD_MS) })
  return user
}

// SSE ticket：EventSource 无法自定义请求头，JWT 进 URL 会泄露到浏览器历史/代理日志
// （business-service StreamTicketService 的既有结论）。这里签发 60s 限时 ticket，
// 绑定签发时的完整身份（username/role/displayName，审批角色校验需要 role）；与业务
// 服务的一次性语义不同，本 ticket 在 TTL 内可复用——
// EventSource 断线自动重连会复用同一 URL，一次性 ticket 会让重连必失败。
const tickets = new Map<string, { user: AuthUser; expiresAt: number }>()

function issueTicket(user: AuthUser): { ticket: string; expiresAt: number } {
  const now = Date.now()
  for (const [k, v] of tickets) if (v.expiresAt <= now) tickets.delete(k)
  const ticket = randomBytes(32).toString('base64url')
  const expiresAt = now + TICKET_TTL_MS
  tickets.set(ticket, { user, expiresAt })
  return { ticket, expiresAt }
}

function resolveTicket(ticket: string | null): AuthUser | null {
  if (!ticket) return null
  const t = tickets.get(ticket)
  return t && t.expiresAt > Date.now() ? t.user : null
}

async function authenticate(req: IncomingMessage, url: URL): Promise<AuthResult> {
  const header = req.headers.authorization ?? ''
  if (header.startsWith('Bearer ')) return introspectToken(header.slice(7))
  // ticket 绑定签发时的完整身份（含 role）：审批角色校验在 SSE/ ticket 路径同样可用
  return resolveTicket(url.searchParams.get('ticket'))
}

/** 业务端点统一入口；返回 null 时已写好错误响应。 */
async function requireAuth(req: IncomingMessage, url: URL, res: ServerResponse): Promise<AuthUser | null> {
  const result = await authenticate(req, url)
  if (result === 'unavailable') {
    sendJson(res, 503, { error: 'auth_unavailable', detail: `业务服务鉴权接口不可达（${FJSP_API_BASE}）` })
    return null
  }
  if (!result) {
    sendJson(res, 401, { error: 'unauthorized' })
    return null
  }
  return result
}

/** 会话归属校验；返回 false 时已写好 403。 */
function authorizeConversation(conv: Conversation, user: AuthUser, res: ServerResponse): boolean {
  if (!conv.owner) {
    sendJson(res, 403, { error: 'conversation_legacy', detail: '历史会话无属主记录，请新建会话' })
    return false
  }
  if (conv.owner !== user.username) {
    sendJson(res, 403, { error: 'conversation_forbidden', detail: '会话属于其他用户' })
    return false
  }
  return true
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

// ---- 审批记录与审计 ----
const approvals = new Map<string, ApprovalRecord>()

/** 规范化 JSON（键排序，递归）→ SHA-256：审批记录与裁决时的参数一致性校验共用。 */
function canonicalDigest(value: unknown): { canonical: string; digest: string } {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm)
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      return Object.fromEntries(Object.keys(o).sort().map((k) => [k, norm(o[k])]))
    }
    return v
  }
  const canonical = JSON.stringify(norm(value))
  return { canonical, digest: createHash('sha256').update(canonical).digest('hex') }
}

// 业务对象提取：只取参数顶层的已知标识键，无则 null
const BIZ_KEYS = ['planVersionId', 'eventId', 'taskId', 'machineId', 'orderId', 'jobId']

function extractBizObject(args: Record<string, unknown>): Record<string, string> | null {
  const found: Record<string, string> = {}
  for (const k of BIZ_KEYS) {
    const v = args[k]
    if (typeof v === 'string' && v) found[k] = v
    else if (typeof v === 'number' && Number.isFinite(v)) found[k] = String(v)
  }
  return Object.keys(found).length ? found : null
}

/** 人类可读摘要：工具名 + 主要参数 k=v（截断），供审批卡片直接展示。 */
function buildArgsSummary(tool: string, canonical: string): string {
  const short = canonical.length > 200 ? canonical.slice(0, 200) + '…' : canonical
  return `${tool} ${short}`
}

function buildApprovalRecord(conv: Conversation, requestId: string, toolCall: Record<string, unknown>): ApprovalRecord {
  const tool = String(toolCall.name ?? toolCall.title ?? '')
  const args = (toolCall.args ?? toolCall.arguments ?? {}) as Record<string, unknown>
  const { canonical, digest } = canonicalDigest(args)
  const risk = TOOL_RISK.get(tool) ?? 'UNKNOWN'
  const requiredRoles = risk === 'UNKNOWN' ? [] : (TOOL_ROLES[tool] ?? RISK_ROLES[risk])
  const now = Date.now()
  const record: ApprovalRecord = {
    requestId,
    conversationId: conv.id,
    tool,
    risk,
    argsDigest: digest,
    argsSummary: buildArgsSummary(tool, canonical),
    bizObject: extractBizObject(args),
    requiredRoles,
    createdAt: now,
    expiresAt: now + APPROVAL_TTL_MS,
    status: 'pending',
  }
  // 惰性清理：上限外丢弃最旧的非 pending 记录
  if (approvals.size > 5000) {
    for (const [k, v] of approvals) {
      if (v.status !== 'pending') approvals.delete(k)
      if (approvals.size <= 5000) break
    }
  }
  approvals.set(requestId, record)
  return record
}

// 审计：批准/拒绝/过期/越权尝试/超时一律落 JSONL，含操作者、工具、参数摘要、业务对象。
// 与 business-service 的业务审计分工：那里记"工具执行了什么业务变更"，这里记"谁在
// 何时批准/拒绝了这次执行"（审批决策层，business-service 看不到审批拒绝与越权尝试）。
function auditApproval(record: ApprovalRecord, result: string, by: string, detail?: string) {
  const entry = {
    ts: new Date().toISOString(),
    conversationId: record.conversationId,
    requestId: record.requestId,
    by,
    tool: record.tool,
    risk: record.risk,
    argsDigest: record.argsDigest,
    argsSummary: record.argsSummary,
    bizObject: record.bizObject,
    result,
    ...(detail ? { detail } : {}),
  }
  try {
    appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n')
  } catch (err) {
    console.error('[agent-bff] 审批审计写入失败:', err)
  }
}

function onPermissionRequest(
  conv: Conversation,
  req: { toolCall: Record<string, unknown>; options: unknown[]; deadlineMs?: number },
): Promise<PermissionOutcome> {
  const requestId = randomUUID()
  const record = buildApprovalRecord(conv, requestId, req.toolCall)
  const timeoutMs = Math.min(
    Math.max((req.deadlineMs ?? Date.now() + PERMISSION_TIMEOUT_MS) - Date.now(), 15_000),
    30 * 60_000,
  )
  broadcast(conv, 'permission_request', {
    requestId,
    toolCall: req.toolCall,
    options: req.options,
    deadlineMs: req.deadlineMs ?? Date.now() + timeoutMs,
    approval: {
      tool: record.tool,
      risk: record.risk,
      summary: record.argsSummary,
      digest: record.argsDigest.slice(0, 12),
      bizObject: record.bizObject,
      requiredRoles: record.requiredRoles,
      expiresAt: record.expiresAt,
    },
  })
  return new Promise<PermissionOutcome>((resolve) => {
    const pending = {} as PendingPermission
    const settle = (outcome: PermissionOutcome, result?: string, by = 'system') => {
      clearTimeout(pending.timer)
      conv.pendingPermissions.delete(requestId)
      if (record.status === 'pending') {
        const r = result ?? ('verdict' in outcome && outcome.verdict === 'allowed-once' ? 'approved' : 'rejected')
        record.status = r === 'approved' ? 'approved' : r === 'expired' ? 'expired' : r === 'timeout' ? 'timeout' : 'rejected'
        auditApproval(record, r, by)
      }
      broadcast(conv, 'permission_resolved', { requestId, verdict: outcome })
      resolve(outcome)
    }
    pending.requestId = requestId
    pending.toolCall = req.toolCall
    pending.settle = settle
    pending.timer = setTimeout(() => settle({ verdict: 'rejected' }, 'timeout'), timeoutMs)
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
      for (const p of conv.pendingPermissions.values()) p.settle({ verdict: 'rejected' }, 'rejected', 'system:turn_end')
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Last-Event-ID, Authorization')
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
    if (req.method === 'POST' && path === '/agent-api/stream-ticket') {
      // 只接受 Bearer JWT 换票：ticket 出现在 URL 里（泄露面大），不允许用 ticket 续票
      const header = req.headers.authorization ?? ''
      if (!header.startsWith('Bearer ')) return sendJson(res, 401, { error: 'unauthorized' })
      const result = await introspectToken(header.slice(7))
      if (result === 'unavailable') return sendJson(res, 503, { error: 'auth_unavailable', detail: `业务服务鉴权接口不可达（${FJSP_API_BASE}）` })
      if (!result) return sendJson(res, 401, { error: 'unauthorized' })
      return sendJson(res, 200, issueTicket(result))
    }
    if (req.method === 'GET' && path === '/agent-api/stream') {
      const user = await requireAuth(req, url, res)
      if (!user) return
      const conv = getConversation(url.searchParams.get('conversationId') ?? undefined, user.username)
      if (!authorizeConversation(conv, user, res)) return
      return handleStream(conv, req, res, url)
    }
    if (req.method === 'POST' && path === '/agent-api/chat') {
      const user = await requireAuth(req, url, res)
      if (!user) return
      const body = await readBody(req)
      const conv = getConversation(typeof body.conversationId === 'string' ? body.conversationId : undefined, user.username)
      if (!authorizeConversation(conv, user, res)) return
      return await handleChat(conv, body, res)
    }
    if (req.method === 'POST' && path === '/agent-api/cancel') {
      const user = await requireAuth(req, url, res)
      if (!user) return
      const body = await readBody(req)
      const conv = conversations.get(String(body.conversationId ?? ''))
      if (!conv) return sendJson(res, 404, { error: 'conversation_not_found' })
      if (!authorizeConversation(conv, user, res)) return
      if (!conv.session) return sendJson(res, 404, { error: 'conversation_not_found' })
      await conv.session.cancel()
      return sendJson(res, 202, { ok: true })
    }
    if (req.method === 'POST' && path === '/agent-api/permission') {
      // 批准时重校验：a) 会话归属当前用户（authorizeConversation）；b) 审批未过期；
      // c) 当前用户角色 ∈ 可审批角色（内检/ticket 携带的 role 为准）；d) 未被裁决过。
      // 任一失败拒绝并记审计；放行前再核对参数摘要与记录一致（防串单）。
      const user = await requireAuth(req, url, res)
      if (!user) return
      const body = await readBody(req)
      const conv = conversations.get(String(body.conversationId ?? ''))
      if (conv && !authorizeConversation(conv, user, res)) return
      const requestId = String(body.requestId ?? '')
      const record = approvals.get(requestId)
      if (!conv || !record || record.conversationId !== conv.id) {
        return sendJson(res, 404, { error: 'permission_not_found' })
      }
      if (record.status !== 'pending') {
        auditApproval(record, 'rejected', user.username, `重复裁决尝试（已是 ${record.status}）`)
        return sendJson(res, 409, { error: 'approval_already_decided', detail: '该审批已被裁决过' })
      }
      const pending = conv.pendingPermissions.get(requestId)
      if (!pending) return sendJson(res, 404, { error: 'permission_not_found' })
      if (Date.now() > record.expiresAt) {
        pending.settle({ verdict: 'rejected' }, 'expired', user.username)
        return sendJson(res, 410, { error: 'approval_expired', detail: '审批请求已过期' })
      }
      const verdict = body.verdict === 'allowed-once' ? 'allowed-once' as const : 'rejected' as const
      // 角色闸只对"批准"生效：拒绝自己会话里的工具调用是安全操作，低角色/未知级别
      // 工具也应能被及时拒掉（否则 daemon 侧承诺悬挂到超时）
      if (verdict === 'allowed-once') {
        if (!record.requiredRoles.includes(user.role)) {
          auditApproval(record, 'forbidden', user.username, `角色 ${user.role || '(空)'} 不在可审批角色 [${record.requiredRoles.join(',')}]`)
          return sendJson(res, 403, {
            error: 'approval_forbidden',
            detail: `当前角色无权审批该操作（需要：${record.requiredRoles.join(' / ') || '无可用角色'}）`,
          })
        }
        const { digest } = canonicalDigest((pending.toolCall.args ?? pending.toolCall.arguments ?? {}) as Record<string, unknown>)
        if (digest !== record.argsDigest) {
          auditApproval(record, 'rejected', user.username, '参数摘要与审批记录不一致')
          return sendJson(res, 409, { error: 'approval_mismatch', detail: '审批参数已变化，请重新发起' })
        }
      }
      pending.settle({ verdict }, verdict === 'allowed-once' ? 'approved' : 'rejected', user.username)
      return sendJson(res, 202, { ok: true, verdict })
    }
    if (req.method === 'GET' && path === '/agent-api/twin/snapshot') {
      if (!(await requireAuth(req, url, res))) return
      return sendJson(res, 200, await twinSnapshot())
    }
    if (req.method === 'GET' && path === '/agent-api/twin/stream') {
      if (!(await requireAuth(req, url, res))) return
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
      if (!(await requireAuth(req, url, res))) return
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
      if (!(await requireAuth(req, url, res))) return
      const body = await readBody(req).catch(() => ({}))
      const machines = Array.isArray(body.machines) ? body.machines.map(String) : undefined
      const r = await simStart(machines)
      return sendJson(res, r.started ? 202 : 409, r)
    }
    if (req.method === 'POST' && path === '/agent-api/twin/sim/stop') {
      if (!(await requireAuth(req, url, res))) return
      return sendJson(res, 202, await simStop())
    }
    if (req.method === 'POST' && path === '/agent-api/rag/experience-query') {
      if (!(await requireAuth(req, url, res))) return
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

// 供 test-approval.mts（tsx 直接 import 本模块）注入审批请求、检查审批记录：
// 不新增任何 HTTP 测试端点，生产路径无 test-only 分支。
export { conversations, approvals, onPermissionRequest }
export type { Conversation, ApprovalRecord }

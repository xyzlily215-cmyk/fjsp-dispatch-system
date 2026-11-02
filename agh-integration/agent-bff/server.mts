// agent-bff: bridges the AGH daemon to the web-vue frontend.
// The daemon only speaks JSON-RPC over a unix socket (SDK) or serves its own
// workbench on :4177; this service gives the Vue app a first-class HTTP/SSE
// API so the agent is native UI instead of an iframe.
//
//   GET  /agent-api/health                     daemon/connectivity status（公开）
//   GET  /agent-api/openapi.json               由契约端点表生成的 OpenAPI 3.1 文档（公开）
//   POST /agent-api/stream-ticket              换取 SSE ticket（需 Bearer JWT）
//   GET  /agent-api/stream?conversationId=...&ticket=...  SSE event stream (replay via sinceId / Last-Event-ID)
//   GET  /agent-api/conversations/:id/snapshot  会话快照（消息+运行状态+lastEventId+有效待审批，任务 4.1）
//   POST /agent-api/chat       { conversationId?, message, context? }
//   POST /agent-api/cancel     { conversationId }
//   POST /agent-api/permission { conversationId, requestId, verdict: 'allowed-once' | 'rejected' }
//   POST /agent-api/approvals  { conversationId, toolCall, ttlMs? }  工作流登记审批（任务 3.4）
//   GET  /agent-api/approvals/:requestId           审批状态查询（五要素摘要 + 状态，任务 3.4）
//   GET  /agent-api/audit/trail?workflowId=...     审计聚合视图（任务 4.2，仅 ADMIN）：
//         或 ?objectType=..&objectId=..；format=jsonl 导出完整链
//   GET  /agent-api/twin/snapshot              MHS device snapshot (digital twin page)
//   GET  /agent-api/twin/stream?ticket=...     SSE 1Hz device snapshot ticks
//   GET  /agent-api/twin/device/:id/panel      latest panel JPEG（公开：<img> 无法带请求头）
//   GET  /agent-api/twin/grid                  workshop floor-plan PNG（公开，同上）
//
// 契约（2.C）：`contract/` 目录是 HTTP/SSE 线协议的单一事实源——http.mts 端点表
// （请求/响应 schema）、events.mts SSE 事件注册表（payload 带版本字段 v）、types.ts
// 类型定义（web-vue 的 src/api/agent.ts 由此 import type 派生，不再手写）。
// 请求入站按契约校验（非法 400 invalid_request）；关键端点响应出站校验（失败记日志
// 并 500 contract_violation）；SSE 事件发出前校验（畸形记日志并丢弃）。版本演进
// 规则见 contract/EVENTS.md；契约测试：test-contract-api.mts。
//
// 鉴权：除健康检查与两张孪生图片外，所有端点要求 business-service 签发的 JWT
// （Authorization: Bearer，BFF 向 FJSP_API_BASE/auth/me 内检），SSE 走一次性语义
// 等价的限时 ticket（EventSource 不能带请求头；ticket 60s 内可复用以支持自动重连）。
// 会话绑定属主：创建会话记录 username，跨用户访问 403；无属主的历史会话一律 403（legacy）。
//
// 会话快照与断线恢复（任务 4.1）：GET /conversations/:id/snapshot 返回从 AGH 会话 UI 投影
// 重建的消息、运行状态、lastEventId/replayFrom 与仍有效的待审批项（读取时惰性过期核销，
// 重启恢复的 expired 审批不进快照）。衔接语义：messagesComplete=true → 前端以
// sinceId=lastEventId 订阅（快照到订阅之间的事件由回放补齐，不丢不重）；false → 以
// sinceId=replayFrom 订阅走回放缓冲重建。订阅的 sinceId 已出缓冲窗口时，/stream 先下发
// resync_required 控制帧（不进缓冲、不占序号）再关闭，客户端重新取快照。
//
// 审批身份绑定（P0）：daemon 的 permission_request 落一条五要素审批记录（工具名 /
// 参数摘要=规范化 JSON 的 SHA-256 + 人类可读摘要 / 业务对象 / 有效期 / 可审批角色），
// /permission 裁决时重校验：会话归属、未过期、角色匹配（ticket 路径同样带 role）、
// 一次性（未裁决过）；全部裁决与越权/过期尝试追加到 .approval-audit.jsonl 审计。
// 审批记录轻量持久化到 .approvals.json（任务 3.4）：只为"重启后状态可查"——
// pending 承诺随进程消亡，重启加载时遗留 pending 一律置 expired 并记审计，旧批准不回放。
//
// Run:  ../agnes-harness/node_modules/.bin/tsx server.mts
// Env:  AGENT_BFF_PORT (default 4178), AGENT_BFF_HOST (default 127.0.0.1),
//       AGNES_HUB_URL (default ws://127.0.0.1:4180/ws/hub),
//       FJSP_API_BASE (default http://localhost:8081/api/v1，JWT 内检地址),
//       AGENT_BFF_APPROVAL_TTL_MS（审批有效期，默认 5 分钟）,
//       AGH_OWNER_FILE / AGENT_BFF_STORE_FILE / AGENT_BFF_SESSION_ID_FILE / AGENT_BFF_AUDIT_FILE / AGENT_BFF_APPROVALS_FILE / AGENT_BFF_BUFFER_CAP（测试隔离覆盖用）
//       FJSP_WORKFLOW_DIR（审计聚合读取工作流检查点目录，默认 ~/.agh/fjsp-workflows，与 workflow/checkpoint.mts 同约定）
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createClient, type PermissionOutcome, type Session } from '../agnes-harness/packages/sdk/src/index.node.ts'
import { tools as fjspToolDefs } from '../fjsp-tools/index.mjs'
import { mhsHub } from './mhs.mts'
import { simStart, simStatus, simStop } from './sim.mts'
import { experienceQuery } from './rag.mts'
import { validateEvent, withVersion } from './contract/events.mts'
import {
  buildOpenApi, validateRequestBody, findEndpoint,
  APPROVAL_STATUS_RESPONSE,
  AUDIT_TRAIL_RESPONSE,
  CHAT_ACCEPTED, CONVERSATION_SNAPSHOT_RESPONSE, HEALTH_RESPONSE, PERMISSION_ACCEPTED, RAG_QUERY_RESULT,
  SIM_START_RESULT, SIM_STOP_RESULT, STREAM_TICKET_RESPONSE, TWIN_ACTION_ACCEPTED, TWIN_SNAPSHOT,
} from './contract/http.mts'
import { validateValue, type Schema } from './contract/validate.mts'

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
const BUFFER_CAP = Number(process.env.AGENT_BFF_BUFFER_CAP ?? 1000) // env 覆盖仅供测试隔离（窗口越界路径）
const HEARTBEAT_MS = 25_000
const PERMISSION_TIMEOUT_MS = 10 * 60_000
const APPROVAL_TTL_MS = Number(process.env.AGENT_BFF_APPROVAL_TTL_MS ?? 5 * 60_000)
const AUDIT_FILE = process.env.AGENT_BFF_AUDIT_FILE ?? new URL('./.approval-audit.jsonl', import.meta.url)
const APPROVALS_FILE = process.env.AGENT_BFF_APPROVALS_FILE ?? new URL('./.approvals.json', import.meta.url)

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
// 业务对象、有效期、可审批角色。轻量持久化到 APPROVALS_FILE（任务 3.4：重启后状态可查；
// pending 承诺随进程消亡，重启加载时一律置 expired，旧批准不回放），
// 全部裁决结果追加持久化到 AUDIT_FILE（JSONL，可按会话/业务对象回溯）。
type ApprovalRecord = {
  requestId: string
  conversationId: string
  workflowId: string | null // 关联工作流（任务 4.2）：工作流登记路径回填，daemon 路径为 null
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
  // 契约出站校验（2.C）：统一注入版本字段 v，发出前按 contract/events.mts 校验；
  // 畸形事件记日志并丢弃——不进回放缓冲、不推送订阅者，绝不静默发畸形数据。
  const body = withVersion(event, (payload ?? {}) as Record<string, unknown>)
  const issues = validateEvent(event, body)
  if (issues.length) {
    console.error(`[agent-bff] SSE 事件契约校验失败（${event}）:`, issues)
    return
  }
  const entry: BufferedEvent = {
    id: ++conv.lastEventId,
    event,
    data: JSON.stringify(body),
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

// ---- 会话快照（任务 4.1）----
type SnapshotStep = { toolUseId: string | null; name: string; status: string; summary: string }
type SnapshotMessage = { role: 'user' | 'assistant'; text: string; steps: SnapshotStep[] }

/** 从 AGH 会话 UI 投影重建消息列表（bounded tail window；历史越窗时 complete=false）。
 *  user/assistant 节点映射为消息，tool 节点挂到最近一条助手消息的 steps。 */
async function readSnapshotMessages(session: Session): Promise<{ messages: SnapshotMessage[]; complete: boolean }> {
  const opening = await session.projectUIOpening({ maxNodes: 500 })
  type NodeLike = {
    kind?: string; content?: unknown; text?: unknown
    toolUseId?: unknown; name?: unknown; status?: unknown; summary?: unknown
  }
  const nodes = (opening.timeline?.nodes ?? []) as NodeLike[]
  const messages: SnapshotMessage[] = []
  for (const node of nodes) {
    if (node.kind === 'user') {
      const text = firstText(node.content)
      if (text) messages.push({ role: 'user', text, steps: [] })
    } else if (node.kind === 'assistant') {
      messages.push({ role: 'assistant', text: typeof node.text === 'string' ? node.text : '', steps: [] })
    } else if (node.kind === 'tool') {
      let host: SnapshotMessage | undefined
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'assistant') { host = messages[i]; break }
      }
      if (!host) {
        host = { role: 'assistant', text: '', steps: [] }
        messages.push(host)
      }
      host.steps.push({
        toolUseId: typeof node.toolUseId === 'string' ? node.toolUseId : null,
        name: typeof node.name === 'string' ? node.name : 'tool',
        status: typeof node.status === 'string' ? node.status : 'completed',
        summary: typeof node.summary === 'string' ? node.summary : '',
      })
    }
  }
  return { messages, complete: !opening.history?.hasEarlier }
}

/** 回放缓冲覆盖的最小 sinceId：buffer[0].id - 1；缓冲空时 = lastEventId（无事件可回放）。 */
function replayFloor(conv: Conversation): number {
  return conv.buffer.length ? conv.buffer[0].id - 1 : conv.lastEventId
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

// 审批记录轻量持久化（任务 3.4）：与 sessions 存储同款 JSON 文件方式。写失败只记日志
// 不阻断流程（持久化为可查性服务；审计落盘才是 fail-closed 的那一路）。
// 路径晚绑定 env：测试可在运行中切换 AGENT_BFF_APPROVALS_FILE。
function saveApprovals() {
  try {
    writeFileSync(process.env.AGENT_BFF_APPROVALS_FILE ?? APPROVALS_FILE, JSON.stringify(Object.fromEntries(approvals), null, 2))
  } catch (err) {
    console.error('[agent-bff] 审批记录持久化写入失败:', err)
  }
}

// 从持久化文件恢复审批记录（模块初始化与测试共用）。pending → expired：pending 承诺
// （daemon 回调）随进程消亡，重启后绝无可能再裁决，必须按过期处理、旧批准不回放；
// 转换经 onConverted 回调交调用方记审计。
function loadApprovalsFromFile(file: string | URL, onConverted?: (rec: ApprovalRecord) => void): ApprovalRecord[] {
  let raw: Record<string, ApprovalRecord>
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, ApprovalRecord>
  } catch {
    return []
  }
  const out: ApprovalRecord[] = []
  for (const rec of Object.values(raw)) {
    if (!rec || typeof rec !== 'object' || typeof rec.requestId !== 'string') continue
    if (typeof rec.workflowId !== 'string') rec.workflowId = null // 3.4 之前的存量记录无关联键，按 null 归一
    if (rec.status === 'pending') {
      rec.status = 'expired'
      onConverted?.(rec)
    }
    out.push(rec)
  }
  return out
}

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

function buildApprovalRecord(conv: Conversation, requestId: string, toolCall: Record<string, unknown>, ttlMs?: number, workflowId?: string): ApprovalRecord {
  const tool = String(toolCall.name ?? toolCall.title ?? '')
  const args = (toolCall.args ?? toolCall.arguments ?? {}) as Record<string, unknown>
  const { canonical, digest } = canonicalDigest(args)
  const risk = TOOL_RISK.get(tool) ?? 'UNKNOWN'
  const requiredRoles = risk === 'UNKNOWN' ? [] : (TOOL_ROLES[tool] ?? RISK_ROLES[risk])
  const now = Date.now()
  const record: ApprovalRecord = {
    requestId,
    conversationId: conv.id,
    workflowId: workflowId ?? null,
    tool,
    risk,
    argsDigest: digest,
    argsSummary: buildArgsSummary(tool, canonical),
    bizObject: extractBizObject(args),
    requiredRoles,
    createdAt: now,
    expiresAt: now + (ttlMs ?? APPROVAL_TTL_MS),
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
  saveApprovals()
  return record
}

/** 审批状态查询/登记响应的五要素摘要 + 状态（contract APPROVAL_STATUS_RESPONSE）。 */
function approvalSummary(record: ApprovalRecord) {
  return {
    requestId: record.requestId,
    conversationId: record.conversationId,
    workflowId: record.workflowId,
    tool: record.tool,
    risk: record.risk,
    argsDigest: record.argsDigest,
    argsSummary: record.argsSummary,
    bizObject: record.bizObject,
    requiredRoles: record.requiredRoles,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    status: record.status,
  }
}

// 惰性过期（仅无 daemon 承诺可 settle 的路径：GET 查询 / 工作流登记审批的裁决）：
// 读取时发现 pending 已过有效期 → 落 expired + 审计 + 持久化。返回是否发生了过期转换。
function expireIfDue(record: ApprovalRecord, by: string): boolean {
  if (record.status !== 'pending' || Date.now() <= record.expiresAt) return false
  record.status = 'expired'
  auditApproval(record, 'expired', by, '读取时发现已过有效期（惰性过期）')
  saveApprovals()
  return true
}

// 审计：批准/拒绝/过期/越权尝试/超时一律落 JSONL，含操作者、工具、参数摘要、业务对象。
// 与 business-service 的业务审计分工：那里记"工具执行了什么业务变更"，这里记"谁在
// 何时批准/拒绝了这次执行"（审批决策层，business-service 看不到审批拒绝与越权尝试）。
// 返回是否落盘成功：批准（allowed-once）路径对写失败 fail-closed（审计存不下就不放行）。
// 审计路径晚绑定 env：测试可在运行中切换 AGENT_BFF_AUDIT_FILE 制造写失败。
function writeAudit(entry: Record<string, unknown>): boolean {
  try {
    appendFileSync(process.env.AGENT_BFF_AUDIT_FILE ?? AUDIT_FILE, JSON.stringify(entry) + '\n')
    return true
  } catch (err) {
    console.error('[agent-bff] 审批审计写入失败:', err)
    return false
  }
}

function auditApproval(record: ApprovalRecord, result: string, by: string, detail?: string): boolean {
  return writeAudit({
    ts: new Date().toISOString(),
    conversationId: record.conversationId,
    workflowId: record.workflowId,
    requestId: record.requestId,
    by,
    tool: record.tool,
    risk: record.risk,
    argsDigest: record.argsDigest,
    argsSummary: record.argsSummary,
    bizObject: record.bizObject,
    result,
    ...(detail ? { detail } : {}),
  })
}

// 无法定位审批记录时的会话级留痕（跨用户探测 / 404 探测）
function auditAttempt(conversationId: string, requestId: string, by: string, detail: string) {
  writeAudit({
    ts: new Date().toISOString(),
    conversationId,
    requestId,
    by,
    tool: '',
    result: 'forbidden',
    detail,
  })
}

// 启动时恢复持久化的审批记录（任务 3.4）：遗留 pending 一律置 expired 并记审计——
// pending 承诺随进程消亡，旧批准不回放（1.2 语义保持，持久化只为状态可查）。
for (const rec of loadApprovalsFromFile(APPROVALS_FILE, (converted) => {
  auditApproval(converted, 'expired', 'system', 'BFF 重启，pending 承诺随进程消亡（旧批准不回放）')
})) {
  approvals.set(rec.requestId, rec)
}

// ---- 审计聚合视图（任务 4.2）----
// 关联键贯通：workflowId（检查点 + BFF 审批记录/审批审计）、requestId（审批五要素句柄，
// 检查点 pendingApproval/expiredApprovals/completedSteps.result.requestId 引用）、幂等键
// （检查点步骤 wfId:node:seq）、业务对象 ID（检查点 refs ↔ business-service 审计的
// objectType/objectId，业务请求 ID 在业务审计条目的 requestId 字段）。
// 聚合不到的环节一律进 degraded 标注（unknown），不编造。
// 角色闸（显式常量，同 1.2 RISK_ROLES 风格）：聚合链含全部用户的审批与业务留痕，仅 ADMIN。
const AUDIT_VIEW_ROLES = ['ADMIN']
const WORKFLOW_DIR = process.env.FJSP_WORKFLOW_DIR ?? join(homedir(), '.agh', 'fjsp-workflows')

// 检查点 refs → business-service audit_log.objectType（既有取值，见 AuditService 调用点）
const REF_OBJECT_TYPE: Record<string, string> = {
  eventId: 'event',
  taskId: 'schedule_task',
  planVersionId: 'plan_version',
}

type WorkflowCheckpointView = {
  pendingApproval?: { requestId?: string } | null
  expiredApprovals?: { requestId?: string }[]
  completedSteps?: { idempotencyKey?: string; result?: Record<string, unknown> }[]
  current?: { idempotencyKey?: string } | null
  refs?: Record<string, string | null>
} & Record<string, unknown>

function loadWorkflowCheckpoint(workflowId: string): { checkpoint: WorkflowCheckpointView | null; degraded: string | null } {
  const file = join(WORKFLOW_DIR, `${workflowId}.json`)
  if (!existsSync(file)) return { checkpoint: null, degraded: `workflow_checkpoint_missing（未找到 ${workflowId} 的检查点）` }
  try {
    return { checkpoint: JSON.parse(readFileSync(file, 'utf8')) as WorkflowCheckpointView, degraded: null }
  } catch (err) {
    return { checkpoint: null, degraded: `workflow_checkpoint_corrupt（检查点不可解析，拒绝猜测其内容）：${String(err)}` }
  }
}

/** 读审批审计 JSONL 全量行（解析失败的行记 degraded，不丢弃也不编造）。 */
function readApprovalAuditLines(): { entries: Record<string, unknown>[]; badLines: number } {
  const entries: Record<string, unknown>[] = []
  let badLines = 0
  let raw = ''
  try {
    raw = readFileSync(process.env.AGENT_BFF_AUDIT_FILE ?? AUDIT_FILE, 'utf8')
  } catch {
    return { entries, badLines: 0 } // 文件不存在 = 尚无审计记录，不算降级
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      entries.push(JSON.parse(line) as Record<string, unknown>)
    } catch {
      badLines += 1
    }
  }
  return { entries, badLines }
}

/** 业务审计（business-service /audit-logs，仅 ADMIN）：转发调用方 Bearer token，
 *  让 business-service 自己的鉴权再兜一道。不可达/无 token 时返回 error 供降级标注。 */
async function fetchBusinessAudit(token: string | null, objectType: string, objectId: string): Promise<{ items: Record<string, unknown>[]; error: string | null }> {
  if (!token) return { items: [], error: 'no_bearer_token（ticket 路径无法转发业务审计查询）' }
  try {
    const res = await fetch(`${FJSP_API_BASE}/audit-logs?objectType=${encodeURIComponent(objectType)}&objectId=${encodeURIComponent(objectId)}&size=200`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    })
    const env = (await res.json().catch(() => null)) as { data?: { items?: unknown } } | null
    if (!res.ok || !Array.isArray(env?.data?.items)) return { items: [], error: `business_audit_http_${res.status}` }
    return { items: env!.data!.items as Record<string, unknown>[], error: null }
  } catch (err) {
    return { items: [], error: `business_audit_unavailable（${String(err)}）` }
  }
}

/** 聚合一条审计链；返回 null 表示 workflowId 模式下检查点与审批记录都不存在（404）。 */
async function buildAuditTrail(
  q: { workflowId: string | null; objectType: string | null; objectId: string | null },
  token: string | null,
) {
  const degraded: string[] = []
  const requestIds = new Set<string>()
  const idempotencyKeys: string[] = []
  const refs: Record<string, string> = {}
  let checkpoint: WorkflowCheckpointView | null = null

  if (q.workflowId) {
    const r = loadWorkflowCheckpoint(q.workflowId)
    checkpoint = r.checkpoint
    if (r.degraded) degraded.push(r.degraded)
    if (checkpoint) {
      if (typeof checkpoint.pendingApproval?.requestId === 'string') requestIds.add(checkpoint.pendingApproval.requestId)
      for (const e of checkpoint.expiredApprovals ?? []) {
        if (typeof e?.requestId === 'string') requestIds.add(e.requestId)
      }
      for (const s of checkpoint.completedSteps ?? []) {
        if (typeof s?.idempotencyKey === 'string') idempotencyKeys.push(s.idempotencyKey)
        const rid = s?.result?.requestId
        if (typeof rid === 'string') requestIds.add(rid)
      }
      if (typeof checkpoint.current?.idempotencyKey === 'string') idempotencyKeys.push(checkpoint.current.idempotencyKey)
      for (const [k, v] of Object.entries(checkpoint.refs ?? {})) {
        if (typeof v === 'string' && v) refs[k] = v
      }
    }
  }

  // BFF 审批记录：workflow 模式按 workflowId/requestId 双键关联（存量无 workflowId 的记录
  // 仍能经检查点 requestId 关联上）；业务对象模式按 bizObject 值匹配
  const matchedApprovals: ApprovalRecord[] = []
  for (const rec of approvals.values()) {
    const hit = q.workflowId
      ? rec.workflowId === q.workflowId || requestIds.has(rec.requestId)
      : !!rec.bizObject && Object.values(rec.bizObject).includes(q.objectId as string)
    if (hit) {
      matchedApprovals.push(rec)
      requestIds.add(rec.requestId)
    }
  }
  if (q.workflowId && !checkpoint && matchedApprovals.length === 0) return null
  matchedApprovals.sort((a, b) => a.createdAt - b.createdAt)

  // 检查点引用了但本 BFF 找不到的审批记录：显式 unknown 标注，不编造
  if (q.workflowId) {
    const known = new Set(matchedApprovals.map((r) => r.requestId))
    for (const rid of requestIds) {
      if (!known.has(rid)) degraded.push(`approval_unknown（检查点引用的审批记录不在 BFF：${rid}）`)
    }
  }

  // BFF 审批裁决留痕（审计 JSONL）：按 workflowId 或已关联 requestId 归集
  const { entries: auditEntries, badLines } = readApprovalAuditLines()
  if (badLines) degraded.push(`approval_audit_bad_lines（${badLines} 行审计记录不可解析，已跳过）`)
  const approvalEvents = auditEntries.filter((e) =>
    (q.workflowId && e.workflowId === q.workflowId)
    || (typeof e.requestId === 'string' && requestIds.has(e.requestId))
    || (!q.workflowId && e.bizObject && typeof e.bizObject === 'object'
      && Object.values(e.bizObject as Record<string, unknown>).includes(q.objectId)))

  // 业务副作用：business-service 审计（业务请求 ID 在条目 requestId 字段）
  const bizTargets: { objectType: string; objectId: string }[] = q.workflowId
    ? Object.entries(refs).filter(([k]) => REF_OBJECT_TYPE[k]).map(([k, v]) => ({ objectType: REF_OBJECT_TYPE[k], objectId: v }))
    : [{ objectType: q.objectType as string, objectId: q.objectId as string }]
  const businessAudit: Record<string, unknown>[] = []
  const seenAuditIds = new Set<string>()
  for (const t of bizTargets) {
    const r = await fetchBusinessAudit(token, t.objectType, t.objectId)
    if (r.error) {
      degraded.push(`${r.error}（${t.objectType}/${t.objectId}）`)
      continue
    }
    for (const item of r.items) {
      const id = typeof item.id === 'string' ? item.id : JSON.stringify(item)
      if (seenAuditIds.has(id)) continue
      seenAuditIds.add(id)
      businessAudit.push(item)
    }
  }
  businessAudit.sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')))

  return {
    ok: true,
    query: q.workflowId ? { workflowId: q.workflowId } : { objectType: q.objectType, objectId: q.objectId },
    correlation: {
      requestIds: [...requestIds].sort(),
      idempotencyKeys,
      refs,
    },
    workflow: checkpoint,
    approvals: matchedApprovals.map(approvalSummary),
    approvalEvents,
    businessAudit,
    degraded,
  }
}


// 工作流登记的审批（POST /agent-api/approvals，无 daemon 承诺可 settle）的裁决路径：
// 与 daemon 路径同一套重校验（一次性已由上层 status!=='pending' 拦截、归属已校验），
// 差异只在无承诺可解——裁决落记录 + 持久化 + 广播 permission_resolved，工作流轮询 GET 拿结果。
function decideRegisteredApproval(
  record: ApprovalRecord,
  body: Record<string, unknown>,
  user: AuthUser,
  conv: Conversation,
  res: ServerResponse,
) {
  if (expireIfDue(record, user.username)) {
    return sendJson(res, 410, { error: 'approval_expired', detail: '审批请求已过期' })
  }
  const verdict = body.verdict === 'allowed-once' ? 'allowed-once' as const : 'rejected' as const
  if (verdict === 'allowed-once') {
    if (!record.requiredRoles.includes(user.role)) {
      auditApproval(record, 'forbidden', user.username, `角色 ${user.role || '(空)'} 不在可审批角色 [${record.requiredRoles.join(',')}]`)
      return sendJson(res, 403, {
        error: 'approval_forbidden',
        detail: `当前角色无权审批该操作（需要：${record.requiredRoles.join(' / ') || '无可用角色'}）`,
      })
    }
    // 审计先落盘再放行（fail-closed），与 daemon 路径一致
    if (!auditApproval(record, 'approved', user.username)) {
      return sendJson(res, 503, { error: 'audit_unavailable', detail: '审批审计写入失败，批准未生效，请重试或联系管理员' })
    }
    record.status = 'approved'
  } else {
    // 拒绝不受角色闸限制（安全操作，避免挂起方悬挂到超时）
    auditApproval(record, 'rejected', user.username)
    record.status = 'rejected'
  }
  saveApprovals()
  broadcast(conv, 'permission_resolved', { requestId: record.requestId, verdict: { verdict } })
  return sendJsonChecked(res, 202, { ok: true, verdict }, PERMISSION_ACCEPTED, 'permission')
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
        saveApprovals()
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
  sendJsonChecked(res, 202, { conversationId: conv.id, sessionId: conv.sessionId }, CHAT_ACCEPTED, 'chat')
}

function handleStream(conv: Conversation, req: IncomingMessage, res: ServerResponse, url: URL) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write(`: conversation ${conv.id}\n\n`)
  // Last-Event-ID 优先于 sinceId 参数：EventSource 自动重连复用原 URL（含首次接入的
  // sinceId）并携带 Last-Event-ID 头，头是更新的接收位置，以它为准避免重复回放。
  const since = Number(req.headers['last-event-id'] ?? url.searchParams.get('sinceId') ?? 0) || 0
  // 快照-订阅衔接（任务 4.1）：sinceId 已出回放缓冲窗口（since < floor 说明 (since, floor]
  // 区间的事件已被挤出缓冲，无法补齐）时，先下发 resync_required 控制帧再关闭——
  // 客户端据此重新取会话快照，而不是静默丢事件。该帧逐订阅者下发，不进缓冲、不占序号。
  if (since < replayFloor(conv)) {
    const frame = withVersion('resync_required', { lastEventId: conv.lastEventId })
    const issues = validateEvent('resync_required', frame)
    if (issues.length) console.error('[agent-bff] SSE 事件契约校验失败（resync_required）:', issues)
    else res.write(`event: resync_required\ndata: ${JSON.stringify(frame)}\n\n`)
    res.end()
    return
  }
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

// ---- 契约校验（2.C，contract/ 目录为单一事实源）----

/** 出站校验：关键端点响应发送前按契约校验，失败记日志并 500，不静默发畸形数据。 */
function sendJsonChecked(res: ServerResponse, status: number, payload: unknown, schema: Schema, tag: string) {
  const issues = validateValue(schema, payload)
  if (issues.length) {
    console.error(`[agent-bff] 响应契约校验失败（${tag}）:`, issues)
    return sendJson(res, 500, { error: 'contract_violation', detail: `响应不符合 API 契约（${tag}）` })
  }
  sendJson(res, status, payload)
}

/** 入站校验：请求体按端点契约校验，非法 400 invalid_request（缺字段/错类型）。
 *  兼容既有错误码：chat 的 message 缺失/错类型仍报 message_required。 */
function checkBody(method: string, path: string, body: unknown, res: ServerResponse): boolean {
  const endpoint = findEndpoint(method, path)
  if (!endpoint) return true
  const issues = validateRequestBody(endpoint, body)
  if (!issues.length) return true
  if (issues.some((i) => i.path.endsWith('.message'))) {
    sendJson(res, 400, { error: 'message_required' })
  } else {
    sendJson(res, 400, { error: 'invalid_request', detail: '请求体不符合 API 契约', issues })
  }
  return false
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
  try {
    return raw ? JSON.parse(raw) : {}
  } catch {
    // JSON 语法错误按契约属非法请求（外层 catch 映射 400 invalid_request）
    throw new Error('invalid_json')
  }
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
    if (req.method === 'GET' && path === '/agent-api/openapi.json') {
      // 由契约端点表实时生成（contract/http.mts），无静态文件，不会陈旧
      return sendJson(res, 200, buildOpenApi())
    }
    if (req.method === 'GET' && path === '/agent-api/health') {
      if (!existsSync(OWNER_FILE)) {
        return sendJsonChecked(res, 200, { ok: false, daemon: 'absent', hint: 'AGH daemon 未启动（未找到 owner.json），请先运行 agnes serve' }, HEALTH_RESPONSE, 'health')
      }
      try {
        await getClient()
        return sendJsonChecked(res, 200, {
          ok: true,
          daemon: 'connected',
          conversations: conversations.size,
          mhs: mhsHub.connected ? 'connected' : 'connecting',
        }, HEALTH_RESPONSE, 'health')
      } catch (err) {
        return sendJsonChecked(res, 200, { ok: false, daemon: 'unavailable', hint: String(err) }, HEALTH_RESPONSE, 'health')
      }
    }
    if (req.method === 'POST' && path === '/agent-api/stream-ticket') {
      // 只接受 Bearer JWT 换票：ticket 出现在 URL 里（泄露面大），不允许用 ticket 续票
      const header = req.headers.authorization ?? ''
      if (!header.startsWith('Bearer ')) return sendJson(res, 401, { error: 'unauthorized' })
      const result = await introspectToken(header.slice(7))
      if (result === 'unavailable') return sendJson(res, 503, { error: 'auth_unavailable', detail: `业务服务鉴权接口不可达（${FJSP_API_BASE}）` })
      if (!result) return sendJson(res, 401, { error: 'unauthorized' })
      return sendJsonChecked(res, 200, issueTicket(result), STREAM_TICKET_RESPONSE, 'stream-ticket')
    }
    if (req.method === 'GET' && path === '/agent-api/stream') {
      const user = await requireAuth(req, url, res)
      if (!user) return
      const convIdParam = url.searchParams.get('conversationId')
      if (convIdParam !== null && !/^[\w-]{1,80}$/.test(convIdParam)) {
        return sendJson(res, 400, { error: 'invalid_request', detail: 'conversationId 格式不符合契约', issues: [{ path: 'conversationId', message: '需匹配 ^[\\w-]{1,80}$' }] })
      }
      const conv = getConversation(convIdParam ?? undefined, user.username)
      if (!authorizeConversation(conv, user, res)) return
      return handleStream(conv, req, res, url)
    }
    if (req.method === 'GET' && path.startsWith('/agent-api/conversations/')) {
      // 会话快照（任务 4.1）：requireAuth + 归属校验（跨用户 403，legacy 403）；
      // 会话既不在内存也不在持久化存储时 404。消息自 AGH 会话 UI 投影重建（daemon
      // 不可用/历史越窗时 messagesComplete=false，前端退化到回放重建）；待审批项只
      // 返回仍有效的（读取时惰性过期核销；重启恢复的 expired 记录天然不在列）。
      const m = path.match(/^\/agent-api\/conversations\/([\w-]{1,80})\/snapshot$/)
      if (!m) return sendJson(res, 404, { error: 'not_found' })
      const user = await requireAuth(req, url, res)
      if (!user) return
      if (!conversations.has(m[1]) && !loadStore()[m[1]]) {
        return sendJson(res, 404, { error: 'conversation_not_found' })
      }
      const conv = getConversation(m[1], user.username)
      if (!authorizeConversation(conv, user, res)) return
      // 事件序号在进入 await 之前同步捕获（评审 Important-1）：await（ensureSession /
      // projectUIOpening）窗口内广播的事件序号 > 此值，前端以 sinceId=lastEventId 订阅
      // 时必然回放，保证「不漏」；代价是窗口内事件内容可能同时进了快照消息，回放产生
      // 极窄重复，由前端吸收（tool_call 按 toolUseId 去重、审批卡片按 requestId 去重、
      // 末条已封存助手消息全文相同的 assistant_message 丢弃）。
      const lastEventId = conv.lastEventId
      const replayFrom = replayFloor(conv)
      let messages: SnapshotMessage[] = []
      let messagesComplete = true // 会话从未建立（无 sessionId）时消息为空即完整
      if (conv.session || conv.sessionId) {
        try {
          const session = await ensureSession(conv)
          const r = await readSnapshotMessages(session)
          messages = r.messages
          messagesComplete = r.complete
        } catch (err) {
          console.error('[agent-bff] 会话快照消息重建失败（daemon 不可用？）:', err)
          messagesComplete = false
        }
      }
      const pendingApprovals: ReturnType<typeof approvalSummary>[] = []
      for (const rec of approvals.values()) {
        if (rec.conversationId !== conv.id || rec.status !== 'pending') continue
        expireIfDue(rec, user.username) // 快照读取即核对持久化记录：过期的一并核销
        if (rec.status === 'pending') pendingApprovals.push(approvalSummary(rec))
      }
      return sendJsonChecked(res, 200, {
        ok: true,
        conversationId: conv.id,
        sessionId: conv.sessionId,
        running: conv.busy,
        lastEventId,
        replayFrom,
        messages,
        messagesComplete,
        pendingApprovals,
      }, CONVERSATION_SNAPSHOT_RESPONSE, 'conversations/snapshot')
    }
    if (req.method === 'POST' && path === '/agent-api/chat') {
      const user = await requireAuth(req, url, res)
      if (!user) return
      const body = await readBody(req)
      if (!checkBody('POST', '/agent-api/chat', body, res)) return
      const conv = getConversation(typeof body.conversationId === 'string' ? body.conversationId : undefined, user.username)
      if (!authorizeConversation(conv, user, res)) return
      return await handleChat(conv, body, res)
    }
    if (req.method === 'POST' && path === '/agent-api/cancel') {
      const user = await requireAuth(req, url, res)
      if (!user) return
      const body = await readBody(req)
      if (!checkBody('POST', '/agent-api/cancel', body, res)) return
      const conv = conversations.get(String(body.conversationId ?? ''))
      if (!conv) return sendJson(res, 404, { error: 'conversation_not_found' })
      if (!authorizeConversation(conv, user, res)) return
      if (!conv.session) return sendJson(res, 404, { error: 'conversation_not_found' })
      await conv.session.cancel()
      return sendJsonChecked(res, 202, { ok: true }, { type: 'object', required: ['ok'] }, 'cancel')
    }
    if (req.method === 'POST' && path === '/agent-api/permission') {
      // 批准时重校验：a) 会话归属当前用户（authorizeConversation）；b) 审批未过期；
      // c) 当前用户角色 ∈ 可审批角色（内检/ticket 携带的 role 为准）；d) 未被裁决过。
      // 任一失败拒绝并记审计（含归属失败与 404 探测）；放行前再核对参数摘要与记录一致，
      // 且审计落盘必须先成功——审计写失败时批准 fail-closed 不生效。
      const user = await requireAuth(req, url, res)
      if (!user) return
      const body = await readBody(req)
      // 契约入站校验（缺字段/错类型 400）；形态合法但定位不到记录的 404 探测仍走下方审计留痕
      if (!checkBody('POST', '/agent-api/permission', body, res)) return
      const requestId = String(body.requestId ?? '')
      const conversationId = String(body.conversationId ?? '')
      const conv = conversations.get(conversationId)
      const record = approvals.get(requestId)
      if (conv && conv.owner !== user.username) {
        // 归属不符（含 legacy）：能定位 record 记 record 级，否则会话级留痕
        if (record) auditApproval(record, 'forbidden', user.username, `会话归属不符（属主 ${conv.owner ?? 'legacy'}）`)
        else auditAttempt(conversationId, requestId, user.username, '会话归属不符，审批记录不可定位')
        authorizeConversation(conv, user, res) // 写 403 响应
        return
      }
      if (!conv || !record || record.conversationId !== conv.id) {
        // 404 探测同样留痕
        if (record) auditApproval(record, 'forbidden', user.username, 'conversationId 与审批记录归属不符（404 探测）')
        else auditAttempt(conversationId, requestId, user.username, '审批记录/会话不存在（404 探测）')
        return sendJson(res, 404, { error: 'permission_not_found' })
      }
      if (record.status !== 'pending') {
        auditApproval(record, 'rejected', user.username, `重复裁决尝试（已是 ${record.status}）`)
        return sendJson(res, 409, { error: 'approval_already_decided', detail: '该审批已被裁决过' })
      }
      const pending = conv.pendingPermissions.get(requestId)
      if (!pending) {
        // 工作流登记的审批（POST /approvals，无 daemon 承诺）：同一套重校验，裁决落记录，
        // 工作流侧轮询 GET /approvals/:requestId 拿结果（任务 3.4）
        return decideRegisteredApproval(record, body, user, conv, res)
      }
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
        // 审计先落盘再放行：写失败时批准不生效（fail-closed），记录保持 pending 可重试
        if (!auditApproval(record, 'approved', user.username)) {
          return sendJson(res, 503, { error: 'audit_unavailable', detail: '审批审计写入失败，批准未生效，请重试或联系管理员' })
        }
        record.status = 'approved' // 已审计，settle 内不再重复
        saveApprovals()
      }
      pending.settle({ verdict }, verdict === 'allowed-once' ? 'approved' : 'rejected', user.username)
      return sendJsonChecked(res, 202, { ok: true, verdict }, PERMISSION_ACCEPTED, 'permission')
    }
    if (req.method === 'POST' && path === '/agent-api/approvals') {
      // 工作流挂起登记审批（任务 3.4）：五要素由 BFF 按 toolCall 服务端生成（与 daemon
      // 路径同一事实源），卡片经 SSE permission_request 下发给会话订阅者；无 daemon
      // 承诺可悬挂——裁决走 /permission（decideRegisteredApproval），工作流轮询 GET 拿结果。
      const user = await requireAuth(req, url, res)
      if (!user) return
      const body = await readBody(req)
      if (!checkBody('POST', '/agent-api/approvals', body, res)) return
      const conv = getConversation(String(body.conversationId), user.username)
      if (!authorizeConversation(conv, user, res)) return
      const toolCall = body.toolCall as Record<string, unknown>
      const requestId = randomUUID()
      const record = buildApprovalRecord(conv, requestId, toolCall, typeof body.ttlMs === 'number' ? body.ttlMs : undefined,
        typeof body.workflowId === 'string' ? body.workflowId : undefined)
      broadcast(conv, 'permission_request', {
        requestId,
        toolCall,
        options: [],
        deadlineMs: record.expiresAt,
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
      return sendJsonChecked(res, 202, { ok: true, approval: approvalSummary(record) }, APPROVAL_STATUS_RESPONSE, 'approvals/register')
    }
    if (req.method === 'GET' && path === '/agent-api/audit/trail') {
      // 审计聚合视图（任务 4.2）：requireAuth + ADMIN 角色闸（显式常量 AUDIT_VIEW_ROLES）。
      // 按 workflowId 或 objectType+objectId 聚合：工作流检查点 + BFF 审批记录与裁决留痕 +
      // business-service 业务审计（转发调用方 Bearer token，business-service 自身 ADMIN 闸再兜一道）。
      const user = await requireAuth(req, url, res)
      if (!user) return
      if (!AUDIT_VIEW_ROLES.includes(user.role)) {
        return sendJson(res, 403, { error: 'audit_forbidden', detail: `审计聚合视图仅对 ${AUDIT_VIEW_ROLES.join(' / ')} 开放` })
      }
      const workflowId = url.searchParams.get('workflowId')
      const objectType = url.searchParams.get('objectType')
      const objectId = url.searchParams.get('objectId')
      if (workflowId !== null && !/^wf-[A-Za-z0-9-]{1,80}$/.test(workflowId)) {
        return sendJson(res, 400, { error: 'invalid_request', detail: 'workflowId 格式不符合契约', issues: [{ path: 'workflowId', message: '需匹配 ^wf-[A-Za-z0-9-]{1,80}$' }] })
      }
      if (!workflowId && !(objectType && objectId)) {
        return sendJson(res, 400, { error: 'invalid_request', detail: '需指定 workflowId 或 objectType+objectId' })
      }
      const header = req.headers.authorization ?? ''
      const token = header.startsWith('Bearer ') ? header.slice(7) : null
      const trail = await buildAuditTrail({ workflowId, objectType, objectId }, token)
      if (!trail) return sendJson(res, 404, { error: 'workflow_not_found', detail: '未找到该工作流的检查点与审批记录' })
      if (url.searchParams.get('format') === 'jsonl') {
        // 导出完整链供复核：application/x-ndjson，一行一条，kind 区分来源。
        // 顺序稳定：meta（查询+关联键+降级标注）→ workflow 检查点 → approvals（按 createdAt）
        // → approval_events（审计文件原序）→ business_audit（按 createdAt）。
        const lines: Record<string, unknown>[] = [
          { kind: 'meta', query: trail.query, correlation: trail.correlation, degraded: trail.degraded },
          ...(trail.workflow ? [{ kind: 'workflow', ts: trail.workflow.createdAt ?? null, ...trail.workflow }] : []),
          ...trail.approvals.map((a) => ({ kind: 'approval', ts: new Date(a.createdAt).toISOString(), ...a })),
          ...trail.approvalEvents.map((e) => ({ kind: 'approval_event', ...e })),
          ...trail.businessAudit.map((b) => ({ kind: 'business_audit', ...b })),
        ]
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' })
        return res.end(lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
      }
      return sendJsonChecked(res, 200, trail, AUDIT_TRAIL_RESPONSE, 'audit/trail')
    }
    if (req.method === 'GET' && path.startsWith('/agent-api/approvals/')) {
      // 审批状态查询（任务 3.4）：requireAuth + 会话归属校验（与 /permission 同口径，
      // 越权查询记 forbidden 审计；conv 不在内存时以持久化会话属主为准）。
      const m = path.match(/^\/agent-api\/approvals\/([\w-]{1,80})$/)
      if (!m) return sendJson(res, 404, { error: 'not_found' })
      const user = await requireAuth(req, url, res)
      if (!user) return
      const record = approvals.get(m[1])
      if (!record) return sendJson(res, 404, { error: 'approval_not_found' })
      const owner = conversations.get(record.conversationId)?.owner ?? loadStore()[record.conversationId]?.owner ?? null
      if (!owner) {
        auditApproval(record, 'forbidden', user.username, '审批查询：会话为历史遗留（legacy）')
        return sendJson(res, 403, { error: 'conversation_legacy', detail: '历史会话无属主记录，请新建会话' })
      }
      if (owner !== user.username) {
        auditApproval(record, 'forbidden', user.username, `审批查询：会话归属不符（属主 ${owner}）`)
        return sendJson(res, 403, { error: 'conversation_forbidden', detail: '审批所属会话属于其他用户' })
      }
      expireIfDue(record, user.username)
      return sendJsonChecked(res, 200, { ok: true, approval: approvalSummary(record) }, APPROVAL_STATUS_RESPONSE, 'approvals/get')
    }
    if (req.method === 'GET' && path === '/agent-api/twin/snapshot') {
      if (!(await requireAuth(req, url, res))) return
      return sendJsonChecked(res, 200, await twinSnapshot(), TWIN_SNAPSHOT, 'twin/snapshot')
    }
    if (req.method === 'GET' && path === '/agent-api/twin/stream') {
      if (!(await requireAuth(req, url, res))) return
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      // 与 broadcast 同一契约：注入版本字段 v，发出前校验，畸形帧记日志跳过（流不断开）
      const writeTick = async () => {
        const frame = withVersion('twin', await twinSnapshot())
        const issues = validateEvent('twin', frame)
        if (issues.length) {
          console.error('[agent-bff] SSE 事件契约校验失败（twin）:', issues)
          return
        }
        res.write(`event: twin\ndata: ${JSON.stringify(frame)}\n\n`)
      }
      const tick = setInterval(() => void writeTick(), 1000)
      await writeTick()
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
      return sendJsonChecked(res, 202, { ok: true, device: id, action }, TWIN_ACTION_ACCEPTED, `twin/device/${action}`)
    }
    if (req.method === 'POST' && path === '/agent-api/twin/sim/start') {
      if (!(await requireAuth(req, url, res))) return
      // 非法 JSON 不吞：外层 catch 映射 400 invalid_request（吞掉会按默认机台清单启动仿真）
      const body = await readBody(req)
      if (!checkBody('POST', '/agent-api/twin/sim/start', body, res)) return
      const machines = Array.isArray(body.machines) ? body.machines.map(String) : undefined
      const r = await simStart(machines)
      return sendJsonChecked(res, r.started ? 202 : 409, r, SIM_START_RESULT, 'twin/sim/start')
    }
    if (req.method === 'POST' && path === '/agent-api/twin/sim/stop') {
      if (!(await requireAuth(req, url, res))) return
      return sendJsonChecked(res, 202, await simStop(), SIM_STOP_RESULT, 'twin/sim/stop')
    }
    if (req.method === 'POST' && path === '/agent-api/rag/experience-query') {
      if (!(await requireAuth(req, url, res))) return
      const body = await readBody(req)
      if (!checkBody('POST', '/agent-api/rag/experience-query', body, res)) return
      const result = await experienceQuery({
        eventType: typeof body.eventType === 'string' ? body.eventType : undefined,
        query: typeof body.query === 'string' ? body.query : undefined,
        limit: typeof body.limit === 'number' ? body.limit : undefined,
        loadLevel: typeof body.loadLevel === 'string' ? body.loadLevel : undefined,
        dueUrgency: typeof body.dueUrgency === 'string' ? body.dueUrgency : undefined,
      })
      return sendJsonChecked(res, 200, result, RAG_QUERY_RESULT, 'rag/experience-query')
    }
    sendJson(res, 404, { error: 'not_found' })
  } catch (err) {
    if (err instanceof Error && err.message === 'invalid_json') {
      return sendJson(res, 400, { error: 'invalid_request', detail: '请求体不是合法 JSON' })
    }
    sendJson(res, 500, { error: 'internal', detail: err instanceof Error ? err.message : String(err) })
  }
})

server.listen(PORT, HOST, () => {
  console.log(`[agent-bff] listening on http://${HOST}:${PORT}/agent-api (workspace ${AGH_HOME})`)
  mhsHub.start()
})

// 供 test-approval.mts（tsx 直接 import 本模块）注入审批请求、检查审批记录：
// 不新增任何 HTTP 测试端点，生产路径无 test-only 分支。
// loadApprovalsFromFile 供测试验证重启恢复语义（pending → expired）。
export { conversations, approvals, onPermissionRequest, loadApprovalsFromFile }
export type { Conversation, ApprovalRecord }

// contract/http.mts：agent-bff HTTP 端点契约的单一事实源。
// 每个端点声明 method/path/鉴权方式/请求体 schema/响应 schema；server.mts 用它做
// 入站 400 校验与关键端点出站校验，openapi.json 端点用它生成 OpenAPI 3.1 文档。
// schema 用 validate.mts 的 JSON Schema 子集，同一份对象直接嵌入 OpenAPI。
import { validateValue, type Issue, type Schema } from './validate.mts'

// ---- 公共片段 ----

/** 统一错误 envelope：4xx/5xx 均为 { error, detail?, issues? } */
export const ERROR_RESPONSE: Schema = {
  type: 'object',
  required: ['error'],
  properties: {
    error: { type: 'string' },
    detail: { type: 'string' },
    issues: { type: 'array', items: { type: 'object' } },
  },
}

const OK_FLAG = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } } satisfies Schema

/** 数字孪生快照（mhsHub.snapshot() + sim 状态；详细设备结构的事实源是 mhs.mts/AgnesHub，契约约束信封层） */
export const TWIN_SNAPSHOT: Schema = {
  type: 'object',
  required: ['hub', 'time', 'devices', 'world', 'sim'],
  properties: {
    hub: { type: 'string', enum: ['connected', 'connecting', 'unavailable'] },
    time: { type: 'number' },
    devices: { type: 'array', items: { type: 'object' } },
    world: { type: ['object', 'null'] },
    sim: { type: ['object', 'null'] },
  },
}

// ---- 请求体 schema ----

export const CHAT_REQUEST: Schema = {
  type: 'object',
  required: ['message'],
  properties: {
    conversationId: { type: 'string', pattern: '^[\\w-]{1,80}$' },
    message: { type: 'string', minLength: 1 },
    context: {
      type: 'object',
      properties: {
        section: { type: 'string' },
        title: { type: 'string' },
        route: { type: ['string', 'null'] },
        query: { type: 'object' },
      },
    },
  },
}

export const CANCEL_REQUEST: Schema = {
  type: 'object',
  required: ['conversationId'],
  properties: { conversationId: { type: 'string', minLength: 1 } },
}

export const PERMISSION_REQUEST: Schema = {
  type: 'object',
  required: ['conversationId', 'requestId', 'verdict'],
  properties: {
    conversationId: { type: 'string', minLength: 1 },
    requestId: { type: 'string', minLength: 1 },
    verdict: { type: 'string', enum: ['allowed-once', 'rejected'] },
  },
}

// 工作流挂起登记审批（任务 3.4）：五要素由 BFF 按 toolCall 服务端生成，与 daemon 路径同一事实源
export const APPROVAL_REGISTER_REQUEST: Schema = {
  type: 'object',
  required: ['conversationId', 'toolCall'],
  properties: {
    conversationId: { type: 'string', pattern: '^[\\w-]{1,80}$' },
    toolCall: {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string', minLength: 1 }, args: { type: 'object' } },
    },
    ttlMs: { type: 'integer', minimum: 15_000, maximum: 30 * 60_000 },
  },
}

export const RAG_QUERY_REQUEST: Schema = {
  type: 'object',
  properties: {
    eventType: { type: 'string' },
    query: { type: 'string' },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
  },
}

export const SIM_START_REQUEST: Schema = {
  type: 'object',
  properties: { machines: { type: 'array', items: { type: 'string' }, maxItems: 32 } },
}

// ---- 响应 schema ----

export const HEALTH_RESPONSE: Schema = {
  type: 'object',
  required: ['ok', 'daemon'],
  properties: {
    ok: { type: 'boolean' },
    daemon: { type: 'string', enum: ['connected', 'absent', 'unavailable'] },
    hint: { type: 'string' },
    conversations: { type: 'integer' },
    mhs: { type: 'string' },
  },
}

export const STREAM_TICKET_RESPONSE: Schema = {
  type: 'object',
  required: ['ticket', 'expiresAt'],
  properties: { ticket: { type: 'string' }, expiresAt: { type: 'number' } },
}

export const CHAT_ACCEPTED: Schema = {
  type: 'object',
  required: ['conversationId', 'sessionId'],
  properties: {
    conversationId: { type: 'string' },
    sessionId: { type: ['string', 'null'] },
  },
}

export const PERMISSION_ACCEPTED: Schema = {
  type: 'object',
  required: ['ok', 'verdict'],
  properties: { ok: { type: 'boolean' }, verdict: { type: 'string', enum: ['allowed-once', 'rejected'] } },
}

// 审批记录五要素摘要 + 状态（GET 查询 / POST 登记共用；任务 3.4）
export const APPROVAL_STATUS_RESPONSE: Schema = {
  type: 'object',
  required: ['ok', 'approval'],
  properties: {
    ok: { type: 'boolean' },
    approval: {
      type: 'object',
      required: ['requestId', 'conversationId', 'tool', 'risk', 'argsDigest', 'argsSummary', 'bizObject', 'requiredRoles', 'createdAt', 'expiresAt', 'status'],
      properties: {
        requestId: { type: 'string' },
        conversationId: { type: 'string' },
        tool: { type: 'string' },
        risk: { type: 'string', enum: ['READ', 'WRITE', 'HIGH_RISK', 'DESTRUCTIVE', 'UNKNOWN'] },
        argsDigest: { type: 'string' },
        argsSummary: { type: 'string' },
        bizObject: { type: ['object', 'null'] },
        requiredRoles: { type: 'array', items: { type: 'string' } },
        createdAt: { type: 'integer' },
        expiresAt: { type: 'integer' },
        status: { type: 'string', enum: ['pending', 'approved', 'rejected', 'expired', 'timeout'] },
      },
    },
  },
}

export const TWIN_ACTION_ACCEPTED: Schema = {
  type: 'object',
  required: ['ok', 'device', 'action'],
  properties: {
    ok: { type: 'boolean' },
    device: { type: 'string' },
    action: { type: 'string', enum: ['fault', 'recover'] },
  },
}

export const SIM_START_RESULT: Schema = {
  type: 'object',
  required: ['started'],
  properties: {
    started: { type: 'boolean' },
    reason: { type: 'string' },
    pid: { type: 'integer' },
    pids: { type: 'array', items: { type: 'integer' } },
    machines: { type: 'array', items: { type: 'string' } },
  },
}

export const SIM_STOP_RESULT: Schema = {
  type: 'object',
  required: ['stopped'],
  properties: { stopped: { type: 'integer' }, pids: { type: 'array', items: { type: 'integer' } } },
}

export const RAG_QUERY_RESULT: Schema = {
  type: 'object',
  required: ['ok', 'records'],
  properties: {
    ok: { type: 'boolean' },
    retrieval: { type: 'string', enum: ['recency', 'bm25', 'hybrid'] },
    total: { type: 'integer' },
    matched: { type: 'integer' },
    records: { type: 'array', items: { type: 'object' } },
    recommendation: { type: ['object', 'null'] },
  },
}

// ---- 端点表 ----

export type EndpointAuth = 'public' | 'bearer' | 'ticket'
export type EndpointContract = {
  method: 'GET' | 'POST'
  /** OpenAPI 形态路径（路径参数用 {id}） */
  path: string
  summary: string
  auth: EndpointAuth
  requestBody?: Schema
  /** 关键响应：status → schema；'sse'/'binary' 表示非 JSON 负载，仅作文档标注 */
  responses: Record<number, Schema | 'sse' | 'binary'>
}

export const HTTP_CONTRACT: EndpointContract[] = [
  {
    method: 'GET', path: '/agent-api/health', summary: 'BFF 与 AGH daemon 连通性状态', auth: 'public',
    responses: { 200: HEALTH_RESPONSE },
  },
  {
    method: 'GET', path: '/agent-api/openapi.json', summary: '本契约生成的 OpenAPI 3.1 文档', auth: 'public',
    responses: { 200: { type: 'object' } },
  },
  {
    method: 'POST', path: '/agent-api/stream-ticket', summary: 'Bearer JWT 换 60s SSE 限时 ticket', auth: 'bearer',
    responses: { 200: STREAM_TICKET_RESPONSE, 401: ERROR_RESPONSE, 503: ERROR_RESPONSE },
  },
  {
    method: 'GET', path: '/agent-api/stream', summary: '会话 SSE 事件流（事件集见 contract/events.mts，支持 sinceId/Last-Event-ID 增量回放）', auth: 'ticket',
    responses: { 200: 'sse', 400: ERROR_RESPONSE, 401: ERROR_RESPONSE, 403: ERROR_RESPONSE },
  },
  {
    method: 'POST', path: '/agent-api/chat', summary: '发送消息（异步回合，事件经 SSE 下发）', auth: 'bearer',
    requestBody: CHAT_REQUEST,
    responses: { 202: CHAT_ACCEPTED, 400: ERROR_RESPONSE, 401: ERROR_RESPONSE, 403: ERROR_RESPONSE, 409: ERROR_RESPONSE, 503: ERROR_RESPONSE },
  },
  {
    method: 'POST', path: '/agent-api/cancel', summary: '取消当前回合', auth: 'bearer',
    requestBody: CANCEL_REQUEST,
    responses: { 202: OK_FLAG, 400: ERROR_RESPONSE, 401: ERROR_RESPONSE, 403: ERROR_RESPONSE, 404: ERROR_RESPONSE },
  },
  {
    method: 'POST', path: '/agent-api/permission', summary: '审批裁决（五要素重校验 + 审计，见 1.2）', auth: 'bearer',
    requestBody: PERMISSION_REQUEST,
    responses: { 202: PERMISSION_ACCEPTED, 400: ERROR_RESPONSE, 401: ERROR_RESPONSE, 403: ERROR_RESPONSE, 404: ERROR_RESPONSE, 409: ERROR_RESPONSE, 410: ERROR_RESPONSE, 503: ERROR_RESPONSE },
  },
  {
    method: 'POST', path: '/agent-api/approvals', summary: '登记审批请求（工作流挂起接线，任务 3.4；五要素服务端生成 + SSE 卡片下发）', auth: 'bearer',
    requestBody: APPROVAL_REGISTER_REQUEST,
    responses: { 202: APPROVAL_STATUS_RESPONSE, 400: ERROR_RESPONSE, 401: ERROR_RESPONSE, 403: ERROR_RESPONSE },
  },
  {
    method: 'GET', path: '/agent-api/approvals/{id}', summary: '审批状态查询（五要素摘要 + 状态；路径参数为 requestId，任务 3.4）', auth: 'bearer',
    responses: { 200: APPROVAL_STATUS_RESPONSE, 401: ERROR_RESPONSE, 403: ERROR_RESPONSE, 404: ERROR_RESPONSE },
  },
  {
    method: 'GET', path: '/agent-api/twin/snapshot', summary: 'MHS 设备快照（数字孪生页）', auth: 'bearer',
    responses: { 200: TWIN_SNAPSHOT, 401: ERROR_RESPONSE },
  },
  {
    method: 'GET', path: '/agent-api/twin/stream', summary: '设备快照 SSE 流（1Hz，事件名 twin）', auth: 'ticket',
    responses: { 200: 'sse', 401: ERROR_RESPONSE },
  },
  {
    method: 'GET', path: '/agent-api/twin/device/{id}/panel', summary: '设备面板 JPEG（<img> 直连，公开）', auth: 'public',
    responses: { 200: 'binary', 404: ERROR_RESPONSE },
  },
  {
    method: 'GET', path: '/agent-api/twin/grid', summary: '车间平面图 PNG（公开）', auth: 'public',
    responses: { 200: 'binary', 404: ERROR_RESPONSE },
  },
  {
    method: 'POST', path: '/agent-api/twin/device/{id}/fault', summary: '故障注入（写触发文件，仿真下一拍消费）', auth: 'bearer',
    responses: { 202: TWIN_ACTION_ACCEPTED, 400: ERROR_RESPONSE, 401: ERROR_RESPONSE, 409: ERROR_RESPONSE },
  },
  {
    method: 'POST', path: '/agent-api/twin/device/{id}/recover', summary: '故障恢复', auth: 'bearer',
    responses: { 202: TWIN_ACTION_ACCEPTED, 400: ERROR_RESPONSE, 401: ERROR_RESPONSE, 409: ERROR_RESPONSE },
  },
  {
    method: 'POST', path: '/agent-api/twin/sim/start', summary: '启动 MHS 仿真进程', auth: 'bearer',
    requestBody: SIM_START_REQUEST,
    responses: { 202: SIM_START_RESULT, 400: ERROR_RESPONSE, 401: ERROR_RESPONSE, 409: SIM_START_RESULT },
  },
  {
    method: 'POST', path: '/agent-api/twin/sim/stop', summary: '停止 MHS 仿真进程', auth: 'bearer',
    responses: { 202: SIM_STOP_RESULT, 401: ERROR_RESPONSE },
  },
  {
    method: 'POST', path: '/agent-api/rag/experience-query', summary: '处置经验检索（向量 + BM25 双路召回）', auth: 'bearer',
    requestBody: RAG_QUERY_REQUEST,
    responses: { 200: RAG_QUERY_RESULT, 400: ERROR_RESPONSE, 401: ERROR_RESPONSE },
  },
]

export function findEndpoint(method: string, path: string): EndpointContract | undefined {
  return HTTP_CONTRACT.find((e) => e.method === method && e.path === path)
}

/** 入站请求体校验：返回问题列表（空 = 通过）。端点未声明 requestBody 时不校验。 */
export function validateRequestBody(endpoint: EndpointContract, body: unknown): Issue[] {
  if (!endpoint.requestBody) return []
  return validateValue(endpoint.requestBody, body ?? {})
}

// ---- OpenAPI 3.1 导出 ----

/** 从端点表生成 OpenAPI 3.1 文档（type 数组/integer 等子集在 3.1 下合法，直接嵌入）。 */
export function buildOpenApi(): Record<string, unknown> {
  const paths: Record<string, unknown> = {}
  for (const ep of HTTP_CONTRACT) {
    const op: Record<string, unknown> = {
      summary: ep.summary,
      responses: Object.fromEntries(Object.entries(ep.responses).map(([status, schema]) => [
        status,
        schema === 'sse'
          ? { description: 'text/event-stream（SSE 事件契约见 contract/EVENTS.md）' }
          : schema === 'binary'
            ? { description: '二进制负载（image/jpeg 或 image/png）' }
            : { description: status.startsWith('2') ? '成功' : '错误', content: { 'application/json': { schema } } },
      ])),
    }
    if (ep.auth === 'bearer') op.security = [{ bearerAuth: [] }]
    if (ep.auth === 'ticket') op.security = [{ bearerAuth: [] }, { ticketAuth: [] }]
    if (ep.path.includes('{id}')) {
      op.parameters = [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }]
    }
    if (ep.path === '/agent-api/stream') {
      op.parameters = [
        { name: 'conversationId', in: 'query', required: false, schema: { type: 'string', pattern: '^[\\w-]{1,80}$' } },
        { name: 'ticket', in: 'query', required: false, schema: { type: 'string' } },
        { name: 'sinceId', in: 'query', required: false, schema: { type: 'integer' } },
      ]
    }
    if (ep.requestBody) {
      op.requestBody = { required: true, content: { 'application/json': { schema: ep.requestBody } } }
    }
    const entry = (paths[ep.path] ??= {})
    ;(entry as Record<string, unknown>)[ep.method.toLowerCase()] = op
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'agent-bff API（FJSP 调度副驾 BFF）',
      version: '1.0.0',
      description: '由 agh-integration/agent-bff/contract/http.mts 端点表生成；SSE 事件契约见 contract/EVENTS.md。',
    },
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        ticketAuth: { type: 'apiKey', in: 'query', name: 'ticket' },
      },
    },
  }
}

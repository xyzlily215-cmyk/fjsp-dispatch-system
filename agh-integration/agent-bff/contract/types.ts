// contract/types.ts：BFF HTTP/SSE 线协议的 TypeScript 类型定义（纯类型，无运行时代码）。
// 单一事实源：web-vue 的 src/api/agent.ts 以 `import type` 从这里派生（禁止再手写一份），
// server.mts 的运行时校验 schema 在同目录 http.mts / events.mts，两者须同步演进
// （契约测试 test-contract-api.mts 会抽样核对两侧一致性）。
// 版本语义：SSE 事件 payload 均带 `v`（当前 1）；新增事件/可选字段向后兼容不升版，
// 破坏性变更升版本号，详见 EVENTS.md。

/** BFF 健康状态（GET /agent-api/health） */
export interface AgentHealth {
  ok: boolean;
  daemon?: 'connected' | 'absent' | 'unavailable' | string;
  hint?: string;
  mhs?: string;
  conversations?: number;
}

/** 随消息附带的页面上下文（BFF 拼入提示词） */
export interface AgentPageContext {
  section?: string;
  title?: string;
  /** vue-router 的 route.name 含 symbol 形态；symbol 不可 JSON 序列化，线上只会出现 string/null（BFF schema 据此校验） */
  route?: string | symbol | null;
  query?: Record<string, unknown>;
}

/** POST /agent-api/chat 请求体 */
export interface ChatRequest {
  conversationId?: string;
  message: string;
  context?: AgentPageContext;
}

/** POST /agent-api/chat 202 响应 */
export interface ChatAccepted {
  conversationId: string;
  sessionId?: string | null;
}

/** POST /agent-api/cancel 请求体 */
export interface CancelRequest {
  conversationId: string;
}

/** 审批裁决取值（POST /agent-api/permission） */
export type PermissionVerdict = 'allowed-once' | 'rejected';

/** POST /agent-api/permission 请求体 */
export interface PermissionRequest {
  conversationId: string;
  requestId: string;
  verdict: PermissionVerdict;
}

/** POST /agent-api/stream-ticket 200 响应（60s SSE 限时 ticket） */
export interface StreamTicket {
  ticket: string;
  expiresAt: number;
}

/** POST /agent-api/rag/experience-query 请求体 */
export interface RagQueryRequest {
  eventType?: string;
  query?: string;
  limit?: number;
}

/** POST /agent-api/twin/sim/start 请求体 */
export interface SimStartRequest {
  machines?: string[];
}

/** 统一错误 envelope（4xx/5xx） */
export interface ApiErrorResponse {
  error: string;
  detail?: string;
  issues?: { path: string; message: string }[];
}

/** 审批五要素（BFF 在 permission_request 中随卡片下发，供人类可读展示） */
export interface ApprovalInfo {
  tool: string;
  risk: 'READ' | 'WRITE' | 'HIGH_RISK' | 'DESTRUCTIVE' | 'UNKNOWN';
  /** 人类可读摘要：工具名 + 规范化参数（截断） */
  summary: string;
  /** 参数规范化 JSON 的 SHA-256 前 12 位 */
  digest: string;
  bizObject: Record<string, string> | null;
  requiredRoles: string[];
  expiresAt: number;
}

/** 数字孪生 SSE 事件（twin）信封：快照详细结构的事实源是 agent-bff/mhs.mts 的
 *  AgnesHub（设备层字段由前端 src/api/twin.ts 展开），契约层只约束信封。 */
export interface TwinEventPayload {
  v: number;
  hub: 'connected' | 'connecting' | 'unavailable';
  time: number;
  devices: unknown[];
  world: unknown | null;
  sim: unknown | null;
}

/** SSE 事件名 → payload（与 contract/events.mts 的注册表一一对应；v = 协议版本） */
export interface AgentStreamEvents {
  user_message: { v: number; text: string; context: AgentPageContext | null };
  turn_start: { v: number };
  assistant_delta: { v: number; delta: string; offset: number };
  assistant_message: { v: number; seq: number; text: string };
  tool_call: { v: number; seq: number; name: string; args: unknown; toolUseId: string | null };
  tool_result: { v: number; seq: number; toolUseId: string | null; code: string; isError: boolean; text: string };
  permission_request: {
    v: number;
    requestId: string;
    toolCall: Record<string, unknown>;
    options: unknown[];
    /** BFF 侧恒为 number（daemon 未给 deadline 时按超时上限兜底），与 events.mts schema 一致 */
    deadlineMs: number;
    /** 1.2 起 BFF 恒下发五要素；前端展示层如需兼容旧版 BFF，在卡片层自行做缺省兜底 */
    approval: ApprovalInfo;
  };
  permission_resolved: { v: number; requestId: string; verdict: unknown };
  turn_end: { v: number; reason: string; stopReason: string };
  turn_error: { v: number; message: string; detail?: unknown };
  stream_closed: { v: number };
}

export type AgentEventName = keyof AgentStreamEvents;

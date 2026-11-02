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

/** 审批记录状态（GET /agent-api/approvals/{requestId}；not_found 走 HTTP 404 不进此枚举） */
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'timeout';

/** 审批状态查询/登记响应中的审批记录（五要素摘要 + 状态，任务 3.4） */
export interface ApprovalStatusInfo {
  requestId: string;
  conversationId: string;
  /** 关联工作流（任务 4.2，工作流登记路径回填）；daemon 路径的审批为 null */
  workflowId: string | null;
  tool: string;
  risk: ApprovalInfo['risk'];
  /** 参数规范化 JSON 的完整 SHA-256（区别于卡片上下文的 12 位前缀） */
  argsDigest: string;
  argsSummary: string;
  bizObject: Record<string, string> | null;
  requiredRoles: string[];
  createdAt: number;
  expiresAt: number;
  status: ApprovalStatus;
}

/** 审计聚合视图（GET /agent-api/audit/trail，任务 4.2，仅 ADMIN）的关联键集合 */
export interface AuditTrailCorrelation {
  /** 审批请求 ID（检查点 pendingApproval/expiredApprovals/completedSteps.result.requestId + 命中的审批记录） */
  requestIds: string[];
  /** 步骤幂等键（检查点步骤 wfId:node:seq） */
  idempotencyKeys: string[];
  /** 业务对象引用（eventId/taskId/planVersionId → 业务审计 objectType/objectId） */
  refs: Record<string, string>;
}

/** GET /agent-api/audit/trail 200 响应（任务 4.2 审计聚合视图，仅 ADMIN）。
 *  workflow 为工作流检查点原文透传（无检查点时 null 并在 degraded 标注）；
 *  approvalEvents 为 BFF 审批审计 JSONL 条目透传；businessAudit 为 business-service
 *  audit_log 条目透传（含业务请求 ID requestId）。degraded 列出聚合不到的环节
 *  （unknown 标注，不编造）。format=jsonl 时同内容以 application/x-ndjson 逐行导出。 */
export interface AuditTrail {
  ok: boolean;
  query: { workflowId?: string; objectType?: string; objectId?: string };
  correlation: AuditTrailCorrelation;
  workflow: Record<string, unknown> | null;
  approvals: ApprovalStatusInfo[];
  approvalEvents: Record<string, unknown>[];
  businessAudit: Record<string, unknown>[];
  degraded: string[];
}

/** 会话快照消息中的工具步骤（自 AGH 会话 UI 投影 tool 节点映射，任务 4.1） */
export interface ConversationSnapshotStep {
  toolUseId: string | null;
  name: string;
  /** daemon UI 投影的工具状态枚举（planned/awaiting_approval/running/completed/failed/cancelled） */
  status: string;
  summary: string;
}

/** 会话快照消息（自 AGH 会话 UI 投影重建） */
export interface ConversationSnapshotMessage {
  role: 'user' | 'assistant';
  text: string;
  steps: ConversationSnapshotStep[];
}

/** GET /agent-api/conversations/{id}/snapshot 200 响应（任务 4.1：断线恢复）。
 *  衔接约定：messagesComplete=true 时以 sinceId=lastEventId 订阅（快照时刻后的事件由
 *  回放补齐，不丢不重）；false 时以 sinceId=replayFrom 订阅（走回放缓冲重建界面）。
 *  pendingApprovals 只含仍有效（pending 且未过期）的审批，快照时刻已失效的不在列。 */
export interface ConversationSnapshot {
  ok: boolean;
  conversationId: string;
  sessionId: string | null;
  /** 快照时刻是否有回合在执行（BFF 侧 busy） */
  running: boolean;
  /** 快照时刻会话最新事件序号 */
  lastEventId: number;
  /** 回放缓冲覆盖的最小 sinceId（buffer[0].id - 1，缓冲空时 = lastEventId） */
  replayFrom: number;
  messages: ConversationSnapshotMessage[];
  messagesComplete: boolean;
  pendingApprovals: ApprovalStatusInfo[];
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
  /** 订阅序号已出回放缓冲窗口（逐订阅者控制帧，不进回放缓冲）；收到后重新取快照再订阅 */
  resync_required: { v: number; lastEventId: number };
}

export type AgentEventName = keyof AgentStreamEvents;

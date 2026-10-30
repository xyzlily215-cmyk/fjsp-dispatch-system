/* agent-bff 访问层：AI 调度副驾与 AGH daemon 之间的 HTTP/SSE 桥（agent-bff/server.mts）。
 * 本机（loopback）页面默认直连 127.0.0.1:4178（agent-bff 对 loopback 源开放 CORS），
 * 不依赖同源 /agent-api 反代——start-demo.sh 的 python http.server 没有代理能力；
 * 非本机部署回退同源 /agent-api（由前置反代转发）。
 * 可用 ?bff= 或 localStorage 'fjsp.agentBff' 覆盖，与 api/index.js 相同的本机信任规则。 */

/** BFF 健康状态（/agent-api/health） */
export interface AgentHealth {
  ok: boolean;
  daemon?: string;
  hint?: string;
  mhs?: string;
  conversations?: number;
}

/** 随消息附带的页面上下文（BFF 拼入提示词） */
export interface AgentPageContext {
  section?: string;
  title?: string;
  route?: string | symbol | null;
  query?: Record<string, unknown>;
}

export interface ChatAccepted {
  conversationId: string;
  sessionId?: string;
}

/** SSE 事件名 → payload（与 agent-bff/server.mts 的 broadcast 一一对应） */
export interface AgentStreamEvents {
  user_message: { text: string; context: AgentPageContext | null };
  turn_start: Record<string, never>;
  assistant_delta: { delta: string; offset: number };
  assistant_message: { seq: number; text: string };
  tool_call: { seq: number; name: string; args: unknown; toolUseId: string | null };
  tool_result: { seq: number; toolUseId: string | null; code: string; isError: boolean; text: string };
  permission_request: {
    requestId: string;
    toolCall: Record<string, unknown>;
    options: unknown[];
    deadlineMs: number | null;
  };
  permission_resolved: { requestId: string; verdict: unknown };
  turn_end: { reason: string; stopReason: string };
  turn_error: { message: string; detail?: unknown };
  stream_closed: Record<string, never>;
}

export type AgentEventName = keyof AgentStreamEvents;
export type AgentEventHandlers = {
  [K in AgentEventName]?: (data: AgentStreamEvents[K], eventId: number) => void;
} & {
  onOpen?: () => void;
  onError?: () => void;
};

function trustedBffBase(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const loopback = (host: string) => ['localhost', '127.0.0.1', '[::1]'].includes(host);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
        || url.search || url.hash || url.pathname !== '/agent-api') return null;
    if (url.origin === location.origin
        || (loopback(location.hostname) && loopback(url.hostname))) return url.href;
  } catch { /* 无效 URL 不作为 BFF 地址 */ }
  return null;
}

export const AGENT_API_BASE = trustedBffBase(new URLSearchParams(location.search).get('bff'))
  || localStorage.getItem('fjsp.agentBff')
  || (['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
    ? 'http://127.0.0.1:4178/agent-api'
    : '/agent-api');

export class AgentApiError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(AGENT_API_BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AgentApiError('network', '无法连接智能体服务（agent-bff），请确认 agent-bff 已启动');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new AgentApiError(data.error || String(res.status), data.detail || data.error || '请求失败');
  return data as T;
}

export function agentHealth(): Promise<AgentHealth> {
  return fetch(AGENT_API_BASE + '/health')
    .then((r) => r.json())
    .catch(() => ({ ok: false, daemon: 'unavailable', hint: 'agent-bff 未启动' } as AgentHealth));
}

export function agentChat(opts: { conversationId: string; message: string; context?: AgentPageContext }) {
  return post<ChatAccepted>('/chat', opts);
}

export function agentCancel(conversationId: string) {
  return post<{ ok: boolean }>('/cancel', { conversationId });
}

export function agentPermission(opts: { conversationId: string; requestId: string; verdict: 'allowed-once' | 'rejected' }) {
  return post<{ ok: boolean; verdict: string }>('/permission', opts);
}

/* SSE 订阅：EventSource 自动重连并带 Last-Event-ID，断线只补增量。
 * handlers 按事件名注册，返回关闭函数。 */
const STREAM_EVENTS: AgentEventName[] = [
  'user_message', 'turn_start', 'assistant_delta', 'assistant_message',
  'tool_call', 'tool_result', 'permission_request', 'permission_resolved',
  'turn_end', 'turn_error', 'stream_closed',
];

export function openAgentStream(conversationId: string, handlers: AgentEventHandlers): () => void {
  const source = new EventSource(
    `${AGENT_API_BASE}/stream?conversationId=${encodeURIComponent(conversationId)}`,
  );
  for (const type of STREAM_EVENTS) {
    const handler = handlers[type] as ((data: unknown, eventId: number) => void) | undefined;
    if (!handler) continue;
    source.addEventListener(type, (ev) => {
      const evt = ev as MessageEvent & { lastEventId: string };
      let data: unknown = null;
      try { data = JSON.parse(evt.data); } catch { /* 心跳等非 JSON 帧忽略 */ }
      handler(data, Number(evt.lastEventId) || 0);
    });
  }
  if (handlers.onOpen) source.onopen = handlers.onOpen;
  if (handlers.onError) source.onerror = handlers.onError;
  return () => source.close();
}

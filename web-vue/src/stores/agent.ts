/* AI 调度副驾会话状态：消息流、工具步骤、待审批卡片、SSE 连接。
 * 单一事实来源是 agent-bff 的事件缓冲——页面刷新后由 SSE 全量回放重建，
 * 因此发送消息不做本地回显（乐观回声仅在用户消息上，按内容去重）。 */
import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import {
  agentCancel, agentChat, agentHealth, agentPermission, openAgentStream,
  type AgentEventName, type AgentHealth, type AgentPageContext, type AgentStreamEvents,
} from '../api/agent';

const CONVERSATION_KEY = 'fjsp.agentConversation';

export type StepStatus = 'running' | 'done' | 'error';

export interface AgentToolStep {
  toolUseId: string | null;
  seq?: number;
  name: string;
  args: unknown;
  status: StepStatus;
  code: string;
  resultPreview: string;
}

export interface AgentMessage {
  role: 'user' | 'assistant';
  text: string;
  pending?: boolean;
  streaming?: boolean;
  sealed?: boolean;
  error?: boolean;
  steps: AgentToolStep[];
}

export interface ApprovalCard {
  requestId: string;
  toolCall: Record<string, unknown>;
  options: unknown[];
  deadlineMs: number;
  resolving: '' | 'allowed-once' | 'rejected';
}

function newConversationId(): string {
  return (typeof crypto.randomUUID === 'function' && crypto.randomUUID())
    || ('conv-' + Date.now() + '-' + Math.random().toString(36).slice(2));
}

export const useAgentStore = defineStore('agent', () => {
  const conversationId = ref(localStorage.getItem(CONVERSATION_KEY) || newConversationId());
  localStorage.setItem(CONVERSATION_KEY, conversationId.value);

  const messages = ref<AgentMessage[]>([]);
  const approvals = ref<ApprovalCard[]>([]);
  const busy = ref(false);
  const connected = ref(false);  // SSE 已打开
  const health = ref<AgentHealth | null>(null);
  const unread = ref(0);
  const sessionId = ref('');

  let closeStream: (() => void) | null = null;
  let currentAssistant: AgentMessage | null = null;
  let everOpened = false;

  function ensureAssistant(): AgentMessage {
    if (currentAssistant && !currentAssistant.sealed) return currentAssistant;
    currentAssistant = { role: 'assistant', text: '', streaming: false, sealed: false, error: false, steps: [] };
    messages.value.push(currentAssistant);
    return currentAssistant;
  }

  function sealAssistant() {
    if (currentAssistant) currentAssistant.sealed = true;
    currentAssistant = null;
  }

  function findStep(toolUseId: string): AgentToolStep | null {
    for (let i = messages.value.length - 1; i >= 0; i--) {
      const msg = messages.value[i];
      if (msg.role !== 'assistant') continue;
      const step = msg.steps.find((s) => s.toolUseId && s.toolUseId === toolUseId);
      if (step) return step;
    }
    return null;
  }

  const handlers: { [K in AgentEventName]?: (data: AgentStreamEvents[K]) => void } & {
    onOpen: () => void;
    onError: () => void;
  } = {
    user_message(data) {
      const last = messages.value[messages.value.length - 1];
      // 发送时已做乐观回声：同内容只确认，不重复入列
      if (last && last.role === 'user' && last.pending && last.text === data.text) {
        last.pending = false;
        return;
      }
      messages.value.push({ role: 'user', text: data.text, pending: false, steps: [] });
      sealAssistant();
    },
    turn_start() {
      busy.value = true;
      sealAssistant();
    },
    assistant_delta(data) {
      const msg = ensureAssistant();
      msg.streaming = true;
      msg.text += data.delta;
    },
    assistant_message(data) {
      // 提交帧是流式增量的最终态：整段替换而非追加
      const msg = ensureAssistant();
      msg.text = data.text;
      msg.streaming = false;
      msg.sealed = true;
      currentAssistant = null;
      unread.value += 1;
    },
    tool_call(data) {
      const msg = ensureAssistant();
      msg.steps.push({
        toolUseId: data.toolUseId,
        seq: data.seq,
        name: data.name,
        args: data.args,
        status: 'running',
        code: '',
        resultPreview: '',
      });
    },
    tool_result(data) {
      const step = (data.toolUseId && findStep(data.toolUseId))
        || (ensureAssistant().steps.filter((s) => s.status === 'running').pop());
      if (!step) return;
      step.status = data.isError ? 'error' : 'done';
      step.code = data.code || '';
      step.resultPreview = (data.text || '').slice(0, 400);
    },
    permission_request(data) {
      approvals.value.push({
        requestId: data.requestId,
        toolCall: data.toolCall || {},
        options: data.options || [],
        deadlineMs: data.deadlineMs || 0,
        resolving: '',
      });
      unread.value += 1;
    },
    permission_resolved(data) {
      approvals.value = approvals.value.filter((a) => a.requestId !== data.requestId);
    },
    turn_end() {
      busy.value = false;
      if (currentAssistant) currentAssistant.streaming = false;
      sealAssistant();
    },
    turn_error(data) {
      busy.value = false;
      sealAssistant();
      messages.value.push({
        role: 'assistant', text: '处置中断：' + (data.message || '未知错误'),
        streaming: false, sealed: true, error: true, steps: [],
      });
      unread.value += 1;
    },
    stream_closed() {
      connected.value = false;
    },
    onOpen() {
      connected.value = true;
      if (!everOpened) {
        // 首次打开：服务端会全量回放缓冲事件，清空后按回放重建
        everOpened = true;
        messages.value = [];
        approvals.value = [];
        busy.value = false;
        currentAssistant = null;
      }
    },
    onError() {
      connected.value = false;
    },
  };

  function connect() {
    if (closeStream) return;
    closeStream = openAgentStream(conversationId.value, handlers);
  }

  async function refreshHealth(): Promise<AgentHealth> {
    health.value = await agentHealth();
    return health.value;
  }

  async function send(text: string, context?: AgentPageContext) {
    const message = (text || '').trim();
    if (!message || busy.value) return;
    messages.value.push({ role: 'user', text: message, pending: true, steps: [] });
    try {
      const res = await agentChat({ conversationId: conversationId.value, message, context });
      sessionId.value = res.sessionId || '';
    } catch (e) {
      messages.value = messages.value.filter((m) => !(m.role === 'user' && m.pending && m.text === message));
      throw e;
    }
  }

  async function approve(requestId: string, verdict: 'allowed-once' | 'rejected') {
    const card = approvals.value.find((a) => a.requestId === requestId);
    if (card) card.resolving = verdict;
    try {
      await agentPermission({ conversationId: conversationId.value, requestId, verdict });
    } catch (e) {
      approvals.value = approvals.value.filter((a) => a.requestId !== requestId);
      throw e;
    }
  }

  async function stop() {
    try { await agentCancel(conversationId.value); } catch { /* 已结束时会话可能不存在，忽略 */ }
  }

  function newConversation() {
    conversationId.value = newConversationId();
    localStorage.setItem(CONVERSATION_KEY, conversationId.value);
    sessionId.value = '';
    messages.value = [];
    approvals.value = [];
    busy.value = false;
    unread.value = 0;
    currentAssistant = null;
    if (closeStream) { closeStream(); closeStream = null; }
    everOpened = false;
    connect();
  }

  function clearUnread() {
    unread.value = 0;
  }

  const hasApprovals = computed(() => approvals.value.length > 0);

  return {
    conversationId, sessionId, messages, approvals, busy, connected, health, unread,
    hasApprovals, connect, refreshHealth, send, approve, stop, newConversation, clearUnread,
  };
});

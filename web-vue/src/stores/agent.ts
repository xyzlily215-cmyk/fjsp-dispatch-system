/* AI 调度副驾会话状态：消息流、工具步骤、待审批卡片、SSE 连接。
 * 单一事实来源是 agent-bff 的事件缓冲——页面刷新后由 SSE 全量回放重建，
 * 因此发送消息不做本地回显（乐观回声仅在用户消息上，按内容去重）。 */
import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import {
  agentCancel, agentChat, agentConversations, agentDeleteConversation, agentHealth, agentPermission,
  agentRenameConversation, agentSnapshot, openAgentStream,
  type AgentEventName, type AgentHealth, type AgentPageContext, type AgentStreamEvents,
  type ApprovalInfo, type ConversationSnapshot, type ConversationSummary,
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
  /** BFF 五要素审批信息（旧版本 BFF 可能不下发，展示层需兼容缺省） */
  approval?: ApprovalInfo;
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
  /* 多会话：列表来自 BFF（标题/时间/运行中/待审批数）；当前会话未发言前不在服务端列表里 */
  const conversations = ref<ConversationSummary[]>([]);
  const conversationsLoading = ref(false);
  let listTimer: ReturnType<typeof setTimeout> | null = null;

  let closeStream: (() => void) | null = null;
  let currentAssistant: AgentMessage | null = null;
  let everOpened = false;
  let connecting = false;
  /* 快照衔接状态（任务 4.1）：snapshotCutoff = 已应用快照的 lastEventId，
   * 回放中 id ≤ cutoff 的 permission_request 以快照有效清单为准（已失效/已裁决的不回放入卡） */
  let snapshotCutoff = 0;
  let snapshotApprovalIds = new Set<string>();
  /* 快照消息不可用/不完整 → 首开清空后按 SSE 全量回放重建（既有行为） */
  let rebuildFromReplay = true;

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

  const handlers: { [K in AgentEventName]?: (data: AgentStreamEvents[K], eventId: number) => void } & {
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
      scheduleListRefresh();
    },
    assistant_delta(data) {
      const msg = ensureAssistant();
      msg.streaming = true;
      msg.text += data.delta;
    },
    assistant_message(data) {
      // 快照窗口吸收（任务 4.1 修复轮）：快照 await 窗口内广播的事件会回放（id > 快照
      // lastEventId），其内容可能已在快照消息里——当前无打开中的流式消息、且与末条
      // 已封存助手消息全文相同时判为窗口回放重复，丢弃
      if (!currentAssistant) {
        const last = messages.value[messages.value.length - 1];
        if (last && last.role === 'assistant' && last.sealed && last.text === data.text) return;
      }
      // 提交帧是流式增量的最终态：整段替换而非追加
      const msg = ensureAssistant();
      msg.text = data.text;
      msg.streaming = false;
      msg.sealed = true;
      currentAssistant = null;
      unread.value += 1;
    },
    tool_call(data) {
      // 快照窗口吸收：同一 toolUseId 的步骤已在快照消息里时不重复入列
      if (data.toolUseId && findStep(data.toolUseId)) return;
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
    permission_request(data, eventId) {
      // 回放重建路径（任务 4.1）：快照时刻已失效/已裁决的审批（事件 id ≤ cutoff 且
      // 不在快照有效清单内）不再入卡；快照之后的新请求（id > cutoff）正常入卡
      if (eventId && eventId <= snapshotCutoff && !snapshotApprovalIds.has(data.requestId)) return;
      if (approvals.value.some((a) => a.requestId === data.requestId)) return;
      approvals.value.push({
        requestId: data.requestId,
        toolCall: data.toolCall || {},
        options: data.options || [],
        deadlineMs: data.deadlineMs || 0,
        approval: data.approval,
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
      scheduleListRefresh();
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
    resync_required() {
      // 订阅序号已出回放缓冲窗口：关闭当前流，重新取快照再订阅（任务 4.1）
      reconnect();
    },
    onOpen() {
      connected.value = true;
      if (!everOpened) {
        everOpened = true;
        if (rebuildFromReplay) {
          // 快照不可用/不完整：首开由服务端全量回放缓冲事件，清空后按回放重建
          messages.value = [];
          approvals.value = [];
          busy.value = false;
          currentAssistant = null;
        }
      }
    },
    onError() {
      connected.value = false;
    },
    onAuthError(message: string) {
      connected.value = false;
      // 未登录/登录失效给明确提示（重连场景去重，不刷屏）
      const last = messages.value[messages.value.length - 1];
      if (last && last.role === 'assistant' && last.error && last.text === message) return;
      messages.value.push({
        role: 'assistant', text: message, streaming: false, sealed: true, error: true, steps: [],
      });
    },
  };

  /** 应用会话快照（任务 4.1）：消息/运行状态/有效待审批以快照为准，序号记为衔接水位 */
  function applySnapshot(snap: ConversationSnapshot) {
    sessionId.value = snap.sessionId || '';
    busy.value = snap.running;
    snapshotCutoff = snap.lastEventId;
    snapshotApprovalIds = new Set(snap.pendingApprovals.map((a) => a.requestId));
    rebuildFromReplay = !snap.messagesComplete;
    messages.value = snap.messagesComplete
      ? snap.messages.map((m) => ({
          role: m.role,
          text: m.text,
          pending: false,
          streaming: false,
          sealed: true,
          error: false,
          steps: m.steps.map((st) => ({
            toolUseId: st.toolUseId,
            name: st.name,
            status: st.status === 'completed' ? 'done' as const
              : (st.status === 'failed' || st.status === 'cancelled') ? 'error' as const : 'running' as const,
            code: '',
            resultPreview: st.summary || '',
          })),
        }))
      : [];
    currentAssistant = null;
    // 审批卡片只渲染快照中仍有效的待审批项（过期的已由 BFF 惰性核销、不进快照）
    approvals.value = snap.pendingApprovals.map((a) => ({
      requestId: a.requestId,
      toolCall: { name: a.tool },
      options: [],
      deadlineMs: a.expiresAt,
      approval: {
        tool: a.tool,
        risk: a.risk,
        summary: a.argsSummary,
        digest: a.argsDigest.slice(0, 12),
        bizObject: a.bizObject,
        requiredRoles: a.requiredRoles,
        expiresAt: a.expiresAt,
      },
      resolving: '' as const,
    }));
  }

  /* 连接：先取会话快照再以衔接序号订阅 SSE（任务 4.1）。
   * 快照消息完整 → sinceId=lastEventId（快照到订阅之间的事件由回放补齐，不丢不重）；
   * 不完整/快照不可用（404/未登录/网络） → sinceId=replayFrom 或退化为既有全量回放。
   * 快照 await 期间会话可能被 newConversation 切换（评审 Minor-1）：await 后复核
   * conversationId，过期快照直接丢弃；在途期间的连接请求排队，完成后重入。 */
  let connectQueued = false;
  async function connect() {
    if (closeStream) return;
    if (connecting) { connectQueued = true; return; }
    connecting = true;
    try {
      let sinceId: number | undefined;
      const target = conversationId.value;
      try {
        const snap = await agentSnapshot(target);
        if (snap && snap.ok) {
          if (conversationId.value !== target) return; // 快照是旧会话的，丢弃（finally 里重入新会话连接）
          applySnapshot(snap);
          sinceId = snap.messagesComplete ? snap.lastEventId : snap.replayFrom;
          // 旧会话打开时 BFF 会用首条消息补标题：刷新列表让侧栏同步显示
          if (snap.messages.length) scheduleListRefresh();
        }
      } catch { /* 快照不可用：退化为既有全量回放 */ }
      if (conversationId.value !== target) return; // 快照失败期间也可能已切换会话
      if (closeStream) return;
      closeStream = openAgentStream(target, handlers, { sinceId });
    } finally {
      connecting = false;
      if (connectQueued) {
        connectQueued = false;
        void connect();
      }
    }
  }

  /** resync_required / 需要重建时：关闭当前流并重新走 快照→订阅 流程 */
  function reconnect() {
    if (closeStream) { closeStream(); closeStream = null; }
    everOpened = false;
    void connect();
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

  async function refreshConversations() {
    conversationsLoading.value = true;
    try {
      conversations.value = await agentConversations();
    } catch { /* BFF 不可用/未登录：保留旧列表，连接状态由 health/SSE 提示 */ } finally {
      conversationsLoading.value = false;
    }
  }
  /* 回合开始/结束等高频事件合并刷新，避免回放重建时一次性打出几十个请求 */
  function scheduleListRefresh() {
    if (listTimer) clearTimeout(listTimer);
    listTimer = setTimeout(() => { listTimer = null; void refreshConversations(); }, 400);
  }

  /** 切换到指定会话（null = 新建）：清空本地状态，按 快照→订阅 重新连接 */
  function openConversation(id: string | null) {
    if (id && id === conversationId.value) return;
    conversationId.value = id || newConversationId();
    localStorage.setItem(CONVERSATION_KEY, conversationId.value);
    sessionId.value = '';
    messages.value = [];
    approvals.value = [];
    busy.value = false;
    unread.value = 0;
    currentAssistant = null;
    snapshotCutoff = 0;
    snapshotApprovalIds = new Set();
    rebuildFromReplay = true;
    if (closeStream) { closeStream(); closeStream = null; }
    everOpened = false;
    connect();
  }

  function newConversation() {
    openConversation(null);
  }

  async function renameConversation(id: string, title: string) {
    const res = await agentRenameConversation(id, title);
    const item = conversations.value.find((c) => c.id === id);
    if (item) item.title = res.title;
  }

  /** 删除会话；删的是当前会话时切到列表里的下一个，没有就新建 */
  async function deleteConversation(id: string) {
    await agentDeleteConversation(id);
    conversations.value = conversations.value.filter((c) => c.id !== id);
    if (id === conversationId.value) openConversation(conversations.value[0]?.id ?? null);
  }

  function clearUnread() {
    unread.value = 0;
  }

  const hasApprovals = computed(() => approvals.value.length > 0);

  return {
    conversationId, sessionId, messages, approvals, busy, connected, health, unread,
    conversations, conversationsLoading,
    hasApprovals, connect, refreshHealth, send, approve, stop, newConversation, clearUnread,
    refreshConversations, openConversation, renameConversation, deleteConversation,
  };
});

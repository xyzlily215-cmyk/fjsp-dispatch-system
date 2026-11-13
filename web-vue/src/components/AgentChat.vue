<template>
  <div class="chat" :class="{ expanded, embedded, 'threads-open': threadsOpen }">
    <!-- 会话列表：展开模式常驻左栏，侧栏模式为浮层 -->
    <aside class="threads" :inert="!expanded && !threadsOpen ? true : undefined" aria-label="会话列表">
      <div class="threads-head">
        <strong>会话</strong>
        <button type="button" class="icon-btn" title="新会话" aria-label="新会话" @click="onNewConversation"><AppIcon name="plus" /></button>
        <button v-if="!expanded" type="button" class="icon-btn" title="收起会话列表" aria-label="收起会话列表" @click="threadsOpen = false"><AppIcon name="close" /></button>
      </div>
      <label class="threads-search">
        <AppIcon name="search" :size="14" />
        <input v-model="keyword" type="search" placeholder="搜索会话" aria-label="搜索会话">
      </label>
      <div class="threads-list">
        <button v-if="showDraftItem" type="button" class="thread-item active">
          <span class="thread-title">新会话</span><span class="thread-meta">尚未发送消息</span>
        </button>
        <template v-for="g in groupedThreads" :key="g.label">
          <div class="threads-group">{{ g.label }}</div>
          <div v-for="c in g.items" :key="c.id" class="thread-item" :class="{ active: c.id === agent.conversationId }"
               role="button" tabindex="0" @click="onOpen(c.id)" @keydown.enter.prevent="onOpen(c.id)">
            <template v-if="renamingId === c.id">
              <input ref="renameInput" v-model="renameDraft" class="thread-rename" maxlength="60" aria-label="会话标题"
                     @click.stop @keydown.enter.prevent="commitRename(c)" @keydown.esc.prevent="renamingId = ''" @blur="commitRename(c)">
            </template>
            <template v-else>
              <span class="thread-title">
                <span v-if="c.running || (c.id === agent.conversationId && agent.busy)" class="thread-spin" title="处理中"></span>
                <span class="thread-title-text" :title="c.title">{{ c.title }}</span>
              </span>
              <span v-if="c.updatedAt || c.pendingApprovals" class="thread-meta">
                {{ relTime(c.updatedAt) }}
                <em v-if="c.pendingApprovals" class="thread-badge">{{ c.pendingApprovals }} 待审批</em>
              </span>
              <span class="thread-actions">
                <button type="button" class="icon-btn sm" title="重命名" aria-label="重命名" @click.stop="startRename(c)"><AppIcon name="edit" :size="13" /></button>
                <button type="button" class="icon-btn sm danger" title="删除" aria-label="删除" @click.stop="onDelete(c)"><AppIcon name="trash" :size="13" /></button>
              </span>
            </template>
          </div>
        </template>
        <p v-if="!groupedThreads.length && !showDraftItem" class="threads-empty">{{ keyword ? '没有匹配的会话' : '还没有会话' }}</p>
      </div>
      <div class="threads-foot">
        <span class="conn" :class="connClass" :title="connTitle"><i></i>{{ connText }}</span>
      </div>
    </aside>
    <button v-if="!expanded && threadsOpen" type="button" class="threads-scrim" aria-label="关闭会话列表" @click="threadsOpen = false"></button>

    <section class="thread">
      <header class="thread-head">
        <button v-if="!expanded" type="button" class="icon-btn" title="会话列表" aria-label="打开会话列表" @click="openThreads"><AppIcon name="sidebar" /></button>
        <div class="thread-heading">
          <strong :title="currentTitle">{{ currentTitle }}</strong>
          <span>AI 调度助手 · {{ pageContext.title || '调度工作台' }}</span>
        </div>
        <button v-if="!expanded" type="button" class="icon-btn" title="新会话" aria-label="新会话" @click="onNewConversation"><AppIcon name="plus" /></button>
        <button v-if="!embedded" type="button" class="icon-btn" :title="expanded ? '收起为侧栏' : '展开工作台'" :aria-label="expanded ? '收起为侧栏' : '展开工作台'" @click="toggleAgentExpanded()"><AppIcon :name="expanded ? 'collapse' : 'expand'" /></button>
        <button v-if="!embedded" type="button" class="icon-btn" title="关闭" aria-label="关闭" @click="$emit('close')"><AppIcon name="close" /></button>
      </header>

      <div v-if="agent.health && !agent.health.ok" class="banner">
        <span>智能体未连接：{{ bannerHint }}</span>
        <button type="button" class="link-btn" @click="retryHealth">重试</button>
      </div>

      <div ref="scrollEl" class="thread-body" @scroll="onScroll">
        <div class="thread-inner">
          <div v-if="!agent.messages.length" class="welcome">
            <div class="welcome-mark" aria-hidden="true"><AppIcon name="agent" :size="22" /></div>
            <h2>今天要处理什么调度任务？</h2>
            <p>助手会读取{{ pageContext.title || '当前页面' }}的上下文，查询排程、订单与设备数据；涉及写操作时会先请你审批。</p>
            <div class="suggestions">
              <button v-for="hint in hints" :key="hint" type="button" class="suggestion" @click="fillHint(hint)">
                <span>{{ hint }}</span><AppIcon name="chevron" :size="14" />
              </button>
            </div>
          </div>

          <template v-for="(msg, i) in agent.messages" :key="i">
            <div v-if="msg.role === 'user'" class="turn user">
              <div class="user-text" :class="{ pending: msg.pending }">{{ msg.text }}</div>
            </div>
            <div v-else class="turn assistant" :class="{ error: msg.error }">
              <details v-if="msg.steps.length" class="work" :open="msg.streaming || msg.steps.some(s => s.status === 'running')">
                <summary>
                  <AppIcon name="tool" :size="13" />
                  <span>{{ workSummary(msg) }}</span>
                  <AppIcon class="work-chevron" name="chevron" :size="13" />
                </summary>
                <ol class="work-steps">
                  <li v-for="step in msg.steps" :key="step.toolUseId || step.seq" :class="step.status">
                    <details>
                      <summary>
                        <span class="step-dot" :class="step.status"></span>
                        <code>{{ step.name }}</code>
                        <span v-if="step.code && step.status !== 'running'" class="step-code">{{ step.code }}</span>
                      </summary>
                      <pre v-if="stepArgsText(step)" class="step-pre">{{ stepArgsText(step) }}</pre>
                      <pre v-if="step.resultPreview" class="step-pre result">{{ step.resultPreview }}</pre>
                    </details>
                  </li>
                </ol>
              </details>
              <div v-if="msg.text" class="assistant-text">
                <span v-if="msg.streaming" class="plain">{{ msg.text }}<span class="cursor">▍</span></span>
                <div v-else class="md" v-html="renderMarkdown(msg.text)"></div>
              </div>
              <div v-else-if="msg.streaming" class="thinking"><span class="shimmer">正在思考</span></div>
            </div>
          </template>
          <div v-if="agent.busy && lastIsUser" class="turn assistant"><div class="thinking"><span class="shimmer">正在思考</span></div></div>
        </div>
      </div>

      <div v-if="agent.approvals.length" class="approvals">
        <AgentApprovalCards />
      </div>

      <footer class="composer-wrap">
        <div class="composer" :class="{ focused }">
          <textarea ref="inputEl" v-model="draft" rows="1" class="composer-input"
                    :placeholder="agent.busy ? '正在处理，可先停止再追加指令…' : '描述调度任务，Enter 发送，Shift+Enter 换行'"
                    aria-label="向 AI 调度助手提问"
                    @focus="focused = true" @blur="focused = false" @input="autoGrow"
                    @keydown.enter.exact="onEnter"></textarea>
          <div class="composer-bar">
            <span class="ctx-chip" :title="contextTooltip"><AppIcon name="board" :size="12" />{{ pageContext.title || '调度工作台' }}<em v-if="pageContext.queryText">{{ pageContext.queryText }}</em></span>
            <button v-if="agent.busy" type="button" class="send stop" title="停止当前处理" aria-label="停止当前处理" @click="agent.stop()"><AppIcon name="stop" :size="14" /></button>
            <button v-else type="button" class="send" :disabled="!draft.trim()" title="发送" aria-label="发送" @click="onSend"><AppIcon name="send" :size="16" /></button>
          </div>
        </div>
      </footer>
    </section>
  </div>
</template>

<script setup>
/* AI 调度助手：多会话工作台。
 * 侧栏模式（docked/drawer）：顶栏 + 对话，会话列表为浮层；展开模式（expanded）：左会话列表常驻。
 * 状态全部在 stores/agent.ts；布局模式在 stores/agentPanel.ts。 */
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useAgentStore } from '../stores/agent';
import { agentExpanded, toggleAgentExpanded } from '../stores/agentPanel';
import { renderMarkdown } from '../utils/markdown';
import AgentApprovalCards from './AgentApprovalCards.vue';
import AppIcon from './AppIcon.vue';

const props = defineProps({ embedded: { type: Boolean, default: false } });
defineEmits(['close']);

const route = useRoute();
const agent = useAgentStore();

const scrollEl = ref(null);
const inputEl = ref(null);
const draft = ref('');
const focused = ref(false);
const stickBottom = ref(true);
const threadsOpen = ref(false);
const keyword = ref('');
const renamingId = ref('');
const renameDraft = ref('');
const renameInput = ref(null);

const expanded = computed(() => !props.embedded && agentExpanded.value);

/* 路由感知的快捷问题，选择后填入输入框。 */
const ROUTE_HINTS = {
  board: ['当前发布计划的 KPI 怎么样？', '今天有哪些订单可能拖期？', '帮我做一次基线排程', '负载最不均衡的是哪几台设备？'],
  twin: ['M-03 故障停机 2 小时，重新调度', '当前发布计划的 KPI 怎么样？', '帮我做一次基线排程', '订单 SO-1001 现在在哪台设备上？'],
  machines: ['哪些设备负载最高？', 'M-03 下周的日历有没有冲突？', '如果 M-03 停机 2 小时影响多大？'],
  orders: ['哪些订单有拖期风险？', '优先级最高的订单排到哪台设备了？', '订单 SO-1001 现在在哪台设备上？'],
  baseline: ['帮我做一次基线排程', '排程时 makespan 和拖期怎么权衡？', '排完后帮我提交评审'],
  reschedule: ['这次事件用局部还是完全重排？', '查一下同类事件以前怎么处置的', '重排后帮我对比新旧方案'],
  tasks: ['最近失败的调度任务是什么原因？', '当前有没有正在运行的任务？'],
  versions: ['这些版本里 KPI 最好的是哪个？', '当前发布版本和最新草案差多少？'],
  insert: ['帮我插一单：P-A 产品 50 件，明天 10 点到，周五 18 点交', '插单会引发多大扰动？'],
  breakdown: ['M-03 故障停机 2 小时，重新调度', '设备故障用局部重排还是完全重排？'],
  'resource-gantt': ['解读一下这个方案的瓶颈', '拖期订单集中在哪些设备？', '这个方案还有优化空间吗？'],
  compare: ['推荐采用哪个方案，为什么？', '两个方案的扰动率差多少？'],
  review: ['这个待审方案有什么风险点？', '帮我总结这个方案的 KPI 变化'],
  execution: ['实际执行和计划偏差有多大？', '哪些工序延误最严重？'],
  'agent-trace': ['总结一下最近几次处置的效果', '经验库里哪类事件最多？'],
  default: ['帮我做一次基线排程', 'M-03 故障停机 2 小时，重新调度', '当前发布计划的 KPI 怎么样？', '订单 SO-1001 现在在哪台设备上？'],
};

const pageContext = computed(() => {
  const section = route.meta.section || '';
  const title = route.meta.title || '';
  const queryEntries = Object.entries(route.query || {});
  return {
    section,
    title,
    route: route.name,
    query: route.query,
    queryText: queryEntries.length
      ? queryEntries.map(([k, v]) => `${k}=${v}`).join(' ').slice(0, 60)
      : '',
  };
});
const contextTooltip = computed(
  () => `发送消息时附带当前页面上下文：${pageContext.value.section} / ${pageContext.value.title}`,
);

const connClass = computed(() => {
  if (agent.connected) return 'ok';
  if (agent.health && !agent.health.ok) return 'bad';
  return 'wait';
});
const connTitle = computed(() => {
  if (agent.connected) return '已连接智能体（实时流式）';
  if (agent.health && !agent.health.ok) return agent.health.hint || '智能体未连接';
  return '连接中…';
});
const connText = computed(() => agent.connected ? '已连接' : agent.health && !agent.health.ok ? '服务未连接' : '连接中');
const bannerHint = computed(() => agent.health?.hint || 'agent-bff 未启动');
const hints = computed(() => ROUTE_HINTS[route.name] ?? ROUTE_HINTS.default);

/* ---- 会话列表 ---- */
const currentItem = computed(() => agent.conversations.find((c) => c.id === agent.conversationId));
const currentTitle = computed(() => currentItem.value?.title
  || (agent.messages.find((m) => m.role === 'user')?.text || '新会话').slice(0, 28));
/* 当前会话还没发言时服务端列表里没有它：列表顶部补一个"新会话"占位 */
const showDraftItem = computed(() => !currentItem.value && !keyword.value);
const lastIsUser = computed(() => {
  const last = agent.messages[agent.messages.length - 1];
  return last && last.role === 'user';
});

const DAY = 86400000;
function startOfDay(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
const groupedThreads = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  const items = agent.conversations.filter((c) => !kw || c.title.toLowerCase().includes(kw));
  const today = startOfDay(Date.now());
  const groups = [
    { label: '今天', items: [], test: (t) => t >= today },
    { label: '昨天', items: [], test: (t) => t >= today - DAY },
    { label: '近 7 天', items: [], test: (t) => t >= today - 7 * DAY },
    { label: '更早', items: [], test: () => true },
  ];
  for (const c of items) groups.find((g) => g.test(c.updatedAt)).items.push(c);
  return groups.filter((g) => g.items.length);
});

function relTime(t) {
  if (!t) return '';
  const diff = Date.now() - t;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < DAY) return `${Math.floor(diff / 3600000)} 小时前`;
  const d = new Date(t);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function openThreads() {
  threadsOpen.value = true;
  agent.refreshConversations();
}
function onOpen(id) {
  if (renamingId.value) return;
  agent.openConversation(id);
  threadsOpen.value = false;
  stickBottom.value = true;
  nextTick(() => inputEl.value?.focus());
}
function onNewConversation() {
  agent.newConversation();
  agent.refreshHealth();
  threadsOpen.value = false;
  draft.value = '';
  nextTick(() => inputEl.value?.focus());
}
function startRename(c) {
  renamingId.value = c.id;
  renameDraft.value = c.title;
  nextTick(() => {
    const el = Array.isArray(renameInput.value) ? renameInput.value[0] : renameInput.value;
    el?.focus(); el?.select();
  });
}
async function commitRename(c) {
  if (renamingId.value !== c.id) return;
  const title = renameDraft.value.trim();
  renamingId.value = '';
  if (!title || title === c.title) return;
  try { await agent.renameConversation(c.id, title); } catch (e) { ElMessage.error(e.message || '重命名失败'); }
}
async function onDelete(c) {
  try {
    await ElMessageBox.confirm(`删除会话「${c.title}」？删除后不再出现在列表中，审计记录会保留。`, '删除会话', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' });
  } catch { return; }
  try { await agent.deleteConversation(c.id); } catch (e) {
    ElMessage.error(e.code === 'conversation_active' ? '会话正在处理或有待审批，结束后再删除' : (e.message || '删除失败'));
  }
}

/* ---- 对话 ---- */
function stepArgsText(step) {
  if (step.args === null || step.args === undefined) return '';
  const text = typeof step.args === 'string' ? step.args : JSON.stringify(step.args, null, 2);
  return text.length > 600 ? text.slice(0, 600) + ' …' : text;
}
function workSummary(msg) {
  const n = msg.steps.length;
  const running = msg.steps.filter((s) => s.status === 'running').length;
  const failed = msg.steps.filter((s) => s.status === 'error').length;
  if (running) return `正在调用工具 · 已完成 ${n - running}/${n}`;
  return `已调用 ${n} 个工具${failed ? ` · ${failed} 个失败` : ''}`;
}

function fillHint(hint) {
  draft.value = hint;
  nextTick(() => { autoGrow(); inputEl.value?.focus(); });
}
function autoGrow() {
  const el = inputEl.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 180) + 'px';
}
function onEnter(e) {
  if (e.isComposing) return; // 中文输入法选词时的回车不发送
  e.preventDefault();
  onSend();
}

async function onSend() {
  const text = draft.value.trim();
  if (!text || agent.busy) return;
  draft.value = '';
  nextTick(autoGrow);
  stickBottom.value = true;
  const { section, title, route: routeName, query } = pageContext.value;
  try {
    await agent.send(text, { section, title, route: routeName, query });
    agent.refreshConversations();
  } catch (e) {
    if (e.code === 'turn_in_progress') ElMessage.warning('上一轮处置还在进行中，请稍候或先停止');
    else if (e.code === 'daemon_unavailable') ElMessage.error('AGH daemon 未连接，请先启动智能体服务');
    else if (e.code === 'conversation_workflow_active') ElMessage.warning('该会话有受控流程在运行，请新建会话');
    else ElMessage.error(e.message || '发送失败');
    draft.value = text;
    nextTick(autoGrow);
  }
}

async function retryHealth() {
  await agent.refreshHealth();
  if (agent.health.ok) { agent.connect(); agent.refreshConversations(); }
}

function onScroll() {
  const el = scrollEl.value;
  if (!el) return;
  stickBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
}
function scrollToBottom(force) {
  if (!force && !stickBottom.value) return;
  nextTick(() => {
    const el = scrollEl.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

watch(() => agent.messages.length, () => scrollToBottom(false));
watch(
  () => {
    const last = agent.messages[agent.messages.length - 1];
    return last && last.role === 'assistant' ? last.text.length : 0;
  },
  () => scrollToBottom(false),
);
watch(() => agent.conversationId, () => { stickBottom.value = true; scrollToBottom(true); });
// 展开工作台时会话列表常驻，进来就刷新一次
watch(expanded, (v) => { if (v) agent.refreshConversations(); });
// 本组件可见期间，未读即时清零
watch(() => agent.unread, () => agent.clearUnread(), { immediate: true });

onMounted(() => {
  agent.clearUnread();
  agent.refreshConversations();
  stickBottom.value = true;
  scrollToBottom(true);
  nextTick(() => inputEl.value?.focus());
});
</script>

<style scoped>
/* ===== 布局：侧栏模式单栏；展开模式左会话列表 + 右对话 ===== */
.chat { --c-ink:#1d1d1f; --c-sub:#6e6e73; --c-line:#e8e8ec; --c-soft:#f6f6f8; --c-hover:#efeff2; --c-accent:#1677ff;
  position:relative; display:flex; height:100%; min-height:0; min-width:0; overflow:hidden; background:#fff; color:var(--c-ink); }
.thread { position:relative; display:flex; flex-direction:column; flex:1; min-width:0; min-height:0; }

/* 会话列表 */
.threads { display:flex; flex-direction:column; width:264px; flex:none; min-height:0; border-right:1px solid var(--c-line); background:var(--c-soft); }
.chat:not(.expanded) .threads { position:absolute; z-index:6; top:0; bottom:0; left:0; width:min(280px, 86%); box-shadow:12px 0 32px rgba(0,0,0,.12);
  transform:translateX(-102%); transition:transform .22s ease-out; }
.chat:not(.expanded).threads-open .threads { transform:translateX(0); }
.threads-scrim { position:absolute; z-index:5; inset:0; border:0; background:rgba(15,23,42,.18); cursor:default; }
.threads-head { display:flex; align-items:center; gap:4px; height:64px; box-sizing:border-box; padding:0 10px 0 16px; flex:none; border-bottom:1px solid var(--c-line); }
.threads-head strong { flex:1; font-size:13px; font-weight:650; }
.threads-search { display:flex; align-items:center; gap:6px; margin:0 12px 8px; padding:0 10px; height:32px; border:1px solid var(--c-line); border-radius:8px; background:#fff; color:var(--c-sub); }
.threads-search input { flex:1; min-width:0; border:0; outline:none; background:transparent; font-size:12px; color:var(--c-ink); }
.threads-search:focus-within { border-color:#b9d3ff; box-shadow:0 0 0 3px rgba(22,119,255,.10); }
.threads-list { flex:1; min-height:0; overflow-y:auto; padding:0 8px 8px; }
.threads-group { padding:12px 8px 4px; color:#8e8e93; font-size:11px; font-weight:600; }
.thread-item { position:relative; display:flex; flex-direction:column; gap:2px; width:100%; padding:8px 10px; border:0; border-radius:8px; background:transparent; text-align:left; cursor:pointer; }
.thread-item:hover { background:var(--c-hover); }
.thread-item.active { background:#fff; box-shadow:0 1px 2px rgba(0,0,0,.06), 0 0 0 1px var(--c-line); }
.thread-item:focus-visible { outline:2px solid var(--c-accent); outline-offset:-2px; }
.thread-title { display:flex; align-items:center; gap:6px; min-width:0; color:var(--c-ink); font-size:13px; }
.thread-title-text { min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
.thread-item:hover .thread-title, .thread-item:focus-within .thread-title { padding-right:52px; }
.thread-meta { display:flex; align-items:center; gap:6px; color:#8e8e93; font-size:11px; }
.thread-badge { padding:0 6px; border-radius:9px; background:#fff4e5; color:#b25e00; font-style:normal; font-size:10.5px; line-height:16px; }
.thread-actions { position:absolute; top:6px; right:6px; display:none; gap:2px; }
.thread-item:hover .thread-actions, .thread-item:focus-within .thread-actions { display:flex; }
.thread-rename { width:100%; height:26px; padding:0 6px; border:1px solid var(--c-accent); border-radius:6px; outline:none; font-size:13px; }
.thread-spin { flex:none; width:10px; height:10px; border:2px solid #c9dcff; border-top-color:var(--c-accent); border-radius:50%; animation:spin .8s linear infinite; }
@keyframes spin { to { transform:rotate(360deg); } }
.threads-empty { margin:24px 0; color:#8e8e93; font-size:12px; text-align:center; }
.threads-foot { flex:none; padding:10px 16px; border-top:1px solid var(--c-line); }
.conn { display:inline-flex; align-items:center; gap:6px; color:var(--c-sub); font-size:11px; }
.conn i { width:7px; height:7px; border-radius:50%; background:#c98228; }
.conn.ok i { background:#1e9b72; } .conn.bad i { background:#d85b5b; }

.icon-btn { display:grid; place-items:center; flex:none; width:30px; height:30px; padding:0; border:0; border-radius:7px; background:transparent; color:#5f6368; cursor:pointer; }
.icon-btn:hover, .icon-btn:focus-visible { background:var(--c-hover); color:var(--c-ink); }
.icon-btn.sm { width:24px; height:24px; border-radius:6px; background:#fff; box-shadow:0 0 0 1px var(--c-line); }
.icon-btn.sm.danger:hover { color:#d03b3b; }
/* 顶栏 */
.thread-head { display:flex; align-items:center; gap:4px; height:64px; box-sizing:border-box; padding:0 8px 0 10px; flex:none; border-bottom:1px solid var(--c-line); }
.thread-heading { display:flex; flex-direction:column; flex:1; min-width:0; padding:0 4px; }
.thread-heading strong { overflow:hidden; font-size:13.5px; font-weight:650; white-space:nowrap; text-overflow:ellipsis; }
.thread-heading span { overflow:hidden; color:#8e8e93; font-size:11px; white-space:nowrap; text-overflow:ellipsis; }
.expanded .thread-head { padding-left:20px; }
.banner { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:7px 14px; flex:none; background:#fef0f0; color:#c94f4f; font-size:12px; }
.link-btn { border:0; background:transparent; color:var(--c-accent); font-size:12px; cursor:pointer; text-decoration:underline; }

/* 消息流：内容列居中限宽，展开时更易读 */
.thread-body { flex:1; min-height:0; overflow-y:auto; }
.thread-inner { display:flex; flex-direction:column; gap:18px; max-width:760px; margin:0 auto; padding:20px 18px 24px; }
.expanded .thread-inner { padding:28px 32px 32px; }
.welcome { padding:18px 2px 0; }
.welcome-mark { display:grid; place-items:center; width:40px; height:40px; margin-bottom:14px; border-radius:12px; color:#fff; background:linear-gradient(135deg,#3b8cff,#1652d9); box-shadow:0 6px 16px rgba(22,82,217,.25); }
.welcome h2 { margin:0 0 6px; font-size:18px; font-weight:650; letter-spacing:.01em; }
.welcome p { margin:0 0 18px; color:var(--c-sub); font-size:12.5px; line-height:1.65; }
.suggestions { display:flex; flex-direction:column; gap:6px; }
.suggestion { display:flex; align-items:center; justify-content:space-between; gap:10px; width:100%; padding:10px 12px; border:1px solid var(--c-line); border-radius:10px; background:#fff; color:#3a3a3c; font-size:12.5px; text-align:left; cursor:pointer; transition:border-color .15s, background .15s; }
.suggestion:hover, .suggestion:focus-visible { border-color:#c8dafd; background:#f7faff; color:var(--c-ink); }
.suggestion .app-icon { flex:none; color:#a1a1a6; }

.turn.user { display:flex; justify-content:flex-end; }
.user-text { max-width:85%; padding:9px 13px; border-radius:14px 14px 4px 14px; background:#f0f0f3; font-size:13px; line-height:1.6; white-space:pre-wrap; word-break:break-word; }
.user-text.pending { opacity:.6; }
.turn.assistant { display:flex; flex-direction:column; gap:8px; min-width:0; }
.assistant-text { font-size:13.5px; line-height:1.7; overflow-wrap:anywhere; }
.assistant-text .plain { white-space:pre-wrap; }
.turn.assistant.error .assistant-text { padding:10px 12px; border-radius:10px; background:#fef3f2; color:#b42318; }
.thinking { color:var(--c-sub); font-size:13px; }
.shimmer { background:linear-gradient(90deg,#8e8e93 0%,#d1d1d6 50%,#8e8e93 100%); background-size:200% 100%; -webkit-background-clip:text; background-clip:text; color:transparent; animation:shimmer 1.6s linear infinite; }
@keyframes shimmer { to { background-position:-200% 0; } }
.cursor { color:var(--c-accent); animation:blink 1s steps(1) infinite; }
@keyframes blink { 50% { opacity:0; } }

/* 工具调用：折叠的"工作过程" */
.work { border-radius:10px; }
.work > summary { display:inline-flex; align-items:center; gap:6px; padding:4px 8px 4px 6px; border-radius:7px; color:var(--c-sub); font-size:12px; cursor:pointer; list-style:none; user-select:none; }
.work > summary::-webkit-details-marker { display:none; }
.work > summary:hover { background:var(--c-soft); color:var(--c-ink); }
.work-chevron { transition:transform .15s; }
.work[open] .work-chevron { transform:rotate(90deg); }
.work-steps { margin:4px 0 0 12px; padding:0 0 0 12px; border-left:1px solid var(--c-line); list-style:none; display:flex; flex-direction:column; gap:2px; }
.work-steps details > summary { display:flex; align-items:center; gap:8px; padding:3px 6px; border-radius:6px; font-size:12px; cursor:pointer; list-style:none; }
.work-steps details > summary::-webkit-details-marker { display:none; }
.work-steps details > summary:hover { background:var(--c-soft); }
.work-steps code { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:11.5px; color:#3a3a3c; }
.step-dot { flex:none; width:7px; height:7px; border-radius:50%; background:#1e9b72; }
.step-dot.running { background:#fab219; animation:pulse 1.2s ease-in-out infinite; }
.step-dot.error { background:#d03b3b; }
@keyframes pulse { 50% { opacity:.35; } }
.step-code { margin-left:auto; color:#8e8e93; font-size:11px; }
.step-pre { margin:4px 0 6px 21px; padding:8px 10px; max-height:160px; overflow:auto; border-radius:8px; background:var(--c-soft); color:#48484a; font-size:11px; line-height:1.5; white-space:pre-wrap; word-break:break-all; }
.step-pre.result { color:#6e6e73; }
/* Markdown */
.md :deep(h1), .md :deep(h2), .md :deep(h3), .md :deep(h4) { margin:12px 0 6px; font-size:14px; font-weight:650; }
.md :deep(h1) { font-size:16px; } .md :deep(h2) { font-size:15px; }
.md :deep(p) { margin:6px 0; }
.md :deep(ul), .md :deep(ol) { margin:6px 0; padding-left:20px; }
.md :deep(li) { margin:3px 0; }
.md :deep(table) { width:100%; margin:8px 0; border-collapse:collapse; font-size:12px; }
.md :deep(th), .md :deep(td) { padding:6px 9px; border-bottom:1px solid var(--c-line); text-align:left; }
.md :deep(th) { color:var(--c-sub); font-weight:600; background:var(--c-soft); }
.md :deep(code) { padding:1px 5px; border-radius:4px; background:#f0f0f3; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; }
.md :deep(pre) { padding:10px 12px; overflow-x:auto; border-radius:8px; background:#f6f6f8; }
.md :deep(pre code) { padding:0; background:transparent; }
.md :deep(blockquote) { margin:8px 0; padding:2px 12px; border-left:3px solid var(--c-line); color:var(--c-sub); }
.md :deep(a) { color:var(--c-accent); }
.md > :deep(*:first-child) { margin-top:0; }
.md > :deep(*:last-child) { margin-bottom:0; }

/* 待审批 */
.approvals { flex:none; max-height:40%; overflow-y:auto; padding:10px 18px; border-top:1px solid #f5e1c0; background:#fffaf2; }
.expanded .approvals > * { max-width:760px; margin:0 auto; }

/* 输入框：圆角卡片，底栏放上下文与发送 */
.composer-wrap { flex:none; padding:10px 14px 14px; }
.expanded .composer-wrap { padding:12px 32px 22px; }
.composer { max-width:760px; margin:0 auto; border:1px solid #dcdce1; border-radius:16px; background:#fff; box-shadow:0 1px 2px rgba(0,0,0,.04), 0 6px 20px rgba(0,0,0,.05); transition:border-color .15s, box-shadow .15s; }
.composer.focused { border-color:#b9d3ff; box-shadow:0 0 0 3px rgba(22,119,255,.10), 0 6px 20px rgba(0,0,0,.05); }
.composer-input { display:block; width:100%; min-height:44px; max-height:180px; padding:12px 14px 4px; border:0; outline:none; resize:none; background:transparent; font:inherit; font-size:13px; line-height:1.55; color:var(--c-ink); }
.composer-input::placeholder { color:#a1a1a6; }
.composer-bar { display:flex; align-items:center; gap:8px; padding:4px 8px 8px 10px; }
.ctx-chip { display:inline-flex; align-items:center; gap:5px; min-width:0; max-width:70%; overflow:hidden; padding:3px 8px; border-radius:7px; background:var(--c-soft); color:var(--c-sub); font-size:11px; white-space:nowrap; text-overflow:ellipsis; }
.ctx-chip em { overflow:hidden; color:#8e8e93; font-style:normal; text-overflow:ellipsis; }
.send { display:grid; place-items:center; flex:none; width:30px; height:30px; margin-left:auto; padding:0; border:0; border-radius:50%; background:var(--c-ink); color:#fff; cursor:pointer; transition:opacity .15s, transform .15s; }
.send:hover:not(:disabled) { transform:scale(1.05); }
.send:disabled { opacity:.25; cursor:default; }
.send.stop { background:#d03b3b; }

@media (max-width:640px) {
  .thread-inner { padding:16px 12px 20px; }
  .composer-wrap { padding:8px 10px 10px; }
}
@media (prefers-reduced-motion:reduce) {
  .chat:not(.expanded) .threads, .work-chevron, .send { transition:none; }
  .shimmer, .thread-spin, .step-dot.running, .cursor { animation:none; }
}
</style>

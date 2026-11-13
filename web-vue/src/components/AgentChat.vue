<template>
  <div class="chat" :class="{ embedded }">
    <header class="chat-head">
      <div class="chat-identity">
        <span class="chat-badge" aria-hidden="true">AI</span>
        <div class="chat-heading">
          <strong>AI 调度助手</strong>
          <span class="chat-connection" :class="connClass" :title="connTitle"><span class="conn-dot"></span>{{ connText }}</span>
        </div>
      </div>
      <div class="chat-actions">
        <button type="button" class="chat-icon-btn" :class="{ 'tts-on': ttsOn }"
                :title="ttsOn ? '关闭语音播报' : '开启语音播报'" :aria-label="ttsOn ? '关闭语音播报' : '开启语音播报'" @click="toggleTts">
          <span aria-hidden="true">朗读</span>
        </button>
        <button type="button" class="chat-icon-btn" title="新会话" aria-label="新会话" @click="onNewConversation">＋</button>
        <button v-if="!embedded" type="button" class="chat-icon-btn" title="关闭" aria-label="关闭" @click="$emit('close')">×</button>
      </div>
    </header>

    <div v-if="agent.health && !agent.health.ok" class="chat-banner">
      <span>智能体未连接：{{ bannerHint }}</span>
      <button type="button" class="chat-link-btn" @click="retryHealth">重试</button>
    </div>

    <div class="chat-context" :title="contextTooltip">
      <span class="ctx-label">当前页面</span>
      <span class="ctx-page">{{ pageContext.title || '调度工作台' }}</span>
      <span v-if="pageContext.queryText" class="ctx-query">{{ pageContext.queryText }}</span>
      <span class="ctx-note">提问时关联此页面</span>
    </div>

    <div ref="scrollEl" class="chat-body" @scroll="onScroll">
      <div v-if="!agent.messages.length" class="chat-empty">
        <p class="empty-title">需要什么帮助？</p>
        <p class="empty-sub">可询问{{ pageContext.title || '当前页面' }}的排程、订单风险或方案差异，处理过程与待审批步骤会显示在这里。</p>
        <p class="empty-label">试试这些问题</p>
        <div class="empty-hints">
          <button v-for="hint in hints" :key="hint" type="button" class="hint-chip" @click="fillHint(hint)">{{ hint }}</button>
        </div>
      </div>

      <template v-for="(msg, i) in agent.messages" :key="i">
        <div v-if="msg.role === 'user'" class="msg-row user">
          <div class="msg-bubble user">{{ msg.text }}</div>
        </div>
        <div v-else class="msg-row assistant">
          <span class="msg-author">AI 调度助手</span>
          <div class="msg-block" :class="{ error: msg.error }">
            <div v-if="msg.steps.length" class="steps">
              <details v-for="step in msg.steps" :key="step.toolUseId || step.seq" class="step">
                <summary>
                  <span class="step-icon" :class="step.status">{{ stepIcon(step.status) }}</span>
                  <span class="step-name">{{ step.name }}</span>
                  <span v-if="step.code && step.status !== 'running'" class="step-code">{{ step.code }}</span>
                </summary>
                <div class="step-detail">
                  <pre v-if="stepArgsText(step)" class="step-pre">{{ stepArgsText(step) }}</pre>
                  <pre v-if="step.resultPreview" class="step-pre result">{{ step.resultPreview }}</pre>
                </div>
              </details>
            </div>
            <div v-if="msg.text" class="msg-text">
              <span v-if="msg.streaming">{{ msg.text }}<span class="cursor">▍</span></span>
              <div v-else class="md" v-html="renderMarkdown(msg.text)"></div>
            </div>
            <div v-else-if="msg.streaming" class="msg-text thinking">思考中<span class="cursor">▍</span></div>
          </div>
        </div>
      </template>
    </div>

    <div v-if="agent.approvals.length" class="chat-approvals">
      <AgentApprovalCards />
    </div>

    <footer class="chat-input">
      <textarea ref="inputEl" v-model="draft" class="input-box" rows="2"
                :placeholder="agent.busy ? '正在处理，可追加问题或停止当前任务…' : `询问${pageContext.title || '当前页面'}的调度问题…`"
                aria-label="向 AI 调度助手提问"
                @keydown.enter.exact.prevent="onSend"></textarea>
      <button v-if="speechSupported" type="button" class="send-btn mic" :class="{ recording }"
              :title="recording ? '停止语音输入' : '语音输入（中文）'" :aria-label="recording ? '停止语音输入' : '语音输入（中文）'" @click="toggleMic">
        {{ recording ? '■' : '语音' }}
      </button>
      <button v-if="agent.busy" type="button" class="send-btn stop" title="停止当前处理" aria-label="停止当前处理" @click="agent.stop()">■</button>
      <button v-else type="button" class="send-btn" :disabled="!draft.trim()" title="发送" aria-label="发送" @click="onSend">↑</button>
    </footer>
  </div>
</template>

<script setup>
/* AI 调度助手对话本体：抽屉侧栏（AgentSidebar）与数字孪生页内嵌栏共用。
 * embedded=true 时隐藏关闭按钮、填充父容器而非抽屉。状态全部在 stores/agent.js。 */
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useAgentStore } from '../stores/agent';
import { renderMarkdown } from '../utils/markdown';
import AgentApprovalCards from './AgentApprovalCards.vue';

defineProps({ embedded: { type: Boolean, default: false } });
defineEmits(['close']);

const route = useRoute();
const agent = useAgentStore();

const scrollEl = ref(null);
const inputEl = ref(null);
const draft = ref('');
const stickBottom = ref(true);

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
const connText = computed(() => agent.connected ? '已连接 · 可处理调度问题' : agent.health && !agent.health.ok ? '服务未连接' : '连接中');
const bannerHint = computed(() => agent.health?.hint || 'agent-bff 未启动');

const hints = computed(() => ROUTE_HINTS[route.name] ?? ROUTE_HINTS.default);

function stepIcon(status) {
  return status === 'done' ? '✓' : status === 'error' ? '✗' : '⏳';
}
function stepArgsText(step) {
  if (step.args === null || step.args === undefined) return '';
  const text = typeof step.args === 'string' ? step.args : JSON.stringify(step.args, null, 2);
  return text.length > 600 ? text.slice(0, 600) + ' …' : text;
}

function fillHint(hint) {
  draft.value = hint;
  inputEl.value?.focus();
}

async function onSend() {
  const text = draft.value.trim();
  if (!text) return;
  draft.value = '';
  const { section, title, route: routeName, query } = pageContext.value;
  try {
    await agent.send(text, { section, title, route: routeName, query });
  } catch (e) {
    if (e.code === 'turn_in_progress') ElMessage.warning('上一轮处置还在进行中，请稍候或先停止');
    else if (e.code === 'daemon_unavailable') ElMessage.error('AGH daemon 未连接，请先启动智能体服务');
    else ElMessage.error(e.message || '发送失败');
    draft.value = text;
  }
}

async function retryHealth() {
  await agent.refreshHealth();
  if (agent.health.ok) agent.connect();
}

function onNewConversation() {
  agent.newConversation();
  agent.refreshHealth();
}

/* ---- 语音输入（Web Speech API：浏览器端语音识别，无服务端依赖） ---- */
const speechSupported = typeof window !== 'undefined'
  && !!(window.SpeechRecognition || window.webkitSpeechRecognition);
const recording = ref(false);
let recognizer = null;
let baseDraft = '';

function toggleMic() {
  if (!speechSupported) return;
  if (recording.value) {
    recognizer?.stop();
    return;
  }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognizer = new SR();
  recognizer.lang = 'zh-CN';
  recognizer.interimResults = true;
  recognizer.continuous = false;
  recognizer.onresult = (e) => {
    let finalText = '';
    let interim = '';
    for (const r of e.results) {
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    draft.value = baseDraft + finalText + interim;
  };
  recognizer.onend = () => { recording.value = false; };
  recognizer.onerror = () => {
    recording.value = false;
    ElMessage.warning('语音识别不可用或麦克风未授权');
  };
  baseDraft = draft.value ? draft.value + ' ' : '';
  recording.value = true;
  recognizer.start();
}

/* ---- TTS 语音播报：朗读最终答复（文本），工具步骤不读 ---- */
const ttsOn = ref(localStorage.getItem('fjsp.agentTts') === '1');
let lastSpokenText = '';

function toggleTts() {
  ttsOn.value = !ttsOn.value;
  localStorage.setItem('fjsp.agentTts', ttsOn.value ? '1' : '0');
  if (!ttsOn.value) window.speechSynthesis?.cancel();
}

watch(
  () => {
    const last = agent.messages[agent.messages.length - 1];
    return last && last.role === 'assistant' && last.sealed ? last.text : '';
  },
  (text) => {
    if (!ttsOn.value || !text || text === lastSpokenText || !window.speechSynthesis) return;
    lastSpokenText = text;
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text.slice(0, 300));
    utter.lang = 'zh-CN';
    window.speechSynthesis.speak(utter);
  },
);

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
// 本组件可见期间（抽屉打开或页面内嵌），未读即时清零
watch(() => agent.unread, () => agent.clearUnread(), { immediate: true });

onMounted(() => {
  agent.clearUnread();
  stickBottom.value = true;
  scrollToBottom(true);
  nextTick(() => inputEl.value?.focus());
});
</script>

<style scoped>
.chat { display:flex; flex-direction:column; height:100%; min-height:0; min-width:0; background:#fff; }
.chat-head { min-height:64px; flex:none; display:flex; align-items:center; justify-content:space-between; gap:8px; padding:10px 14px 10px 16px; border-bottom:1px solid var(--line); background:var(--surface); user-select:none; }
.chat-identity { display:flex; align-items:center; gap:11px; min-width:0; }
.chat-heading { display:flex; flex-direction:column; gap:4px; min-width:0; }
.chat-heading strong { color:var(--ink, #152334); font-size:15px; line-height:1.3; white-space:nowrap; }
.chat-badge { display:grid; place-items:center; flex:none; width:36px; height:36px; border-radius:7px; background:var(--blue, #2563eb); color:#fff; font-size:12px; font-weight:700; }
.chat-connection { display:flex; align-items:center; gap:6px; color:#66758a; font-size:11px; white-space:nowrap; }
.conn-dot { flex:none; width:7px; height:7px; border-radius:50%; background:#c98228; }
.chat-connection.ok .conn-dot { background:#1e9b72; }
.chat-connection.bad .conn-dot { background:#d85b5b; }
.chat-actions { display:flex; align-items:center; gap:2px; flex:none; }
.chat-icon-btn { min-width:30px; height:30px; padding:0 5px; border:0; border-radius:5px; background:transparent; color:#59677b; font-size:16px; display:grid; place-items:center; cursor:pointer; }
.chat-icon-btn:first-child { font-size:11px; }
.chat-icon-btn:hover, .chat-icon-btn:focus-visible { background:#eaf1ff; color:var(--blue-deep, #1d4ed8); }

.chat-banner { flex:none; display:flex; align-items:center; justify-content:space-between; gap:8px; padding:7px 14px; background:#fef0f0; color:#f56c6c; font-size:12px; border-bottom:1px solid #fde2e2; }
.chat-link-btn { border:0; background:transparent; color:var(--blue, #409eff); font-size:12px; cursor:pointer; text-decoration:underline; }

.chat-context { flex:none; display:flex; align-items:center; gap:7px; min-height:36px; padding:8px 16px; font-size:11px; color:var(--muted); border-bottom:1px solid var(--line); background:var(--surface-soft); min-width:0; }
.ctx-label { flex:none; color:var(--muted); }
.ctx-page { color:var(--blue-deep); font-weight:600; flex:none; }
.ctx-query { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ctx-note { display:none; }

.chat-body { flex:1; overflow-y:auto; padding:16px 16px 12px; display:flex; flex-direction:column; gap:14px; min-height:0; }
.chat-empty { width:100%; margin:0; padding:0; color:var(--muted); }
.empty-title { font-size:15px; font-weight:650; color:var(--ink); margin:0 0 6px; line-height:1.4; }
.empty-sub { font-size:12px; margin:0 0 16px; line-height:1.65; max-width:40ch; }
.empty-label { margin:0 0 8px; font-size:11px; font-weight:600; color:var(--muted); }
.empty-hints { display:flex; flex-direction:column; gap:8px; }
.hint-chip { width:100%; border:1px solid var(--line); background:var(--surface); color:#33485c; border-radius:6px; padding:10px 12px; font-size:12px; line-height:1.5; text-align:left; cursor:pointer; }
.hint-chip:hover, .hint-chip:focus-visible { border-color:#a7c3fc; background:#f3f7ff; color:var(--blue-deep, #1d4ed8); }

.msg-row { display:flex; min-width:0; }
.msg-row.user { justify-content:flex-end; }
.msg-row.assistant { flex-direction:column; align-items:flex-start; gap:5px; }
.msg-author { color:#66758a; font-size:11px; font-weight:600; }
.msg-bubble.user { max-width:86%; background:#eaf1ff; color:#1d3555; border-radius:7px; padding:9px 12px; font-size:13px; line-height:1.55; white-space:pre-wrap; word-break:break-word; }
.msg-block { max-width:100%; width:100%; background:#fff; border:1px solid #e5eaf1; border-radius:7px; padding:11px 12px; font-size:13px; line-height:1.6; overflow-wrap:anywhere; }
.msg-block.error { background:#fef0f0; border-color:#fde2e2; color:#f56c6c; }
.msg-text { white-space:pre-wrap; word-break:break-word; color:var(--ink, #303133); }
.msg-block.error .msg-text { color:#f56c6c; }
.msg-text.thinking { color:#909399; }
.md :deep(h1), .md :deep(h2), .md :deep(h3), .md :deep(h4) { margin:10px 0 6px; font-size:14px; }
.md :deep(h1) { font-size:16px; }
.md :deep(h2) { font-size:15px; }
.md :deep(p) { margin:4px 0; }
.md :deep(ul), .md :deep(ol) { margin:4px 0; padding-left:20px; }
.md :deep(li) { margin:2px 0; }
.md :deep(table) { border-collapse:collapse; margin:6px 0; font-size:12px; width:100%; }
.md :deep(th), .md :deep(td) { border:1px solid #e2e8f2; padding:4px 8px; text-align:left; }
.md :deep(th) { background:#f0f7ff; font-weight:600; }
.md :deep(code) { background:#eef2f7; border-radius:3px; padding:0 4px; font-size:12px; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; }
.md :deep(pre) { background:#f4f6fa; border-radius:6px; padding:8px; overflow-x:auto; }
.md :deep(pre code) { background:transparent; padding:0; }
.md :deep(blockquote) { border-left:1px solid var(--line); margin:6px 0; padding:2px 10px; color:var(--muted); }
.md :deep(a) { color:var(--blue, #409eff); }
.md > :deep(*:first-child) { margin-top:0; }
.cursor { color:var(--blue, #409eff); animation:blink 1s steps(1) infinite; }
@keyframes blink { 50% { opacity:0; } }

.steps { display:flex; flex-direction:column; gap:4px; margin-bottom:6px; }
.step { border:1px solid #e2e8f2; border-radius:6px; background:#fff; }
.step > summary { display:flex; align-items:center; gap:6px; padding:4px 8px; font-size:12px; cursor:pointer; list-style:none; user-select:none; color:#606266; }
.step > summary::-webkit-details-marker { display:none; }
.step-icon { flex:none; font-size:11px; }
.step-icon.done { color:#67c23a; }
.step-icon.error { color:#f56c6c; }
.step-icon.running { color:#e6a23c; }
.step-name { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:11.5px; }
.step-code { margin-left:auto; font-size:11px; color:#909399; }
.step-detail { border-top:1px dashed #e8ecf3; padding:6px 8px; }
.step-pre { margin:0; font-size:11px; line-height:1.5; color:#606266; white-space:pre-wrap; word-break:break-all; max-height:160px; overflow-y:auto; }
.step-pre.result { color:#909399; }

.chat-approvals { flex:none; border-top:1px solid var(--line, #e4e7ed); background:#fffaf2; padding:8px 14px; max-height:40%; overflow-y:auto; display:flex; flex-direction:column; gap:8px; }
.approval-card { border:1px solid #f5dab1; border-radius:8px; background:#fff; padding:8px 10px; }
.approval-head { display:flex; align-items:center; gap:8px; margin-bottom:6px; }
.approval-tag { flex:none; padding:1px 7px; border-radius:4px; background:#e6a23c; color:#fff; font-size:11px; font-weight:600; }
.approval-tool { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; color:#606266; }
.approval-args { margin:0 0 8px; font-size:11px; color:#909399; white-space:pre-wrap; word-break:break-all; max-height:100px; overflow-y:auto; }
.approval-btns { display:flex; gap:8px; }
.ap-btn { flex:1; border:0; border-radius:6px; padding:6px 0; font-size:12.5px; cursor:pointer; }
.ap-btn.approve { background:var(--blue, #409eff); color:#fff; }
.ap-btn.approve:hover:not(:disabled) { background:#66b1ff; }
.ap-btn.reject { background:#f4f4f5; color:#606266; border:1px solid #dcdfe6; }
.ap-btn.reject:hover:not(:disabled) { color:#f56c6c; border-color:#fbc4c4; }
.ap-btn:disabled { opacity:.55; cursor:default; }

.chat-input { flex:none; display:flex; align-items:flex-end; gap:8px; padding:12px 16px 16px; border-top:1px solid var(--line); background:var(--surface); }
.input-box { flex:1; min-width:0; resize:none; border:1px solid #d9e1eb; border-radius:6px; padding:9px 11px; font-size:12px; line-height:1.5; font-family:inherit; outline:none; }
.input-box:focus { border-color:var(--blue, #2563eb); box-shadow:0 0 0 2px #eaf1ff; }
.input-box::placeholder { color:#718093; }
.send-btn { flex:none; min-width:36px; height:36px; padding:0 8px; border:0; border-radius:6px; background:var(--blue, #2563eb); color:#fff; font-size:17px; cursor:pointer; display:grid; place-items:center; }
.send-btn:hover:not(:disabled) { background:#66b1ff; }
.send-btn:disabled { background:#a0cfff; cursor:default; }
.send-btn.stop { background:#f56c6c; }
.send-btn.stop:hover { background:#f78989; }
.send-btn.mic { background:#fff; color:#475569; border:1px solid #d9e1eb; font-size:11px; }
.send-btn.mic:hover { border-color:var(--blue, #409eff); }
.send-btn.mic.recording { background:#f56c6c; border-color:#f56c6c; color:#fff; animation:mic-pulse 1.2s ease-in-out infinite; }
@keyframes mic-pulse { 50% { box-shadow:0 0 0 6px rgba(245,108,108,.18); } }
.chat-icon-btn.tts-on { color:var(--blue, #409eff); background:#ecf5ff; }
@media (max-width:460px) {
  .chat-head { padding-left:12px; padding-right:10px; }
  .chat-body { padding:14px 12px 10px; }
  .chat-context { padding:9px 12px; }
  .ctx-note { display:none; }
  .chat-input { padding:10px 12px 12px; }
}
</style>

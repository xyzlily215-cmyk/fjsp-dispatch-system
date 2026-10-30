<template>
  <div class="chat" :class="{ embedded }">
    <header class="chat-head">
      <span class="chat-title">
        <span class="chat-badge">AI</span>调度副驾
        <span class="conn-dot" :class="connClass" :title="connTitle"></span>
      </span>
      <div class="chat-actions">
        <button type="button" class="chat-icon-btn" :class="{ 'tts-on': ttsOn }"
                :title="ttsOn ? '关闭语音播报' : '开启语音播报（朗读副驾答复）'" @click="toggleTts">
          {{ ttsOn ? '🔊' : '🔇' }}
        </button>
        <button type="button" class="chat-icon-btn" title="新会话" @click="onNewConversation">✚</button>
        <button v-if="!embedded" type="button" class="chat-icon-btn" title="关闭" @click="$emit('close')">✕</button>
      </div>
    </header>

    <div v-if="agent.health && !agent.health.ok" class="chat-banner">
      <span>智能体未连接：{{ bannerHint }}</span>
      <button type="button" class="chat-link-btn" @click="retryHealth">重试</button>
    </div>

    <div class="chat-context" :title="contextTooltip">
      <span class="ctx-label">上下文</span>
      <span class="ctx-page">{{ pageContext.title }}</span>
      <span v-if="pageContext.queryText" class="ctx-query">{{ pageContext.queryText }}</span>
    </div>

    <div ref="scrollEl" class="chat-body" @scroll="onScroll">
      <div v-if="!agent.messages.length" class="chat-empty">
        <p class="empty-title">我是车间的 AI 调度副驾</p>
        <p class="empty-sub">可以让我做基线排程、处置插单/设备故障、对比方案、查订单位置。</p>
        <div class="empty-hints">
          <button v-for="hint in hints" :key="hint" type="button" class="hint-chip" @click="fillHint(hint)">{{ hint }}</button>
        </div>
      </div>

      <template v-for="(msg, i) in agent.messages" :key="i">
        <div v-if="msg.role === 'user'" class="msg-row user">
          <div class="msg-bubble user">{{ msg.text }}</div>
        </div>
        <div v-else class="msg-row assistant">
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
                :placeholder="agent.busy ? '处置进行中，可随时追加或停止…' : '向副驾下达调度指令，Enter 发送'"
                @keydown.enter.exact.prevent="onSend"></textarea>
      <button v-if="speechSupported" type="button" class="send-btn mic" :class="{ recording }"
              :title="recording ? '停止语音输入' : '语音输入（中文）'" @click="toggleMic">
        {{ recording ? '⏹' : '🎤' }}
      </button>
      <button v-if="agent.busy" type="button" class="send-btn stop" title="停止当前处置" @click="agent.stop()">■</button>
      <button v-else type="button" class="send-btn" :disabled="!draft.trim()" title="发送" @click="onSend">➤</button>
    </footer>
  </div>
</template>

<script setup>
/* AI 调度副驾对话本体：抽屉侧栏（AgentSidebar）与数字孪生页内嵌栏共用。
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

/* 路由感知的快捷指令：副驾在每个页面都"知道该帮什么忙" */
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

/* ---- TTS 语音播报：朗读副驾的最终答复（文本），工具步骤不读 ---- */
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
.chat { display:flex; flex-direction:column; height:100%; min-height:0; background:#fff; }
.chat-head { height:44px; flex:none; display:flex; align-items:center; justify-content:space-between; padding:0 8px 0 16px; border-bottom:1px solid var(--line, #e4e7ed); background:#fafbfc; user-select:none; }
.chat-title { display:flex; align-items:center; gap:8px; font-size:13px; font-weight:600; color:var(--ink, #303133); }
.chat-badge { display:grid; place-items:center; width:20px; height:20px; border-radius:5px; background:var(--blue, #409eff); color:#fff; font-size:10px; font-weight:700; }
.conn-dot { width:8px; height:8px; border-radius:50%; background:#c0c4cc; }
.conn-dot.ok { background:#67c23a; box-shadow:0 0 0 3px rgba(103,194,58,.18); }
.conn-dot.wait { background:#e6a23c; }
.conn-dot.bad { background:#f56c6c; }
.chat-actions { display:flex; align-items:center; gap:2px; }
.chat-icon-btn { width:28px; height:28px; border:0; border-radius:5px; background:transparent; color:#606266; font-size:13px; display:grid; place-items:center; cursor:pointer; }
.chat-icon-btn:hover { background:#ecf5ff; color:var(--blue, #409eff); }

.chat-banner { flex:none; display:flex; align-items:center; justify-content:space-between; gap:8px; padding:7px 14px; background:#fef0f0; color:#f56c6c; font-size:12px; border-bottom:1px solid #fde2e2; }
.chat-link-btn { border:0; background:transparent; color:var(--blue, #409eff); font-size:12px; cursor:pointer; text-decoration:underline; }

.chat-context { flex:none; display:flex; align-items:center; gap:6px; padding:6px 14px; font-size:11px; color:#909399; border-bottom:1px solid var(--line, #e4e7ed); background:#fcfdff; overflow:hidden; white-space:nowrap; }
.ctx-label { flex:none; padding:1px 6px; border-radius:4px; background:#ecf5ff; color:var(--blue, #409eff); font-weight:600; }
.ctx-page { color:#606266; }
.ctx-query { color:#b0b6c0; overflow:hidden; text-overflow:ellipsis; }

.chat-body { flex:1; overflow-y:auto; padding:14px 14px 8px; display:flex; flex-direction:column; gap:10px; min-height:0; }
.chat-empty { margin:auto; text-align:center; color:#909399; padding:0 18px; }
.empty-title { font-size:14px; font-weight:600; color:#606266; margin:0 0 6px; }
.empty-sub { font-size:12px; margin:0 0 14px; line-height:1.6; }
.empty-hints { display:flex; flex-wrap:wrap; gap:8px; justify-content:center; }
.hint-chip { border:1px solid #d9ecff; background:#ecf5ff; color:var(--blue, #409eff); border-radius:14px; padding:5px 12px; font-size:12px; cursor:pointer; }
.hint-chip:hover { background:#d9ecff; }

.msg-row { display:flex; }
.msg-row.user { justify-content:flex-end; }
.msg-bubble.user { max-width:86%; background:var(--blue, #409eff); color:#fff; border-radius:12px 12px 4px 12px; padding:8px 12px; font-size:13px; line-height:1.55; white-space:pre-wrap; word-break:break-word; }
.msg-block { max-width:94%; background:#f4f6fa; border:1px solid #e8ecf3; border-radius:4px 12px 12px 12px; padding:8px 12px; font-size:13px; line-height:1.6; }
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
.md :deep(blockquote) { border-left:3px solid #c4dbf7; margin:6px 0; padding:2px 10px; color:#606266; }
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

.chat-input { flex:none; display:flex; align-items:flex-end; gap:8px; padding:10px 14px; border-top:1px solid var(--line, #e4e7ed); background:#fff; }
.input-box { flex:1; resize:none; border:1px solid #dcdfe6; border-radius:8px; padding:8px 10px; font-size:13px; line-height:1.5; font-family:inherit; outline:none; }
.input-box:focus { border-color:var(--blue, #409eff); }
.send-btn { flex:none; width:36px; height:36px; border:0; border-radius:8px; background:var(--blue, #409eff); color:#fff; font-size:14px; cursor:pointer; display:grid; place-items:center; }
.send-btn:hover:not(:disabled) { background:#66b1ff; }
.send-btn:disabled { background:#a0cfff; cursor:default; }
.send-btn.stop { background:#f56c6c; }
.send-btn.stop:hover { background:#f78989; }
.send-btn.mic { background:#fff; color:#606266; border:1px solid #dcdfe6; }
.send-btn.mic:hover { border-color:var(--blue, #409eff); }
.send-btn.mic.recording { background:#f56c6c; border-color:#f56c6c; color:#fff; animation:mic-pulse 1.2s ease-in-out infinite; }
@keyframes mic-pulse { 50% { box-shadow:0 0 0 6px rgba(245,108,108,.18); } }
.chat-icon-btn.tts-on { color:var(--blue, #409eff); background:#ecf5ff; }
</style>

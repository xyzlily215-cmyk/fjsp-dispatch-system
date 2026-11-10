<template>
  <section class="ai-bar" :class="{ expanded }" aria-label="AI 调度助手">
    <div class="ai-head">
      <span class="ai-badge" aria-hidden="true">AI</span>
      <div class="ai-heading">
        <strong>{{ title || 'AI 调度助手' }}</strong>
        <span>关联当前页面 · {{ route.meta.title || '调度工作台' }}</span>
      </div>
      <div class="ai-meta">
        <span class="ai-status" :class="connClass" :title="connTitle"><span class="conn-dot"></span>{{ connText }}</span>
        <button type="button" class="ai-link" title="打开 AI 调度助手对话" @click="openSidebar">打开对话 <span aria-hidden="true">↗</span></button>
      </div>
    </div>
    <div class="ai-row">
      <div class="ai-triggers">
        <button v-for="a in actions" :key="a.label" type="button" class="ai-chip" :class="{ primary: a.primary }"
                :disabled="agent.busy" @click="run(a)">{{ a.label }}</button>
        <template v-if="freeInput">
          <input v-model="draft" class="ai-free" :placeholder="freeInput.placeholder" :aria-label="freeInput.placeholder"
                 @keydown.enter.prevent="runFree" />
          <button type="button" class="ai-chip primary" :disabled="agent.busy || !draft.trim()" @click="runFree">
            {{ freeInput.button ?? '发送' }}
          </button>
        </template>
      </div>
      <button v-if="collapsed && hasResult" type="button" class="ai-collapse" @click="collapsed = false">查看结果</button>
      <button v-if="expanded" type="button" class="ai-collapse" @click="collapsed = true">收起结果</button>
    </div>

    <template v-if="expanded">
      <AgentApprovalCards v-if="agent.approvals.length" class="ai-approvals" />
      <div v-if="segment.length" class="ai-result">
        <template v-for="(msg, i) in segment" :key="i">
          <div v-if="msg.role === 'assistant'" class="ai-msg">
            <div v-if="msg.steps.length" class="ai-steps">
              <span v-for="step in msg.steps" :key="step.toolUseId || step.seq" class="ai-step" :class="step.status"
                    :title="step.resultPreview || step.name">
                {{ stepIcon(step.status) }} {{ step.name }}
              </span>
            </div>
            <div class="ai-text" :class="{ error: msg.error }">
              <span v-if="msg.streaming">{{ msg.text }}<span class="cursor">▍</span></span>
              <div v-else class="md" v-html="renderMarkdown(msg.text)"></div>
            </div>
          </div>
        </template>
        <div v-if="agent.busy && !hasStreamingText" class="ai-thinking">正在处理调度请求<span class="cursor">▍</span></div>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
/* 页级 AI 工具条：每个业务页顶部的细条（空闲时单行、融入页面工具栏视觉），
 * 触发后原地展开答复流与页内审批卡片，可收起。与侧栏共享同一个 Agent 会话。 */
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import { useAgentStore } from '../stores/agent';
import { toggleAgentPanel } from '../stores/agentPanel';
import { renderMarkdown } from '../utils/markdown';
import AgentApprovalCards from './AgentApprovalCards.vue';

export interface AiAction {
  label: string;
  prompt: string | (() => string);
  primary?: boolean;
}

export interface AiFreeInput {
  placeholder: string;
  button?: string;
  /** 把用户输入包装成完整提示词（如"请按以下描述调用 fjsp_insert_order：…"） */
  wrap?: (text: string) => string;
}

const props = defineProps<{
  title?: string;
  actions?: AiAction[];
  freeInput?: AiFreeInput;
}>();

const route = useRoute();
const agent = useAgentStore();
const draft = ref('');
const startIdx = ref<number | null>(null);
const collapsed = ref(false);

const segment = computed(() => {
  if (startIdx.value === null) return [];
  return agent.messages.slice(startIdx.value).filter((m) => m.role === 'assistant');
});
const hasStreamingText = computed(() => segment.value.some((m) => m.streaming && m.text));
const hasResult = computed(() => startIdx.value !== null && (segment.value.length > 0 || agent.approvals.length > 0 || agent.busy));
const expanded = computed(
  () => !collapsed.value && hasResult.value,
);
const connClass = computed(() => agent.connected ? 'ok' : agent.health && !agent.health.ok ? 'bad' : 'wait');
const connText = computed(() => agent.connected ? '已连接' : agent.health && !agent.health.ok ? '未连接' : '连接中');
const connTitle = computed(() => agent.health && !agent.health.ok ? agent.health.hint || '智能体未连接' : connText.value);

function stepIcon(status: string) {
  return status === 'done' ? '✓' : status === 'error' ? '✗' : '⏳';
}

async function run(a: AiAction) {
  if (agent.busy) return false;
  const text = typeof a.prompt === 'function' ? a.prompt() : a.prompt;
  if (!text.trim()) return false;
  const previousIdx = startIdx.value;
  const wasCollapsed = collapsed.value;
  startIdx.value = agent.messages.length;
  collapsed.value = false;
  try {
    await agent.send(text, {
      section: (route.meta.section as string) || '',
      title: (route.meta.title as string) || '',
      route: route.name,
      query: route.query,
    });
    return true;
  } catch (e) {
    startIdx.value = previousIdx;
    collapsed.value = wasCollapsed;
    const err = e as { code?: string; message?: string };
    if (err.code === 'turn_in_progress') ElMessage.warning('AI 调度助手正在处理上一轮任务，请稍候');
    else ElMessage.error(err.message || '发送失败');
    return false;
  }
}

function runFree() {
  if (agent.busy) return;
  const text = draft.value.trim();
  if (!text) return;
  const prompt = props.freeInput?.wrap ? props.freeInput.wrap(text) : text;
  draft.value = '';
  run({ label: 'free', prompt }).then((sent) => { if (!sent && !draft.value) draft.value = text; });
}

function openSidebar() {
  toggleAgentPanel(true);
}
</script>

<style scoped>
.ai-bar { background:#fff; border:1px solid var(--line, #e5eaf1); border-radius:8px; overflow:hidden; }
.ai-head { display:flex; align-items:center; gap:12px; padding:12px 16px 10px; }
.ai-badge { flex:none; display:grid; place-items:center; width:32px; height:32px; border-radius:7px; background:#eaf1ff; color:var(--blue-deep, #1d4ed8); font-size:12px; font-weight:750; }
.ai-heading { display:flex; flex-direction:column; gap:2px; min-width:0; }
.ai-heading strong { color:var(--ink, #152334); font-size:13px; line-height:1.3; }
.ai-heading > span { color:#66758a; font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ai-meta { display:flex; align-items:center; gap:16px; margin-left:auto; flex:none; }
.ai-status { display:flex; align-items:center; gap:6px; color:#66758a; font-size:11px; white-space:nowrap; }
.conn-dot { width:7px; height:7px; border-radius:50%; background:#d28b28; }
.ai-status.ok .conn-dot { background:#1e9b72; }
.ai-status.bad .conn-dot { background:#d85b5b; }
.ai-link { border:0; background:transparent; color:var(--blue-deep, #1d4ed8); font-size:12px; font-weight:600; cursor:pointer; padding:5px 0; white-space:nowrap; }
.ai-link:hover { text-decoration:underline; }
.ai-row { display:flex; align-items:center; gap:12px; padding:10px 16px 12px; border-top:1px solid #f0f2f6; }
.ai-triggers { display:flex; align-items:center; gap:8px; flex-wrap:wrap; flex:1; min-width:0; }
.ai-chip { border:1px solid #d9e1eb; background:#fff; color:#334155; border-radius:5px; padding:7px 12px; font-size:12px; cursor:pointer; min-height:32px; }
.ai-chip:hover:not(:disabled), .ai-chip:focus-visible { border-color:var(--blue, #2563eb); color:var(--blue-deep, #1d4ed8); background:#f3f7ff; }
.ai-chip.primary { background:var(--blue, #2563eb); border-color:var(--blue, #2563eb); color:#fff; }
.ai-chip.primary:hover:not(:disabled) { background:var(--blue-deep, #1d4ed8); color:#fff; }
.ai-chip:disabled { opacity:.55; cursor:default; }
.ai-collapse { border:0; background:transparent; color:#66758a; font-size:11px; white-space:nowrap; cursor:pointer; padding:6px; }
.ai-collapse:hover { color:var(--blue-deep, #1d4ed8); }
.ai-free { flex:1; min-width:180px; border:1px solid #d9e1eb; border-radius:5px; padding:7px 10px; font-size:12px; outline:none; }
.ai-free:focus { border-color:var(--blue, #2563eb); }
.ai-free::placeholder { color:#718093; }
@media (max-width:640px) {
  .ai-head { flex-wrap:wrap; }
  .ai-meta { width:100%; margin-left:0; padding-left:44px; justify-content:space-between; }
  .ai-row { align-items:stretch; flex-wrap:wrap; }
  .ai-free { min-width:0; width:100%; }
}

.ai-approvals { padding:0 12px 10px; }
.ai-result { margin:0 12px 10px; border-top:1px dashed var(--line, #e4e7ed); padding-top:10px; display:flex; flex-direction:column; gap:8px; max-height:420px; overflow-y:auto; }
.ai-msg { display:flex; flex-direction:column; gap:5px; }
.ai-steps { display:flex; gap:6px; flex-wrap:wrap; }
.ai-step { font-size:11px; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; padding:1px 8px; border-radius:4px; background:#f4f6fa; border:1px solid #e2e8f2; color:#606266; cursor:default; }
.ai-step.done { color:#67c23a; }
.ai-step.error { color:#f56c6c; }
.ai-step.running { color:#e6a23c; }
.ai-text { font-size:13px; line-height:1.65; color:var(--ink, #303133); white-space:pre-wrap; word-break:break-word; }
.ai-text.error { color:#f56c6c; }
.ai-thinking { font-size:12px; color:#909399; }
.cursor { color:var(--blue, #409eff); animation:blink 1s steps(1) infinite; }
@keyframes blink { 50% { opacity:0; } }
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
</style>

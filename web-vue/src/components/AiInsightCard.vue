<template>
  <div class="ai-bar" :class="{ expanded }">
    <div class="ai-row">
      <span class="ai-badge" title="AI 副驾">✨</span>
      <div class="ai-triggers">
        <button v-for="a in actions" :key="a.label" type="button" class="ai-chip" :class="{ primary: a.primary }"
                :disabled="agent.busy" @click="run(a)">{{ a.label }}</button>
        <template v-if="freeInput">
          <input v-model="draft" class="ai-free" :placeholder="freeInput.placeholder"
                 @keydown.enter.prevent="runFree" />
          <button type="button" class="ai-chip primary" :disabled="agent.busy || !draft.trim()" @click="runFree">
            {{ freeInput.button ?? '发送' }}
          </button>
        </template>
      </div>
      <div class="ai-meta">
        <span class="conn-dot" :class="agent.connected ? 'ok' : 'wait'" :title="agent.connected ? '副驾已连接' : '连接中…'"></span>
        <button type="button" class="ai-link" title="在完整副驾侧栏中继续对话" @click="openSidebar">副驾 ↗</button>
        <button v-if="expanded" type="button" class="ai-link" @click="collapsed = true">收起 ▴</button>
      </div>
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
        <div v-if="agent.busy && !hasStreamingText" class="ai-thinking">副驾处置中<span class="cursor">▍</span></div>
      </div>
    </template>
  </div>
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
const expanded = computed(
  () => !collapsed.value && (segment.value.length > 0 || (startIdx.value !== null && agent.approvals.length > 0)),
);

function stepIcon(status: string) {
  return status === 'done' ? '✓' : status === 'error' ? '✗' : '⏳';
}

async function run(a: AiAction) {
  const text = typeof a.prompt === 'function' ? a.prompt() : a.prompt;
  if (!text.trim()) return;
  startIdx.value = agent.messages.length;
  collapsed.value = false;
  try {
    await agent.send(text, {
      section: (route.meta.section as string) || '',
      title: (route.meta.title as string) || '',
      route: route.name,
      query: route.query,
    });
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code === 'turn_in_progress') ElMessage.warning('副驾正在处置上一轮任务，请稍候');
    else ElMessage.error(err.message || '发送失败');
  }
}

function runFree() {
  const text = draft.value.trim();
  if (!text) return;
  draft.value = '';
  run({ label: 'free', prompt: props.freeInput?.wrap ? props.freeInput.wrap(text) : text });
}

function openSidebar() {
  toggleAgentPanel(true);
}
</script>

<style scoped>
.ai-bar { background:#fff; border:1px solid var(--line, #e4e7ed); border-radius:10px; }
.ai-row { display:flex; align-items:center; gap:10px; padding:7px 12px; }
.ai-badge { flex:none; font-size:13px; }
.ai-triggers { display:flex; align-items:center; gap:8px; flex-wrap:wrap; flex:1; min-width:0; }
.ai-meta { flex:none; display:flex; align-items:center; gap:8px; margin-left:auto; }
.conn-dot { width:8px; height:8px; border-radius:50%; }
.conn-dot.ok { background:#67c23a; }
.conn-dot.wait { background:#e6a23c; }
.ai-link { border:0; background:transparent; color:var(--blue, #409eff); font-size:12px; cursor:pointer; padding:2px 4px; }
.ai-link:hover { text-decoration:underline; }

.ai-chip { border:1px solid #dcdfe6; background:#fff; color:#606266; border-radius:6px; padding:5px 12px; font-size:12.5px; cursor:pointer; }
.ai-chip:hover:not(:disabled) { border-color:var(--blue, #409eff); color:var(--blue, #409eff); }
.ai-chip.primary { background:var(--blue, #409eff); border-color:var(--blue, #409eff); color:#fff; }
.ai-chip.primary:hover:not(:disabled) { background:#66b1ff; color:#fff; }
.ai-chip:disabled { opacity:.55; cursor:default; }
.ai-free { flex:1; min-width:220px; border:1px solid #dcdfe6; border-radius:6px; padding:5px 12px; font-size:12.5px; outline:none; }
.ai-free:focus { border-color:var(--blue, #409eff); }

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

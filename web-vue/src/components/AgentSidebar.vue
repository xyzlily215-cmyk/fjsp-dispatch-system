<template>
  <button v-if="open && agentExpanded" type="button" class="copilot-scrim" aria-label="收起 AI 工作台" @click="toggleAgentExpanded(false)"></button>
  <section ref="panelEl" class="copilot" :class="{ open, docked: agentDocked, expanded: agentExpanded }" :style="panelStyle" aria-label="AI 调度助手工作栏">
    <div v-if="!agentExpanded" class="copilot-resize-x" @mousedown="onResizeDown"></div>
    <AgentChat v-if="open" @close="toggleAgentPanel(false)" />
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted } from 'vue';
import { agentDocked, agentExpanded, agentPanel, agentPanelWidth, setAgentPanelWidth, toggleAgentExpanded, toggleAgentPanel } from '../stores/agentPanel';
import AgentChat from './AgentChat.vue';

const open = computed(() => agentPanel.open);

/* 展开工作台时 Esc 收起为侧栏（输入法选词中的 Esc 不处理） */
function onKey(e) {
  if (e.key === 'Escape' && !e.isComposing && agentExpanded.value && agentPanel.open) toggleAgentExpanded(false);
}
onMounted(() => document.addEventListener('keydown', onKey));
onBeforeUnmount(() => document.removeEventListener('keydown', onKey));
const panelStyle = computed(() => ({ width: agentPanelWidth.value + 'px' }));

function onResizeDown(e) {
  e.preventDefault();
  const startX = e.clientX;
  const startW = agentPanel.width;
  const move = (ev) => { setAgentPanelWidth(startW + (startX - ev.clientX)); };
  const up = () => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
}
</script>

<style scoped>
.copilot { position:fixed; top:0; bottom:0; right:0; display:flex; flex-direction:column; max-width:100vw; background:var(--surface); border-left:1px solid var(--line); box-shadow:-12px 0 30px rgba(21,35,52,.10); z-index:940; transform:translateX(calc(100% + 24px)); transition:transform .28s ease-out; }
.copilot.open { transform:translateX(0); }
.copilot.docked { top:0; box-shadow:none; z-index:20; }
.copilot.expanded { top:12px; bottom:12px; right:12px; border:1px solid var(--line); border-radius:16px; overflow:hidden; box-shadow:0 24px 64px rgba(15,23,42,.22); z-index:950; transition:transform .28s ease-out, width .2s ease-out; }
.copilot-scrim { position:fixed; inset:0; z-index:945; border:0; background:rgba(15,23,42,.28); backdrop-filter:blur(2px); cursor:default; }
.copilot-resize-x { position:absolute; top:0; bottom:0; left:0; width:7px; cursor:ew-resize; z-index:2; }
.copilot-resize-x:hover { background:linear-gradient(90deg, var(--blue), transparent); }
@media (max-width:640px) {
  .copilot { width:100vw !important; }
  .copilot-resize-x { display:none; }
}
@media (prefers-reduced-motion:reduce) {
  .copilot { transition:none; }
}
</style>

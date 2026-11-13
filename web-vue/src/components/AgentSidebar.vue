<template>
  <section ref="panelEl" class="copilot" :class="{ open, docked: agentDocked }" :style="panelStyle" aria-label="AI 调度助手工作栏">
    <div class="copilot-resize-x" @mousedown="onResizeDown"></div>
    <AgentChat v-if="open" @close="toggleAgentPanel(false)" />
  </section>
</template>

<script setup>
import { computed } from 'vue';
import { agentDocked, agentPanel, agentPanelWidth, setAgentPanelWidth, toggleAgentPanel } from '../stores/agentPanel';
import AgentChat from './AgentChat.vue';

const open = computed(() => agentPanel.open);
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

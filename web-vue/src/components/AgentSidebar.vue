<template>
  <section ref="panelEl" class="copilot" :class="{ open }" :style="panelStyle">
    <div class="copilot-resize-x" @mousedown="onResizeDown"></div>
    <AgentChat v-if="open" @close="toggleAgentPanel(false)" />
  </section>
</template>

<script setup>
/* 抽屉壳：AI 调度副驾的滑出式容器（对话本体在 AgentChat.vue，数字孪生页内嵌复用）。
 * 开关沿用 stores/agentPanel.js（AppLayout 菜单项控制）；仅在打开时挂载对话，
 * 未读角标由 AgentChat 可见时清零（见组件内 watcher）。 */
import { computed, reactive, ref } from 'vue';
import { agentPanel, toggleAgentPanel } from '../stores/agentPanel';
import AgentChat from './AgentChat.vue';

const open = computed(() => agentPanel.open);
const panelSize = reactive({ w: 420 });
const panelStyle = computed(() => ({ width: panelSize.w + 'px' }));

const clampW = (w) => Math.min(Math.max(w, 340), window.innerWidth - 48);
function onResizeDown(e) {
  e.preventDefault();
  const startX = e.clientX;
  const startW = panelSize.w;
  const move = (ev) => { panelSize.w = clampW(startW + (startX - ev.clientX)); };
  const up = () => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    localStorage.setItem('fjsp.agentPanel.w', String(panelSize.w));
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
}

const savedW = parseInt(localStorage.getItem('fjsp.agentPanel.w'), 10);
if (!Number.isNaN(savedW)) panelSize.w = clampW(savedW);
</script>

<style scoped>
.copilot { position:fixed; top:0; bottom:0; right:0; display:flex; flex-direction:column; background:#fff; border-left:1px solid var(--line, #e4e7ed); box-shadow:-8px 0 30px rgba(0,0,0,.12); z-index:940; transform:translateX(calc(100% + 24px)); transition:transform .34s cubic-bezier(.32,.9,.35,1); }
.copilot.open { transform:translateX(0); }
.copilot-resize-x { position:absolute; top:0; bottom:0; left:0; width:7px; cursor:ew-resize; z-index:2; }
.copilot-resize-x:hover { background:linear-gradient(90deg, var(--blue, #409eff), transparent); }
</style>

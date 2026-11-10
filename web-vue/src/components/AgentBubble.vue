<template>
  <button ref="bubbleEl" type="button" class="agent-bubble"
          :class="{ active: open, dragging }" :style="bubbleStyle"
          :aria-expanded="open" aria-label="打开或关闭 AI 调度助手"
          title="AI 调度助手（可拖动）" @pointerdown="onPointerDown" @click="onClick">
    <span class="robot" aria-hidden="true">
      <svg viewBox="0 0 64 64" width="46" height="46">
        <line x1="32" y1="13" x2="32" y2="6" stroke="#a8c3f0" stroke-width="2" stroke-linecap="round"/>
        <circle class="robot-gem" cx="32" cy="4.5" r="3" fill="#409eff"/>
        <rect x="14" y="12" width="36" height="27" rx="11" fill="#fff" stroke="#dbe6f7" stroke-width="1.5"/>
        <rect x="19" y="17" width="26" height="17" rx="7" fill="#1b2b63"/>
        <ellipse class="robot-eye" cx="26" cy="24.5" rx="2.1" ry="3" fill="#5ee7ff"/>
        <ellipse class="robot-eye" cx="38" cy="24.5" rx="2.1" ry="3" fill="#5ee7ff"/>
        <path d="M28 29.5 Q32 32.5 36 29.5" stroke="#5ee7ff" stroke-width="1.4" fill="none" stroke-linecap="round"/>
        <rect x="9.5" y="42" width="6" height="10" rx="3" fill="#fff" stroke="#dbe6f7" stroke-width="1.5"/>
        <rect class="robot-arm-r" x="48.5" y="42" width="6" height="10" rx="3" fill="#fff" stroke="#dbe6f7" stroke-width="1.5"/>
        <rect x="21" y="40.5" width="22" height="14" rx="6" fill="#fff" stroke="#dbe6f7" stroke-width="1.5"/>
        <circle cx="32" cy="47.5" r="3.4" fill="#409eff"/>
        <circle cx="32" cy="47.5" r="1.4" fill="#eaf4ff"/>
        <ellipse cx="25" cy="58" rx="4" ry="2.4" fill="#409eff"/>
        <ellipse cx="39" cy="58" rx="4" ry="2.4" fill="#409eff"/>
      </svg>
    </span>
    <span v-if="agent.unread" class="bubble-unread" aria-label="未读消息">{{ agent.unread > 99 ? '99+' : agent.unread }}</span>
  </button>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { useAgentStore } from '../stores/agent';
import { agentPanel, toggleAgentPanel } from '../stores/agentPanel';

const agent = useAgentStore();
const open = computed(() => agentPanel.open);
const bubbleEl = ref(null);
const dragging = ref(false);
const position = reactive({ r: 22, b: 26 });
const bubbleStyle = computed(() => ({ right: `${position.r}px`, bottom: `${position.b}px` }));

function clampPosition() {
  position.r = Math.min(Math.max(position.r, 4), Math.max(4, window.innerWidth - 60));
  position.b = Math.min(Math.max(position.b, 4), Math.max(4, window.innerHeight - 60));
}

let start = null;
function stopTracking() {
  document.removeEventListener('pointermove', onPointerMove);
  document.removeEventListener('pointerup', onPointerUp);
  document.removeEventListener('pointercancel', onPointerCancel);
  start = null;
  dragging.value = false;
}

function onPointerDown(e) {
  if (e.button !== 0 || start) return;
  e.preventDefault();
  start = { id: e.pointerId, x: e.clientX, y: e.clientY, r: position.r, b: position.b };
  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', onPointerUp);
  document.addEventListener('pointercancel', onPointerCancel);
}

function onPointerMove(e) {
  if (!start || e.pointerId !== start.id) return;
  const dx = e.clientX - start.x;
  const dy = e.clientY - start.y;
  if (!dragging.value && Math.abs(dx) + Math.abs(dy) < 5) return;
  dragging.value = true;
  position.r = start.r - dx;
  position.b = start.b - dy;
  clampPosition();
}

function onPointerUp(e) {
  if (!start || e.pointerId !== start.id) return;
  const wasDragging = dragging.value;
  stopTracking();
  if (wasDragging) {
    localStorage.setItem('fjsp.agentPanel.br', String(position.r));
    localStorage.setItem('fjsp.agentPanel.bb', String(position.b));
  } else {
    toggleAgentPanel();
    bubbleEl.value?.focus();
  }
}

function onPointerCancel(e) {
  if (start && e.pointerId === start.id) stopTracking();
}

function onClick(e) {
  if (e.detail === 0) toggleAgentPanel();
}

onMounted(() => {
  const r = parseInt(localStorage.getItem('fjsp.agentPanel.br'), 10);
  const b = parseInt(localStorage.getItem('fjsp.agentPanel.bb'), 10);
  if (!Number.isNaN(r)) position.r = r;
  if (!Number.isNaN(b)) position.b = b;
  clampPosition();
  window.addEventListener('resize', clampPosition);
  if (localStorage.getItem('fjsp.agentPanel.open') === '1') agentPanel.open = true;
});

onBeforeUnmount(() => {
  stopTracking();
  window.removeEventListener('resize', clampPosition);
});
</script>

<style scoped>
.agent-bubble { position:fixed; z-index:950; display:grid; place-items:center; width:56px; height:56px; padding:0; border:1px solid #e3ecf9; border-radius:50%; background:#fff; box-shadow:0 6px 18px rgba(64,120,220,.22); cursor:grab; user-select:none; touch-action:none; }
.agent-bubble:hover { border-color:#c4dbf7; box-shadow:0 8px 24px rgba(64,120,220,.34); }
.agent-bubble:focus-visible { outline:3px solid #409eff; outline-offset:3px; }
.agent-bubble.dragging { cursor:grabbing; }
.agent-bubble.active { border-color:#9dc4f5; box-shadow:0 0 0 4px rgba(64,158,255,.18), 0 6px 18px rgba(64,120,220,.28); }
.robot { display:block; animation:robot-float 3s ease-in-out infinite; }
.dragging .robot { animation:none; }
@keyframes robot-float { 0%, 100% { transform:translateY(1px); } 50% { transform:translateY(-3px); } }
.robot-eye { transform-box:fill-box; transform-origin:center; animation:robot-blink 4.2s infinite; }
@keyframes robot-blink { 0%, 93%, 100% { transform:scaleY(1); } 95.5% { transform:scaleY(.1); } }
.robot-gem { transform-box:fill-box; transform-origin:center; animation:robot-gem 2.4s ease-in-out infinite; }
@keyframes robot-gem { 0%, 100% { opacity:1; } 50% { opacity:.45; } }
.robot-arm-r { transform-box:fill-box; transform-origin:top center; transition:transform .25s ease; }
.agent-bubble:hover .robot-arm-r { transform:rotate(-24deg); }
.bubble-unread { position:absolute; top:-5px; right:-5px; min-width:18px; height:18px; padding:0 4px; border-radius:9px; background:#e55353; color:#fff; font-size:10px; line-height:18px; text-align:center; }
@media (prefers-reduced-motion:reduce) { .robot, .robot-eye, .robot-gem { animation:none; } }
</style>

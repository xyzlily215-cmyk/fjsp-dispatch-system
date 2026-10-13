<template>
  <button type="button" ref="bubbleEl" class="agent-bubble" :class="{ active: open, dragging: bubbleDragging }"
          :style="bubbleStyle" title="智能体工作台（可拖动）"
          @mousedown="onBubbleDown">
    <span class="robot" aria-hidden="true">
      <svg viewBox="0 0 64 64" width="46" height="46">
        <!-- 天线 -->
        <line x1="32" y1="13" x2="32" y2="6" stroke="#a8c3f0" stroke-width="2" stroke-linecap="round"/>
        <circle class="robot-gem" cx="32" cy="4.5" r="3" fill="#409eff"/>
        <!-- 头 -->
        <rect x="14" y="12" width="36" height="27" rx="11" fill="#ffffff" stroke="#dbe6f7" stroke-width="1.5"/>
        <!-- 脸 -->
        <rect x="19" y="17" width="26" height="17" rx="7" fill="#1b2b63"/>
        <ellipse class="robot-eye" cx="26" cy="24.5" rx="2.1" ry="3" fill="#5ee7ff"/>
        <ellipse class="robot-eye" cx="38" cy="24.5" rx="2.1" ry="3" fill="#5ee7ff"/>
        <path d="M28 29.5 Q32 32.5 36 29.5" stroke="#5ee7ff" stroke-width="1.4" fill="none" stroke-linecap="round"/>
        <!-- 手臂 -->
        <rect class="robot-arm" x="9.5" y="42" width="6" height="10" rx="3" fill="#ffffff" stroke="#dbe6f7" stroke-width="1.5"/>
        <rect class="robot-arm robot-arm-r" x="48.5" y="42" width="6" height="10" rx="3" fill="#ffffff" stroke="#dbe6f7" stroke-width="1.5"/>
        <!-- 身体 -->
        <rect x="21" y="40.5" width="22" height="14" rx="6" fill="#ffffff" stroke="#dbe6f7" stroke-width="1.5"/>
        <circle cx="32" cy="47.5" r="3.4" fill="#409eff"/>
        <circle cx="32" cy="47.5" r="1.4" fill="#eaf4ff"/>
        <!-- 脚 -->
        <ellipse cx="25" cy="58" rx="4" ry="2.4" fill="#409eff"/>
        <ellipse cx="39" cy="58" rx="4" ry="2.4" fill="#409eff"/>
      </svg>
    </span>
  </button>
  <section ref="panelEl" class="agent-panel" :class="{ open }" :style="panelStyle" aria-hidden="false">
    <div class="agent-resize-x" @mousedown="onResizeDown"></div>
    <div class="agent-panel-head">
      <span class="agent-panel-title"><span class="agent-badge">AI</span>智能体工作台</span>
      <div class="agent-panel-actions">
        <button type="button" class="agent-icon-btn" title="重新加载" @click="reload">⟳</button>
        <button type="button" class="agent-icon-btn" title="弹出独立窗口" @click="openExternal">↗</button>
        <button type="button" class="agent-icon-btn" title="关闭" @click="toggle(false)">✕</button>
      </div>
    </div>
    <iframe v-if="loaded" ref="frameEl" class="agent-frame" :src="base"
            title="AGH 智能体工作台" referrerpolicy="no-referrer"></iframe>
  </section>
</template>

<script setup>
/* 悬浮小机器人 + 右侧滑出式面板，iframe 嵌入 AGH（默认 4177，可用 ?agh= 覆盖）。
   气泡位置、面板宽度、开关状态均存 localStorage。
   开关状态单例 agentPanel / toggleAgentPanel 在 src/stores/agentPanel.js。 */
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { agentPanel, toggleAgentPanel } from '../stores/agentPanel';

const base = (new URLSearchParams(location.search).get('agh')) || 'http://127.0.0.1:4177/';
const open = computed(() => agentPanel.open);
const loaded = ref(false);
const frameEl = ref(null);
const bubbleEl = ref(null);
const panelEl = ref(null);

const bubblePos = reactive({ r: 22, b: 26 });   // 距视口右/下偏移
const panelSize = reactive({ w: 440 });
const bubbleDragging = ref(false);

const bubbleStyle = computed(() => ({ right: bubblePos.r + 'px', bottom: bubblePos.b + 'px' }));
const panelStyle = computed(() => ({ width: panelSize.w + 'px' }));

function toggle(force) {
  toggleAgentPanel(force);
  if (agentPanel.open && !loaded.value) loaded.value = true;
}

function reload() {
  if (frameEl.value) frameEl.value.src = base;
}

function openExternal() {
  window.open(base, 'agh-workbench', 'width=1120,height=800,menubar=no,toolbar=no,location=no,status=no');
}

const clampW = (w) => Math.min(Math.max(w, 360), window.innerWidth - 48);

function trackDrag(onMove, onUp) {
  if (frameEl.value) frameEl.value.style.pointerEvents = 'none';
  const move = (ev) => onMove(ev);
  const up = (ev) => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    if (frameEl.value) frameEl.value.style.pointerEvents = '';
    if (onUp) onUp(ev);
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
}

/* 气泡：拖动改位置（>5px 才算拖拽，否则视为点击开关） */
function onBubbleDown(e) {
  e.preventDefault();
  const startX = e.clientX, startY = e.clientY;
  const startR = bubblePos.r, startB = bubblePos.b;
  let moved = false;
  trackDrag(
    (ev) => {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 5) return;
      moved = true;
      bubbleDragging.value = true;
      bubblePos.r = Math.min(Math.max(startR - dx, 4), window.innerWidth - 60);
      bubblePos.b = Math.min(Math.max(startB - dy, 4), window.innerHeight - 60);
    },
    () => {
      bubbleDragging.value = false;
      if (moved) {
        localStorage.setItem('fjsp.agentPanel.br', String(bubblePos.r));
        localStorage.setItem('fjsp.agentPanel.bb', String(bubblePos.b));
      } else {
        toggle();
      }
    },
  );
}

/* 面板：左缘拖宽 */
function onResizeDown(e) {
  e.preventDefault();
  const startX = e.clientX;
  const startW = panelSize.w;
  trackDrag(
    (ev) => { panelSize.w = clampW(startW + (startX - ev.clientX)); },
    () => { localStorage.setItem('fjsp.agentPanel.w', String(panelSize.w)); },
  );
}

function onKeydown(e) {
  if (e.key === 'Escape' && open.value) toggle(false);
}

/* 点击面板和气泡以外的空白处：收起面板（气泡自身走 onBubbleDown 的开关逻辑，不在这里处理） */
function onDocMousedown(e) {
  if (!open.value) return;
  const t = e.target;
  if ((panelEl.value && panelEl.value.contains(t)) || (bubbleEl.value && bubbleEl.value.contains(t))) return;
  toggle(false);
}

onMounted(() => {
  const br = parseInt(localStorage.getItem('fjsp.agentPanel.br'), 10);
  const bb = parseInt(localStorage.getItem('fjsp.agentPanel.bb'), 10);
  if (!Number.isNaN(br)) bubblePos.r = br;
  if (!Number.isNaN(bb)) bubblePos.b = bb;
  const w = parseInt(localStorage.getItem('fjsp.agentPanel.w'), 10);
  if (!Number.isNaN(w)) panelSize.w = clampW(w);
  localStorage.removeItem('fjsp.agentPanel.px');
  localStorage.removeItem('fjsp.agentPanel.py');
  localStorage.removeItem('fjsp.agentPanel.h');
  document.addEventListener('keydown', onKeydown);
  document.addEventListener('mousedown', onDocMousedown);
  if (localStorage.getItem('fjsp.agentPanel.open') === '1') {
    agentPanel.open = true;
    loaded.value = true;
  }
});

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown);
  document.removeEventListener('mousedown', onDocMousedown);
});
</script>

<style scoped>
.agent-bubble { position:fixed; width:56px; height:56px; border:1px solid #e3ecf9; border-radius:50%; background:#fff; cursor:grab; user-select:none; box-shadow:0 6px 18px rgba(64,120,220,.22); z-index:950; display:grid; place-items:center; padding:0; transition:box-shadow .2s ease, border-color .2s ease; }
.agent-bubble:hover { box-shadow:0 8px 24px rgba(64,120,220,.34); border-color:#c4dbf7; }
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

.agent-panel { position:fixed; top:0; bottom:0; right:0; display:flex; flex-direction:column; background:#fff; border-left:1px solid var(--line, #e4e7ed); box-shadow:-8px 0 30px rgba(0,0,0,.12); overflow:hidden; z-index:940; transform:translateX(calc(100% + 24px)); transition:transform .34s cubic-bezier(.32, .9, .35, 1); }
.agent-panel.open { transform:translateX(0); }
.agent-panel-head { height:44px; flex:none; display:flex; align-items:center; justify-content:space-between; padding:0 8px 0 21px; border-bottom:1px solid var(--line, #e4e7ed); background:#fafbfc; user-select:none; }
.agent-panel-title { display:flex; align-items:center; gap:8px; font-size:13px; font-weight:600; color:var(--ink, #303133); }
.agent-badge { display:grid; place-items:center; width:20px; height:20px; border-radius:5px; background:var(--blue, #409eff); color:#fff; font-size:10px; font-weight:700; }
.agent-panel-actions { display:flex; align-items:center; gap:2px; }
.agent-icon-btn { width:28px; height:28px; border:0; border-radius:5px; background:transparent; color:#606266; font-size:14px; display:grid; place-items:center; cursor:pointer; }
.agent-icon-btn:hover { background:#ecf5ff; color:var(--blue, #409eff); }
.agent-frame { flex:1; border:0; width:100%; background:#fff; }
.agent-resize-x { position:absolute; top:0; bottom:0; left:0; width:7px; cursor:ew-resize; z-index:2; }
.agent-resize-x:hover { background:linear-gradient(90deg, var(--blue, #409eff), transparent); }
</style>

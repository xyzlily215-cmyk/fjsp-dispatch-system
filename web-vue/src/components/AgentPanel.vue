<template>
  <button type="button" ref="bubbleEl" class="agent-bubble" :class="{ active: open, dragging: bubbleDragging }"
          :style="bubbleStyle" title="智能体工作台（可拖动）"
          @mousedown="onBubbleDown">AI</button>
  <section v-show="open" class="agent-panel" :style="panelStyle" aria-hidden="false">
    <div class="agent-resize-y" @mousedown="onResizeDown($event, 'y')"></div>
    <div class="agent-resize-x" @mousedown="onResizeDown($event, 'x')"></div>
    <div class="agent-panel-head" title="拖动移动面板，双击恢复跟随气泡"
         @mousedown="onPanelDragDown" @dblclick="resetAnchor">
      <span class="agent-panel-title"><span class="agent-badge">AI</span>智能体工作台</span>
      <div class="agent-panel-actions" @mousedown.stop>
        <button type="button" class="agent-icon-btn" title="重新加载" @click="reload">⟳</button>
        <button type="button" class="agent-icon-btn" title="弹出独立窗口" @click="openExternal">↗</button>
        <button type="button" class="agent-icon-btn" title="关闭" @click="toggle(false)">✕</button>
      </div>
    </div>
    <iframe v-if="loaded" ref="frameEl" class="agent-frame" :src="base"
            title="AGH 智能体工作台" referrerpolicy="no-referrer"></iframe>
  </section>
</template>

<script>
/* 悬浮气泡 + 可移动/可调大小面板，iframe 嵌入 AGH（默认 4177，可用 ?agh= 覆盖）。
   气泡位置、面板尺寸、面板手动位置、开关状态均存 localStorage。
   面板位置策略：手动拖过 → 记住手动位置；未拖过 → 锚定气泡（上方优先，不够则下方）；
   双击标题栏清除手动位置、恢复跟随气泡。 */
import { reactive } from 'vue';

export const agentPanel = reactive({ open: false });
export function toggleAgentPanel(force) {
  agentPanel.open = force !== undefined ? force : !agentPanel.open;
  localStorage.setItem('fjsp.agentPanel.open', agentPanel.open ? '1' : '0');
}
</script>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

const base = (new URLSearchParams(location.search).get('agh')) || 'http://127.0.0.1:4177/';
const open = computed(() => agentPanel.open);
const loaded = ref(false);
const frameEl = ref(null);
const bubbleEl = ref(null);

const bubblePos = reactive({ r: 22, b: 26 });          // 距视口右/下偏移
const panelSize = reactive({ w: 440, h: Math.min(640, Math.round(window.innerHeight * 0.72)) });
const panelPos = reactive({ x: null, y: null });       // 手动位置（left/top），null=跟随气泡
const anchor = reactive({ right: 22, bottom: 86 });    // 跟随气泡时由 positionPanel 计算
const bubbleDragging = ref(false);

const bubbleStyle = computed(() => ({ right: bubblePos.r + 'px', bottom: bubblePos.b + 'px' }));
const panelStyle = computed(() => {
  const s = { width: panelSize.w + 'px', height: panelSize.h + 'px' };
  if (panelPos.x !== null) {
    s.left = panelPos.x + 'px'; s.top = panelPos.y + 'px';
  } else {
    s.right = anchor.right + 'px'; s.bottom = anchor.bottom + 'px';
  }
  return s;
});

function toggle(force) {
  toggleAgentPanel(force);
  if (agentPanel.open && !loaded.value) loaded.value = true;
  if (agentPanel.open) positionPanel();
}

function reload() {
  if (frameEl.value) frameEl.value.src = base;
}

function openExternal() {
  window.open(base, 'agh-workbench', 'width=1120,height=800,menubar=no,toolbar=no,location=no,status=no');
}

const clampW = (w) => Math.min(Math.max(w, 360), window.innerWidth - 48);
const clampH = (h) => Math.min(Math.max(h, 320), window.innerHeight - 120);
const clampX = (x) => Math.min(Math.max(x, 8 - 0), Math.max(window.innerWidth - panelSize.w - 8, 8));
const clampY = (y) => Math.min(Math.max(y, 8), Math.max(window.innerHeight - 80, 8));

/* 面板锚定气泡：优先上方，上方放不下则下方 */
function positionPanel() {
  if (panelPos.x !== null) return;
  const b = bubbleEl.value ? bubbleEl.value.getBoundingClientRect() : null;
  if (!b) return;
  anchor.right = Math.min(Math.max(window.innerWidth - b.right, 8), Math.max(window.innerWidth - panelSize.w - 8, 8));
  if (b.top > panelSize.h + 24) {
    anchor.bottom = window.innerHeight - b.top + 12;
  } else {
    anchor.bottom = Math.max(window.innerHeight - (b.bottom + 12) - panelSize.h, 8);
  }
}

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
      bubblePos.r = Math.min(Math.max(startR - dx, 4), window.innerWidth - 52);
      bubblePos.b = Math.min(Math.max(startB - dy, 4), window.innerHeight - 52);
      if (open.value) positionPanel();
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

/* 面板：拖标题栏自由移动（切换为 left/top 手动定位） */
function onPanelDragDown(e) {
  if (e.button !== 0) return;
  e.preventDefault();
  const panel = e.currentTarget.closest('.agent-panel');
  const rect = panel.getBoundingClientRect();
  const startX = e.clientX, startY = e.clientY;
  const startL = rect.left, startT = rect.top;
  trackDrag(
    (ev) => {
      panelPos.x = clampX(startL + (ev.clientX - startX));
      panelPos.y = clampY(startT + (ev.clientY - startY));
    },
    () => {
      if (panelPos.x !== null) {
        localStorage.setItem('fjsp.agentPanel.px', String(panelPos.x));
        localStorage.setItem('fjsp.agentPanel.py', String(panelPos.y));
      }
    },
  );
}

/* 双击标题栏：清除手动位置，恢复跟随气泡 */
function resetAnchor() {
  panelPos.x = null;
  panelPos.y = null;
  localStorage.removeItem('fjsp.agentPanel.px');
  localStorage.removeItem('fjsp.agentPanel.py');
  positionPanel();
}

/* 面板：左缘调宽、上缘调高 */
function onResizeDown(e, axis) {
  e.preventDefault();
  const startX = e.clientX, startY = e.clientY;
  const startW = panelSize.w, startH = panelSize.h;
  trackDrag(
    (ev) => {
      if (axis === 'x') {
        if (panelPos.x === null) {
          panelSize.w = clampW(startW + (startX - ev.clientX));
        } else {
          const newW = clampW(startW + (ev.clientX - startX) * -1);
          panelPos.x = clampX(panelPos.x + (panelSize.w - newW));
          panelSize.w = newW;
        }
      } else {
        if (panelPos.x === null) {
          panelSize.h = clampH(startH + (startY - ev.clientY));
        } else {
          const newH = clampH(startH + (ev.clientY - startY) * -1);
          panelPos.y = clampY(panelPos.y + (panelSize.h - newH));
          panelSize.h = newH;
        }
      }
    },
    () => {
      localStorage.setItem('fjsp.agentPanel.w', String(panelSize.w));
      localStorage.setItem('fjsp.agentPanel.h', String(panelSize.h));
      positionPanel();
    },
  );
}

function onKeydown(e) {
  if (e.key === 'Escape' && open.value) toggle(false);
}

onMounted(() => {
  const br = parseInt(localStorage.getItem('fjsp.agentPanel.br'), 10);
  const bb = parseInt(localStorage.getItem('fjsp.agentPanel.bb'), 10);
  if (!Number.isNaN(br)) bubblePos.r = br;
  if (!Number.isNaN(bb)) bubblePos.b = bb;
  const w = parseInt(localStorage.getItem('fjsp.agentPanel.w'), 10);
  const h = parseInt(localStorage.getItem('fjsp.agentPanel.h'), 10);
  if (!Number.isNaN(w)) panelSize.w = clampW(w);
  if (!Number.isNaN(h)) panelSize.h = clampH(h);
  const px = parseInt(localStorage.getItem('fjsp.agentPanel.px'), 10);
  const py = parseInt(localStorage.getItem('fjsp.agentPanel.py'), 10);
  if (!Number.isNaN(px) && !Number.isNaN(py)) {
    panelPos.x = clampX(px);
    panelPos.y = clampY(py);
  }
  document.addEventListener('keydown', onKeydown);
  window.addEventListener('resize', positionPanel);
  if (localStorage.getItem('fjsp.agentPanel.open') === '1') {
    agentPanel.open = true;
    loaded.value = true;
    positionPanel();
  }
});

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown);
  window.removeEventListener('resize', positionPanel);
});
</script>

<style scoped>
.agent-bubble { position:fixed; width:48px; height:48px; border:0; border-radius:50%; background:var(--blue, #409eff); color:#fff; font-size:13px; font-weight:700; letter-spacing:1px; cursor:grab; user-select:none; box-shadow:0 4px 14px rgba(64,158,255,.45); z-index:950; transition:transform .15s ease, background .15s ease; }
.agent-bubble:hover { transform:scale(1.08); background:var(--blue-deep, #337ecc); }
.agent-bubble.dragging { cursor:grabbing; transition:none; transform:scale(1.05); }
.agent-bubble.active { background:var(--blue-deep, #337ecc); box-shadow:0 0 0 4px rgba(64,158,255,.25), 0 4px 14px rgba(64,158,255,.45); }
.agent-panel { position:fixed; display:flex; flex-direction:column; background:#fff; border:1px solid var(--line, #e4e7ed); border-radius:10px; box-shadow:0 10px 34px rgba(0,0,0,.16); overflow:hidden; z-index:940; }
.agent-panel-head { height:44px; flex:none; display:flex; align-items:center; justify-content:space-between; padding:0 8px 0 21px; border-bottom:1px solid var(--line, #e4e7ed); background:#fafbfc; cursor:move; user-select:none; }
.agent-panel-title { display:flex; align-items:center; gap:8px; font-size:13px; font-weight:600; color:var(--ink, #303133); }
.agent-badge { display:grid; place-items:center; width:20px; height:20px; border-radius:5px; background:var(--blue, #409eff); color:#fff; font-size:10px; font-weight:700; }
.agent-panel-actions { display:flex; align-items:center; gap:2px; }
.agent-icon-btn { width:28px; height:28px; border:0; border-radius:5px; background:transparent; color:#606266; font-size:14px; display:grid; place-items:center; cursor:pointer; }
.agent-icon-btn:hover { background:#ecf5ff; color:var(--blue, #409eff); }
.agent-frame { flex:1; border:0; width:100%; background:#fff; }
.agent-resize-x { position:absolute; top:0; bottom:0; left:0; width:7px; cursor:ew-resize; z-index:2; }
.agent-resize-y { position:absolute; top:0; left:21px; right:0; height:7px; cursor:ns-resize; z-index:2; }
.agent-resize-x:hover { background:linear-gradient(90deg, var(--blue, #409eff), transparent); }
.agent-resize-y:hover { background:linear-gradient(180deg, var(--blue, #409eff), transparent); }
</style>

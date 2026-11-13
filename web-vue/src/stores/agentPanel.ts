/* 智能体工作台面板开关、宽度与响应式布局（跨组件单例） */
import { computed, reactive } from 'vue';

/* expanded：多会话工作台（左会话列表 + 右对话），以宽浮层覆盖内容区，不挤占页面 */
export function agentLayoutMode(width: number, open: boolean, expanded = false) {
  if (!open) return 'closed';
  if (expanded) return 'expanded';
  return width >= 1440 ? 'docked' : 'drawer';
}

export function expandedPanelWidth(viewportW: number) {
  return Math.max(320, Math.min(1080, viewportW - 48));
}

export function initialAgentPanelOpen(width: number, saved: string | null) {
  return saved === null ? width >= 1440 : saved === '1';
}

const viewportW = typeof window === 'undefined' ? 1280 : window.innerWidth;
const savedOpen = typeof localStorage === 'undefined' ? null : localStorage.getItem('fjsp.agentPanel.open');
const savedW = typeof localStorage === 'undefined' ? NaN : parseInt(localStorage.getItem('fjsp.agentPanel.w') || '', 10);
export const agentPanel = reactive({
  open: initialAgentPanelOpen(viewportW, savedOpen),
  width: Number.isNaN(savedW) ? 360 : savedW,
  viewportW,
  expanded: typeof localStorage !== 'undefined' && localStorage.getItem('fjsp.agentPanel.expanded') === '1',
});

export const agentMode = computed(() => agentLayoutMode(agentPanel.viewportW, agentPanel.open, agentPanel.expanded));
export const agentDocked = computed(() => agentMode.value === 'docked');
export const agentExpanded = computed(() => agentMode.value === 'expanded');
export const agentPanelWidth = computed(() => (agentExpanded.value
  ? expandedPanelWidth(agentPanel.viewportW)
  : Math.min(agentPanel.width, agentDocked.value ? 360 : Math.max(320, agentPanel.viewportW - 24))));

export function toggleAgentExpanded(force?: boolean) {
  agentPanel.expanded = force !== undefined ? force : !agentPanel.expanded;
  localStorage.setItem('fjsp.agentPanel.expanded', agentPanel.expanded ? '1' : '0');
}

export function toggleAgentPanel(force?: boolean) {
  agentPanel.open = force !== undefined ? force : !agentPanel.open;
  localStorage.setItem('fjsp.agentPanel.open', agentPanel.open ? '1' : '0');
}

export function syncAgentViewport(width: number) {
  agentPanel.viewportW = width;
}

export function setAgentPanelWidth(width: number) {
  const max = agentDocked.value ? 360 : Math.max(340, Math.min(480, agentPanel.viewportW - 24));
  agentPanel.width = Math.min(Math.max(width, 340), max);
  localStorage.setItem('fjsp.agentPanel.w', String(agentPanel.width));
}

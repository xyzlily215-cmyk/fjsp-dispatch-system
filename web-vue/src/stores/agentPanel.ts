/* 智能体工作台面板开关状态（跨组件单例，自 AgentPanel.vue 的双 <script> 命令式导出迁入） */
import { reactive } from 'vue';

export const agentPanel = reactive({ open: false });

export function toggleAgentPanel(force) {
  agentPanel.open = force !== undefined ? force : !agentPanel.open;
  localStorage.setItem('fjsp.agentPanel.open', agentPanel.open ? '1' : '0');
}

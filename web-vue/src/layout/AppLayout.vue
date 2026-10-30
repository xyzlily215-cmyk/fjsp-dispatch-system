<template>
  <div class="app" :class="{ 'nav-open': mobileNavOpen }">
    <button v-if="mobileNavOpen" class="nav-backdrop" type="button" aria-label="关闭导航" @click="mobileNavOpen = false"></button>
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-mark">▦</span>
        <span class="brand-copy"><strong>FJSP OPS</strong><small>柔性车间控制台</small></span>
      </div>
      <div class="brand-context"><span class="live-dot"></span><span>计划调度 · 仿真决策</span></div>
      <nav class="menu" id="navMenu">
        <template v-for="(entry, i) in menu" :key="i">
          <div v-if="entry.section" v-show="!entry.roles || auth.hasAnyRole(...entry.roles)" class="menu-section">{{ entry.section }}</div>
          <div v-else-if="entry.group" class="menu-group">
            <div class="menu-parent" role="button" tabindex="0" :aria-expanded="!collapsed.has(entry.group)" @click="toggleGroup(entry.group)" @keydown.enter.space.prevent="toggleGroup(entry.group)">
              <span class="menu-label"><span class="menu-icon" v-html="entry.icon"></span>{{ entry.group }}</span>
              <span class="chev" :class="{ collapsed: collapsed.has(entry.group) }">▾</span>
            </div>
            <div class="submenu" v-show="!collapsed.has(entry.group)">
              <div v-for="item in entry.children" :key="item.id" v-show="!item.roles || auth.hasAnyRole(...item.roles)"
                   class="menu-item" :class="{ active: route.name === item.id }"
                   role="button" tabindex="0"
                   @click="goTo(item.id)" @keydown.enter.space.prevent="goTo(item.id)">{{ item.title }}</div>
            </div>
          </div>
          <div v-else v-show="!entry.roles || auth.hasAnyRole(...entry.roles)"
               class="menu-item" :class="{ active: route.name === entry.id }"
               role="button" tabindex="0"
               @click="goTo(entry.id)" @keydown.enter.space.prevent="goTo(entry.id)">
            <span class="menu-icon" v-html="entry.icon"></span>{{ entry.title }}<span
              v-if="entry.id === '__agent-panel' && agent.unread"
              style="margin-left:auto;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:#f56c6c;color:#fff;font-size:11px;line-height:18px;text-align:center"
            >{{ agent.unread > 99 ? '99+' : agent.unread }}</span></div>
        </template>
      </nav>
    </aside>
    <main class="main">
      <header class="topbar">
        <div class="topbar-left">
          <button type="button" class="nav-toggle" aria-label="打开导航" @click="mobileNavOpen = true">☰</button>
          <button type="button" class="btn back-btn" v-show="route.name !== 'board'" @click="goBack">← 返回</button>
          <div class="crumb"><span class="crumb-section">{{ route.meta.section }}</span><span>/</span><b>{{ route.meta.title }}</b></div>
        </div>
        <div class="top-actions">
          <span class="api-status" v-html="apiStatus"></span>
          <div class="operator">
            <span class="avatar">{{ initial }}</span>
            <span class="operator-name">{{ auth.user?.displayName || auth.user?.username }} · {{ roleText(auth.role) }}</span>
            <button class="btn small logout-btn" @click="logout">退出</button>
          </div>
        </div>
      </header>
      <div class="content">
        <router-view />
      </div>
    </main>
    <AgentSidebar />
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore, roleText } from '../stores/auth';
import { useSharedStore } from '../stores/shared';
import { useAgentStore } from '../stores/agent';
import { esc } from '../utils/format';
import AgentSidebar from '../components/AgentSidebar.vue';
import { toggleAgentPanel } from '../stores/agentPanel';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const shared = useSharedStore();
const agent = useAgentStore();
const mobileNavOpen = ref(false);

const menu = [
  { section: '工作台' },
  { id: 'board', title: '调度看板', icon: '▧' },
  { id: 'twin', title: '数字孪生', icon: '▣' },
  { section: '基础数据' },
  {
    group: '基础数据', icon: '⚙', children: [
      { id: 'machines', title: '设备管理' },
      { id: 'calendar', title: '设备日历' },
      { id: 'templates', title: '工艺模板' },
      { id: 'orders', title: '订单管理' },
      { id: 'import', title: '批量导入', roles: ['ADMIN'] },
    ],
  },
  { section: '计划调度' },
  {
    group: '计划调度', icon: '◆', children: [
      { id: 'baseline', title: '基线排程' },
      { id: 'reschedule', title: '重调度向导' },
      { id: 'tasks', title: '调度任务' },
      { id: 'versions', title: '计划版本' },
    ],
  },
  { section: '运行与分析' },
  {
    group: '事件管理', icon: '⚠', children: [
      { id: 'insert', title: '订单插单' },
      { id: 'breakdown', title: '设备故障' },
    ],
  },
  {
    group: '结果分析', icon: '◈', children: [
      { id: 'resource-gantt', title: '甘特图' },
      { id: 'compare', title: '方案对比' },
    ],
  },
  {
    group: '审核发布', icon: '✓', children: [
      { id: 'review', title: '待审核方案' },
    ],
  },
  { id: 'execution', title: '实际执行', icon: '▶' },
  { section: '系统管理', roles: ['ADMIN'] },
  { id: 'admin-users', title: '用户管理', icon: '☺', roles: ['ADMIN'] },
  { id: 'admin-configs', title: '字典维护', icon: '☷', roles: ['ADMIN'] },
  { section: '智能体' },
  { id: 'agent-trace', title: '处置时间线', icon: '⌚', roles: ['ADMIN'] },
  { id: '__agent-panel', title: 'AI 调度副驾', icon: '<span style="font-size:11px">AI</span>' },
];

const collapsed = reactive(new Set());
function toggleGroup(g) {
  collapsed.has(g) ? collapsed.delete(g) : collapsed.add(g);
}

function goTo(name) {
  mobileNavOpen.value = false;
  if (name === '__agent-panel') { toggleAgentPanel(); return; }
  if (route.name !== name) router.push({ name });
}

function goBack() {
  if (window.history.state && window.history.state.back) router.back();
  else router.push({ name: 'board' });
}

const apiStatus = computed(() => {
  const plan = shared.dashboard && shared.dashboard.currentPlan;
  if (shared.dashboard === null) return '<span style="color:#f56c6c">API 未连接</span>';
  return plan
    ? `当前发布 <b>${esc(plan.versionCode)}</b> · ${esc(plan.status)}`
    : '无当前发布计划';
});

const initial = computed(() => {
  const u = auth.user;
  return ((u && (u.displayName || u.username)) || '?').charAt(0);
});

function logout() {
  auth.logout();
  router.push({ name: 'login' });
}

onMounted(() => { shared.refreshDashboard(); agent.connect(); agent.refreshHealth(); });
watch(() => route.name, () => { mobileNavOpen.value = false; });
</script>

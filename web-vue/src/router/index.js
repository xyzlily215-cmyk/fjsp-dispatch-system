import { createRouter, createWebHashHistory } from 'vue-router';
import { pinia } from '../stores';
import { useAuthStore } from '../stores/auth';

/* 路由与旧版页面 id 一一对应。
 * meta: { section, title, roles? } —— roles 供菜单过滤与路由守卫（服务端仍强校验）。 */
const routes = [
  { path: '/login', name: 'login', component: () => import('../layout/LoginView.vue'), meta: { public: true } },
  {
    path: '/',
    component: () => import('../layout/AppLayout.vue'),
    children: [
      { path: '', redirect: { name: 'board' } },
      { path: 'board', name: 'board', component: () => import('../views/BoardView.vue'), meta: { section: '工作台', title: '调度看板' } },
      { path: 'twin', name: 'twin', component: () => import('../views/TwinView.vue'), meta: { section: '工作台', title: '数字孪生车间' } },
      { path: 'machines', name: 'machines', component: () => import('../views/MachinesView.vue'), meta: { section: '基础数据', title: '设备管理' } },
      { path: 'calendar', name: 'calendar', component: () => import('../views/CalendarView.vue'), meta: { section: '基础数据', title: '设备日历' } },
      { path: 'templates', name: 'templates', component: () => import('../views/TemplatesView.vue'), meta: { section: '基础数据', title: '工艺模板' } },
      { path: 'orders', name: 'orders', component: () => import('../views/OrdersView.vue'), meta: { section: '基础数据', title: '订单管理' } },
      { path: 'import', name: 'import', component: () => import('../views/ImportView.vue'), meta: { section: '基础数据', title: '批量导入', roles: ['ADMIN'] } },
      { path: 'baseline', name: 'baseline', component: () => import('../views/BaselineView.vue'), meta: { section: '计划调度', title: '基线排程' } },
      { path: 'reschedule', name: 'reschedule', component: () => import('../views/RescheduleView.vue'), meta: { section: '计划调度', title: '重调度向导' } },
      { path: 'tasks', name: 'tasks', component: () => import('../views/TasksView.vue'), meta: { section: '计划调度', title: '调度任务' } },
      { path: 'versions', name: 'versions', component: () => import('../views/VersionsView.vue'), meta: { section: '计划调度', title: '计划版本' } },
      { path: 'insert', name: 'insert', component: () => import('../views/InsertView.vue'), meta: { section: '事件管理', title: '订单插单' } },
      { path: 'breakdown', name: 'breakdown', component: () => import('../views/BreakdownView.vue'), meta: { section: '事件管理', title: '设备故障' } },
      { path: 'resource-gantt', name: 'resource-gantt', component: () => import('../views/GanttView.vue'), meta: { section: '结果分析', title: '甘特图' } },
      { path: 'compare', name: 'compare', component: () => import('../views/CompareView.vue'), meta: { section: '结果分析', title: '方案对比' } },
      { path: 'review', name: 'review', component: () => import('../views/ReviewView.vue'), meta: { section: '审核发布', title: '待审核方案' } },
      { path: 'execution', name: 'execution', component: () => import('../views/ExecutionView.vue'), meta: { section: '执行反馈', title: '实际执行' } },
      { path: 'admin-users', name: 'admin-users', component: () => import('../views/AdminUsersView.vue'), meta: { section: '系统管理', title: '用户管理', roles: ['ADMIN'] } },
      { path: 'admin-configs', name: 'admin-configs', component: () => import('../views/AdminConfigsView.vue'), meta: { section: '系统管理', title: '字典维护', roles: ['ADMIN'] } },
      { path: 'agent-trace', name: 'agent-trace', component: () => import('../views/AgentTraceView.vue'), meta: { section: '智能体', title: 'Agent 处置时间线', roles: ['ADMIN'] } },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: { name: 'board' } },
];

export const router = createRouter({
  /* hash 模式：部署目标是无回退规则的纯静态服务（python http.server），避免刷新子路径 404 */
  history: createWebHashHistory(),
  routes,
});

router.beforeEach((to) => {
  const auth = useAuthStore(pinia);
  if (to.meta.public) {
    return auth.isLoggedIn ? { name: 'board' } : true;
  }
  if (!auth.isLoggedIn) return { name: 'login' };
  if (to.meta.roles && !auth.hasAnyRole(...to.meta.roles)) return { name: 'board' };
  return true;
});

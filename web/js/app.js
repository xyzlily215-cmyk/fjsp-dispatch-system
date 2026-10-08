/* 应用骨架：页面注册、路由切换、跨页跳转参数 */
const Pages = {};           // pageId -> { meta: [section, title], render(el, params) }
let currentPage = null;
let currentParams = null;
const navHistory = [];      // 返回按钮用的页面历史栈（仅前进导航入栈）

function registerPage(id, meta, render) { Pages[id] = { meta, render }; }

function goTo(page, params, viaBack) {
  if (!Pages[page]) { toast('页面不存在：' + page, 'error'); return; }
  if (currentPage && currentPage !== page && !viaBack) {
    navHistory.push({ page: currentPage, params: currentParams });
  }
  currentPage = page; currentParams = params || null;
  document.querySelectorAll('.page-panel').forEach(p => p.classList.remove('active'));
  document.getElementById(page).classList.add('active');
  document.querySelectorAll('.menu-item').forEach(i => i.classList.toggle('active', i.dataset.page === page));
  const m = Pages[page].meta;
  document.getElementById('breadcrumb').innerHTML = '<b>' + esc(m[0]) + '</b><span>/</span>' + esc(m[1]);
  // 调度看板是首页，不显示返回按钮
  document.getElementById('backBtn').style.display = page === 'board' ? 'none' : '';
  window.scrollTo({ top: 0 });
  renderCurrent();
}

function goBack() {
  const prev = navHistory.pop();
  if (prev && Pages[prev.page]) goTo(prev.page, prev.params, true);
  else goTo('board');
}

function renderCurrent() {
  if (!currentPage) return;
  const el = document.getElementById(currentPage);
  try {
    const r = Pages[currentPage].render(el, currentParams || {});
    // 页面 render 多为 async：最终 innerHTML 在 promise 兑现前写入，此处统一应用角色可见性
    if (r && r.catch) r.catch(e => { el.innerHTML = errorBoxHtml(e); })
      .finally(() => applyRoleVisibility(el));
  } catch (e) {
    el.innerHTML = errorBoxHtml(e);
  }
  applyRoleVisibility(el);
}

/* 共享缓存：当前发布计划、版本列表，跨页跳转时预选 */
const Shared = {
  dashboard: null,
  ganttVersionId: null,     // 甘特预选版本
  ganttView: null,          // 甘特视图：resource / order
  ganttFocusOp: null,       // 跨视图联动定位的目标工序
  calendarMachineId: null,  // 设备日历预选设备
  compareBaselineId: null,  // 方案对比预选
  compareCandidateId: null,
  selectedTaskId: null,     // 任务详情预选
  tasksPageNo: 0,           // 任务队列页码
  reviewPageNo: 0,          // 审核队列页码
  eventsPageNo: 0,          // 事件记录页码
  eventsType: '',           // 事件记录类型过滤
};

async function refreshShared() {
  try {
    Shared.dashboard = await Api.dashboard();
    const el = document.getElementById('apiStatus');
    const plan = Shared.dashboard.currentPlan;
    el.innerHTML = plan
      ? `当前发布 <b>${esc(plan.versionCode)}</b> · ${esc(plan.status)}`
      : '无当前发布计划';
  } catch (e) {
    Shared.dashboard = null;
    document.getElementById('apiStatus').innerHTML = '<span style="color:#f56c6c">API 未连接</span>';
  }
}

const App = {
  listenersBound: false,

  async boot() {
    Auth.bindLoginForm(() => this.start());
    if (!Auth.token()) {
      Auth.showLogin();
      return;
    }
    await this.start();
  },

  async start() {
    if (!this.listenersBound) {
      document.querySelectorAll('.menu-item[data-page]').forEach(item => {
        item.addEventListener('click', () => goTo(item.dataset.page));
        item.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goTo(item.dataset.page); }
        });
      });
      document.querySelectorAll('.menu-parent').forEach(p => {
        p.addEventListener('click', () => p.classList.toggle('collapsed'));
      });
      document.getElementById('backBtn').addEventListener('click', goBack);
      this.listenersBound = true;
    }
    Auth.renderUserBadge();
    // 菜单项的 data-roles 可见性（如系统管理仅 ADMIN）
    applyRoleVisibility(document.getElementById('navMenu'));
    await refreshShared();
    goTo('board');
  },
};

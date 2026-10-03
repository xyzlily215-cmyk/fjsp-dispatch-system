/* 应用骨架：页面注册、路由切换、跨页跳转参数 */
const Pages = {};           // pageId -> { meta: [section, title], render(el, params) }
let currentPage = null;
let currentParams = null;

function registerPage(id, meta, render) { Pages[id] = { meta, render }; }

function goTo(page, params) {
  if (!Pages[page]) { toast('页面不存在：' + page, 'error'); return; }
  currentPage = page; currentParams = params || null;
  document.querySelectorAll('.page-panel').forEach(p => p.classList.remove('active'));
  document.getElementById(page).classList.add('active');
  document.querySelectorAll('.menu-item').forEach(i => i.classList.toggle('active', i.dataset.page === page));
  const m = Pages[page].meta;
  document.getElementById('breadcrumb').innerHTML = '<b>' + esc(m[0]) + '</b><span>/</span>' + esc(m[1]);
  window.scrollTo({ top: 0 });
  renderCurrent();
}

function renderCurrent() {
  if (!currentPage) return;
  const el = document.getElementById(currentPage);
  try {
    const r = Pages[currentPage].render(el, currentParams || {});
    if (r && r.catch) r.catch(e => { el.innerHTML = errorBoxHtml(e); });
  } catch (e) {
    el.innerHTML = errorBoxHtml(e);
  }
}

/* 共享缓存：当前发布计划、版本列表，跨页跳转时预选 */
const Shared = {
  dashboard: null,
  ganttVersionId: null,     // 资源甘特预选版本
  compareBaselineId: null,  // 方案对比预选
  compareCandidateId: null,
  selectedTaskId: null,     // 任务详情预选
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
      });
      document.querySelectorAll('.menu-parent').forEach(p => {
        p.addEventListener('click', () => p.classList.toggle('collapsed'));
      });
      this.listenersBound = true;
    }
    Auth.renderUserBadge();
    await refreshShared();
    goTo('board');
  },
};

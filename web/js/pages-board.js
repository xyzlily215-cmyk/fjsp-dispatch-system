/* 调度看板（F-01）：GET /dashboard 聚合 + 版本下拉 + 时间窗口筛选 + KPI 跳转 + 异常聚合；
 * 筛选条件持久化在 localStorage，接口超时/失败时保留最近一次成功数据并提供重试。 */

const BOARD_FILTERS_KEY = 'fjsp.board.filters';
let boardCache = null; // { dash, versions } 最近一次成功响应

function loadBoardFilters() {
  try {
    const f = JSON.parse(localStorage.getItem(BOARD_FILTERS_KEY)) || {};
    if (!f.window) f.window = 'SHIFT';
    // 自定义窗口缺起止时间时回退当前班次，避免后端 400
    if (f.window === 'CUSTOM' && (!f.from || !f.to)) f.window = 'SHIFT';
    return f;
  } catch (e) { return { window: 'SHIFT' }; }
}
function saveBoardFilters(f) { localStorage.setItem(BOARD_FILTERS_KEY, JSON.stringify(f)); }

function boardDashboardParams(f) {
  const p = {};
  if (f.planVersionId) p.planVersionId = f.planVersionId;
  if (f.window) p.window = f.window;
  if (f.window === 'CUSTOM') { p.from = f.from; p.to = f.to; }
  return p;
}

const BOARD_EX_SEVERITY = { 3: ['高', 'red'], 2: ['中', 'orange'], 1: ['低', 'gray'] };
const BOARD_EX_TYPE = {
  DELAYED_ORDER: '延期订单', BREAKDOWN: '设备故障',
  INFEASIBLE_TASK: '不可行任务', EXECUTION_DEVIATION: '执行偏差',
};

function boardExceptionDesc(it) {
  switch (it.type) {
    case 'DELAYED_ORDER':
      return `${esc(it.orderCode)} · 交期 ${fmtDateTime(it.dueAt)} · 计划完工 ${fmtDateTime(it.plannedCompletionAt)}`;
    case 'BREAKDOWN':
      return `${esc(it.machineId || '-')} 故障（${esc(it.eventCode)}）· 预计修复 ${fmtDateTime(it.repairEndAt)}`;
    case 'INFEASIBLE_TASK':
      return `${esc(it.taskCode)} ${esc(it.mode || '')} 无可行解${it.errorMessage ? ' · ' + esc(it.errorMessage) : ''}`;
    case 'EXECUTION_DEVIATION':
      return `工序 ${esc(it.operationId)} · ${it.status === 'COMPLETED' ? '完工' : '开工'}偏差 ${it.deviationMinutes} 分钟`;
    default:
      return '';
  }
}

function fmtElapsedMs(ms) {
  if (ms === null || ms === undefined) return '-';
  return ms >= 60000 ? (Math.round(ms / 6000) / 10) + ' min' : (Math.round(ms / 100) / 10) + ' s';
}

registerPage('board', ['工作台', '调度看板'], async (el) => {
  el.innerHTML = loadingHtml('正在加载看板数据…');
  const filters = loadBoardFilters();
  let dash, versions, loadError = null;
  try {
    [dash, versions] = await Promise.all([
      Api.dashboard(boardDashboardParams(filters)),
      Api.planVersions()]);
    // 指定版本时 Shared 保留全局"当前发布计划"语义，避免其他页面误读选中版本
    if (!filters.planVersionId) Shared.dashboard = dash;
    boardCache = { dash, versions };
  } catch (e) {
    loadError = e;
    if (boardCache) {
      // 超时/失败：保留最近一次成功数据
      dash = boardCache.dash;
      versions = boardCache.versions;
    } else {
      el.innerHTML = `
        <div class="page-header"><div><h1>调度看板</h1><p>当前发布计划的生产运行概览</p></div></div>
        <section class="card"><div class="section-pad">
          ${errorBoxHtml(e, '看板数据加载失败')}
          <button class="btn primary" id="boardRetry">重试</button>
        </div></section>`;
      document.getElementById('boardRetry').onclick = () => renderCurrent();
      return;
    }
  }

  const plan = dash.currentPlan;
  const kpi = plan && plan.kpi || {};
  const pendingReview = versions.filter(v => v.status === 'REVIEW_PENDING').length;
  const downMachines = dash.machines.filter(m => m.status !== 'ACTIVE').length;
  const breakdowns = (dash.exceptions && dash.exceptions.breakdowns) || [];
  const exItems = (dash.exceptions && dash.exceptions.items) || [];
  const utils = kpi.utilizationByMachine ? Object.values(kpi.utilizationByMachine) : [];
  const avgUtil = utils.length ? utils.reduce((a, b) => a + b, 0) / utils.length : null;

  // 版本下拉：展示发布过的版本（已发布/执行中/已替代/已关闭），默认当前发布计划
  const selectableStatuses = ['PUBLISHED', 'EXECUTING', 'SUPERSEDED', 'CLOSED'];
  const selectable = versions.filter(v => selectableStatuses.includes(v.status));
  const selectedVersionId = filters.planVersionId || '';
  const versionOptions = ['<option value="">当前发布计划（自动）</option>']
    .concat(selectable.map(v => `<option value="${esc(v.id)}" ${v.id === selectedVersionId ? 'selected' : ''}>${esc(v.versionCode)} · ${esc((STATUS_TAGS[v.status] || [])[1] || v.status)} · ${fmtDateTime(v.publishedAt)}</option>`));
  // 指定的版本不在可发布列表（如历史草稿）时仍回显，避免下拉丢值
  if (selectedVersionId && !selectable.some(v => v.id === selectedVersionId) && plan) {
    versionOptions.push(`<option value="${esc(plan.id)}" selected>${esc(plan.versionCode)} · ${esc((STATUS_TAGS[plan.status] || [])[1] || plan.status)}</option>`);
  }

  const win = dash.timeWindow || {};
  const windowLabel = { SHIFT: '当前班次', LAST_24H: '最近 24 小时', CUSTOM: '自定义' }[win.window] || '全部';

  const kpiCard = (jump, label, value, unit, bar, sub) => `
    <article class="card kpi" data-jump="${jump}" title="点击查看详情"><div class="kpi-label">${label}</div>
      <div class="kpi-value">${value}<span class="kpi-unit">${unit || ''}</span></div>
      <div class="trend" style="color:#909399">${sub || ''}</div><i class="kpi-bar ${bar}"></i></article>`;

  const eventRow = (ev) => `
    <div class="event-row">
      <div class="event-time">${fmtTime(ev.occurredAt)}</div>
      <div><div class="event-name">${esc(ev.eventCode)} ${ev.eventType === 'BREAKDOWN' ? '设备故障' : '新订单'}${ev.machineId ? ' · ' + esc(ev.machineId) : ''}${ev.subType ? ' · ' + esc(impactText(ev.subType) === ev.subType ? (ev.subType === 'URGENT_INSERT' ? '紧急插单' : '常规追加') : impactText(ev.subType)) : ''}${ev.impactCount ? ' · 影响 ' + ev.impactCount + ' 工序' : ''}</div>
        <div class="event-desc">${esc(ev.status || '')}</div></div>
      ${statusTag(ev.status)}
    </div>`;

  const taskRow = (t) => {
    const progress = t.progress === null || t.progress === undefined ? 0 : t.progress;
    const active = t.status === 'RUNNING' || t.status === 'PENDING' || t.status === 'RETRY_WAIT';
    return `
    <div class="task-row clickable" data-task="${esc(t.taskId)}">
      <div style="min-width:0"><b>${esc(t.taskCode)}</b> <span class="muted">${esc(t.mode || '')}</span>
        <div class="task-meta">${fmtDateTime(t.createdAt)} · 耗时 ${fmtElapsedMs(t.elapsedMs)}</div>
        ${active ? `<div style="margin-top:4px;height:4px;border-radius:2px;background:#ebeef5"><div style="height:4px;border-radius:2px;background:#409eff;width:${Math.min(100, progress)}%"></div></div>` : ''}</div>
      ${statusTag(t.status)}
      <div class="task-actions">${active ? progress + '%' : '查看详情'}</div>
    </div>`;
  };

  const exceptionRow = (it, idx) => {
    const [sevText, sevColor] = BOARD_EX_SEVERITY[it.severity] || ['-', 'gray'];
    return `
    <div class="alert clickable" data-ex="${idx}" style="cursor:pointer"><span class="severity">!</span>
      <div><div class="alert-name">${tag(sevText + ' · ' + (BOARD_EX_TYPE[it.type] || it.type), sevColor)}</div>
        <div class="alert-desc">${boardExceptionDesc(it)} · ${fmtDateTime(it.at)}</div></div>
      ${tag('去处理', 'blue')}
    </div>`;
  };

  el.innerHTML = `
    <div class="page-header">
      <div><h1>调度看板</h1><p>生产运行概览（GET /dashboard · 时间窗口：${esc(windowLabel)}${win.from ? ' ' + fmtTime(win.from) + ' ~ ' + fmtTime(win.to) : ''}）</p></div>
      <div class="buttons">
        <select class="field" id="boardVersion" style="width:auto" title="计划版本">${versionOptions.join('')}</select>
        <select class="field" id="boardWindow" style="width:auto" title="时间窗口">
          <option value="SHIFT" ${filters.window === 'SHIFT' ? 'selected' : ''}>当前班次</option>
          <option value="LAST_24H" ${filters.window === 'LAST_24H' ? 'selected' : ''}>最近 24 小时</option>
          <option value="CUSTOM" ${filters.window === 'CUSTOM' ? 'selected' : ''}>自定义</option>
        </select>
        <span id="boardCustomRange" style="display:${filters.window === 'CUSTOM' ? 'inline-flex' : 'none'};gap:6px;align-items:center">
          <input type="datetime-local" class="field" id="boardFrom" style="width:auto" value="${isoToLocalInput(filters.from)}">
          <span class="muted">至</span>
          <input type="datetime-local" class="field" id="boardTo" style="width:auto" value="${isoToLocalInput(filters.to)}">
          <button class="btn small" id="boardApplyRange">应用</button>
        </span>
        <button class="btn" id="boardRefresh">&#8635; 刷新</button>
        <button class="btn" id="boardReset" data-roles="ADMIN">重置演示数据</button>
        <button class="btn primary" onclick="goTo('baseline')">+ 创建基线排程</button>
      </div>
    </div>
    ${loadError ? `<div class="error-box" style="margin-bottom:14px"><b>看板数据刷新失败，以下为最近一次成功数据</b>${esc(errMsg(loadError))}
      <div style="margin-top:8px"><button class="btn small" id="boardRetry">重试</button></div></div>` : ''}
    ${!plan ? `
      <section class="card"><div class="empty-screen">
        <div class="empty-symbol">&#9634;</div>
        <h3>暂无当前发布计划</h3>
        <p>还没有已发布的计划版本。请先创建基线排程，求解成功后提交审核并发布。</p>
        <button class="btn primary" onclick="goTo('baseline')">去创建基线排程</button>
      </div></section>` : `
    <div class="kpis">
      ${kpiCard('cmax', '总完工时间 C_max', fmtMinutes(kpi.cMaxMinutes), '', 'b-blue', `计划版本 ${esc(plan.versionCode)}`)}
      ${kpiCard('tardiness', '加权拖期', fmtMinutes(kpi.weightedTardinessMinutes), '', 'b-orange', `延期订单 ${kpi.nTardy ?? '-'} 单`)}
      ${kpiCard('delayed', '延期订单数', kpi.nTardy ?? '-', '单', 'b-red', `共 ${dash.orderStats.total} 单`)}
      ${kpiCard('utilization', '平均设备利用率', avgUtil === null ? '-' : fmtPct(avgUtil), '', 'b-green', `负荷不均衡度 ${kpi.loadImbalance ?? '-'}`)}
      ${kpiCard('review', '待审核方案', pendingReview, '个', 'b-purple', '等待审核发布')}
      ${kpiCard('machinesDown', '故障/异常设备', downMachines || breakdowns.length, '台', 'b-gray', `${breakdowns.length} 起未消化故障`)}
    </div>`}
    <div class="dash-grid">
      <section class="card">
        <div class="card-title">最近事件<a onclick="goTo('insert')">登记事件</a></div>
        <div class="card-body" style="max-height:430px;overflow:auto">${dash.recentEvents.length ? dash.recentEvents.map(eventRow).join('') : '<div class="empty-screen" style="padding:30px">时间窗口内暂无事件</div>'}</div>
      </section>
      <section class="card">
        <div class="card-title">算法任务<a onclick="goTo('tasks')">全部任务</a></div>
        <div class="card-body" style="max-height:430px;overflow:auto">${dash.recentTasks.length ? dash.recentTasks.map(taskRow).join('') : '<div class="empty-screen" style="padding:30px">暂无任务</div>'}</div>
      </section>
    </div>
    <section class="card warning-card">
      <div class="card-title">异常列表（按严重级别）</div>
      <div class="warning-list" style="max-height:430px;overflow:auto">${exItems.length ? exItems.map(exceptionRow).join('') : '<div class="empty-screen" style="padding:30px">时间窗口内无异常</div>'}</div>
    </section>
  `;

  // KPI 卡片跳转：C_max/加权拖期 → 资源甘特；延期订单 → 订单甘特；利用率/故障设备 → 设备页；待审核 → 审核页
  el.querySelectorAll('.kpi[data-jump]').forEach(card => {
    card.onclick = () => {
      const jump = card.dataset.jump;
      if (jump === 'cmax' || jump === 'tardiness') {
        Shared.ganttVersionId = plan.id; Shared.ganttView = 'resource'; goTo('resource-gantt');
      } else if (jump === 'delayed') {
        Shared.ganttVersionId = plan.id; Shared.ganttView = 'order'; goTo('resource-gantt');
      } else if (jump === 'utilization' || jump === 'machinesDown') {
        goTo('machines');
      } else if (jump === 'review') {
        goTo('review');
      }
    };
  });

  // 异常条目跳转到对应处理页
  el.querySelectorAll('[data-ex]').forEach(row => {
    row.onclick = () => {
      const it = exItems[Number(row.dataset.ex)];
      if (!it) return;
      if (it.type === 'DELAYED_ORDER') goTo('orders');
      else if (it.type === 'BREAKDOWN') goTo('breakdown');
      else if (it.type === 'INFEASIBLE_TASK') { Shared.selectedTaskId = it.taskId; goTo('tasks'); }
      else if (it.type === 'EXECUTION_DEVIATION') goTo('execution');
    };
  });

  // 算法任务跳任务详情
  el.querySelectorAll('.task-row[data-task]').forEach(row => {
    row.onclick = () => { Shared.selectedTaskId = row.dataset.task; goTo('tasks'); };
  });

  // 筛选条件：变更即持久化并刷新
  document.getElementById('boardVersion').onchange = (ev) => {
    filters.planVersionId = ev.target.value || undefined;
    saveBoardFilters(filters);
    renderCurrent();
  };
  document.getElementById('boardWindow').onchange = (ev) => {
    const w = ev.target.value;
    document.getElementById('boardCustomRange').style.display = w === 'CUSTOM' ? 'inline-flex' : 'none';
    if (w !== 'CUSTOM') {
      filters.window = w;
      saveBoardFilters(filters);
      renderCurrent();
    }
  };
  document.getElementById('boardApplyRange').onclick = () => {
    const from = localInputToIso(document.getElementById('boardFrom').value);
    const to = localInputToIso(document.getElementById('boardTo').value);
    if (!from || !to) { toast('请填写自定义窗口的起止时间', 'error'); return; }
    if (new Date(from) >= new Date(to)) { toast('窗口起点必须早于终点', 'error'); return; }
    filters.window = 'CUSTOM'; filters.from = from; filters.to = to;
    saveBoardFilters(filters);
    renderCurrent();
  };

  const retry = document.getElementById('boardRetry');
  if (retry) retry.onclick = () => renderCurrent();

  document.getElementById('boardRefresh').onclick = async () => {
    renderCurrent();
    if (filters.planVersionId) await refreshShared();
    toast('看板已刷新');
  };
  document.getElementById('boardReset').onclick = async () => {
    if (!confirm('确定重置演示数据？所有版本、任务、事件将被清空。')) return;
    try {
      const r = await Api.demoReset();
      toast(`演示数据已重置：${r.seed.orders} 订单 / ${r.seed.machines} 设备`);
      await refreshShared();
      renderCurrent();
    } catch (e) { toastErr(e, '重置失败'); }
  };
});

/* 调度看板：GET /dashboard 聚合 + 待审核数（/plan-versions） */
registerPage('board', ['工作台', '调度看板'], async (el) => {
  el.innerHTML = loadingHtml('正在加载看板数据…');
  let dash, versions;
  try {
    [dash, versions] = await Promise.all([Api.dashboard(), Api.planVersions()]);
    Shared.dashboard = dash;
  } catch (e) {
    el.innerHTML = errorBoxHtml(e, '看板数据加载失败');
    return;
  }
  const plan = dash.currentPlan;
  const kpi = plan && plan.kpi || {};
  const pendingReview = versions.filter(v => v.status === 'REVIEW_PENDING').length;
  const downMachines = dash.machines.filter(m => m.status !== 'ACTIVE').length;
  const breakdowns = (dash.exceptions && dash.exceptions.breakdowns) || [];
  const delayed = (dash.exceptions && dash.exceptions.delayedOrders) || [];
  const utils = kpi.utilizationByMachine ? Object.values(kpi.utilizationByMachine) : [];
  const avgUtil = utils.length ? utils.reduce((a, b) => a + b, 0) / utils.length : null;

  const kpiCard = (label, value, unit, bar, sub) => `
    <article class="card kpi"><div class="kpi-label">${label}</div>
      <div class="kpi-value">${value}<span class="kpi-unit">${unit || ''}</span></div>
      <div class="trend" style="color:#909399">${sub || ''}</div><i class="kpi-bar ${bar}"></i></article>`;

  const eventRow = (ev) => `
    <div class="event-row">
      <div class="event-time">${fmtTime(ev.occurredAt)}</div>
      <div><div class="event-name">${esc(ev.eventCode)} ${ev.eventType === 'BREAKDOWN' ? '设备故障' : '新订单'}${ev.machineId ? ' · ' + esc(ev.machineId) : ''}${ev.subType ? ' · ' + esc(impactText(ev.subType) === ev.subType ? (ev.subType === 'URGENT_INSERT' ? '紧急插单' : '常规追加') : impactText(ev.subType)) : ''}</div>
        <div class="event-desc">${esc(ev.status || '')}</div></div>
      ${statusTag(ev.status)}
    </div>`;

  const taskRow = (t) => `
    <div class="task-row clickable" onclick="Shared.selectedTaskId='${esc(t.taskId)}';goTo('tasks')">
      <div><b>${esc(t.taskCode)}</b> <span class="muted">${esc(t.mode || '')}</span>
        <div class="task-meta">${fmtDateTime(t.createdAt)}</div></div>
      ${statusTag(t.status)}
      <div class="task-actions">查看详情</div>
    </div>`;

  el.innerHTML = `
    <div class="page-header">
      <div><h1>调度看板</h1><p>当前发布计划的生产运行概览（数据来自 GET /dashboard）</p></div>
      <div class="buttons">
        <button class="btn" id="boardRefresh">&#8635; 刷新</button>
        <button class="btn" id="boardReset" data-roles="ADMIN">重置演示数据</button>
        <button class="btn primary" onclick="goTo('baseline')">+ 创建基线排程</button>
      </div>
    </div>
    ${!plan ? `
      <section class="card"><div class="empty-screen">
        <div class="empty-symbol">&#9634;</div>
        <h3>暂无当前发布计划</h3>
        <p>还没有已发布的计划版本。请先创建基线排程，求解成功后提交审核并发布。</p>
        <button class="btn primary" onclick="goTo('baseline')">去创建基线排程</button>
      </div></section>` : `
    <div class="kpis">
      ${kpiCard('总完工时间 C_max', fmtMinutes(kpi.cMaxMinutes), '', 'b-blue', `计划版本 ${esc(plan.versionCode)}`)}
      ${kpiCard('加权拖期', fmtMinutes(kpi.weightedTardinessMinutes), '', 'b-orange', `延期订单 ${kpi.nTardy ?? '-'} 单`)}
      ${kpiCard('延期订单数', kpi.nTardy ?? '-', '单', 'b-red', `共 ${dash.orderStats.total} 单`)}
      ${kpiCard('平均设备利用率', avgUtil === null ? '-' : fmtPct(avgUtil), '', 'b-green', `负荷不均衡度 ${kpi.loadImbalance ?? '-'}`)}
      ${kpiCard('待审核方案', pendingReview, '个', 'b-purple', '等待审核发布')}
      ${kpiCard('故障/异常设备', downMachines || breakdowns.length, '台', 'b-gray', `${breakdowns.length} 起未消化故障`)}
    </div>
    <div class="dash-grid">
      <section class="card">
        <div class="card-title">最近事件<a onclick="goTo('insert')">登记事件</a></div>
        <div class="card-body">${dash.recentEvents.length ? dash.recentEvents.map(eventRow).join('') : '<div class="empty-screen" style="padding:30px">暂无事件</div>'}</div>
      </section>
      <section class="card">
        <div class="card-title">算法任务<a onclick="goTo('tasks')">全部任务</a></div>
        <div class="card-body">${dash.recentTasks.length ? dash.recentTasks.map(taskRow).join('') : '<div class="empty-screen" style="padding:30px">暂无任务</div>'}</div>
      </section>
    </div>
    <div class="dash-grid">
      <section class="card warning-card">
        <div class="card-title">异常 · 延期订单<a onclick="goTo('orders')">订单管理</a></div>
        <div class="warning-list">${delayed.length ? delayed.slice(0, 8).map(o => `
          <div class="alert"><span class="severity">!</span>
            <div><div class="alert-name">${esc(o.orderCode)}</div>
              <div class="alert-desc">交期 ${fmtDateTime(o.dueAt)} · 计划完工 ${fmtDateTime(o.plannedCompletionAt)}</div></div>
            ${tag('延期', 'red')}
          </div>`).join('') : '<div class="empty-screen" style="padding:30px">无延期订单</div>'}</div>
      </section>
      <section class="card warning-card">
        <div class="card-title">异常 · 设备故障<a onclick="goTo('breakdown')">故障管理</a></div>
        <div class="warning-list">${breakdowns.length ? breakdowns.map(b => `
          <div class="alert"><span class="severity">&#9888;</span>
            <div><div class="alert-name">${esc(b.machineId)} 故障（${esc(b.eventCode)}）</div>
              <div class="alert-desc">${fmtDateTime(b.occurredAt)} 发生 · 预计修复 ${fmtDateTime(b.repairEndAt)}</div></div>
            ${tag('故障', 'red')}
          </div>`).join('') : '<div class="empty-screen" style="padding:30px">当前无设备故障</div>'}</div>
      </section>
    </div>`}
  `;

  document.getElementById('boardRefresh').onclick = async () => { await refreshShared(); renderCurrent(); toast('看板已刷新'); };
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

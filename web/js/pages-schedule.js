/* 基线排程 + 调度任务 */

/* ---------------- 基线排程 ---------------- */
registerPage('baseline', ['计划调度', '基线排程'], async (el) => {
  el.innerHTML = loadingHtml('正在加载订单…');
  let orders;
  try { orders = await Api.orders(); }
  catch (e) { el.innerHTML = errorBoxHtml(e, '订单加载失败'); return; }

  el.innerHTML = `
    <div class="page-header">
      <div><h1>基线排程</h1><p>选择待排订单并配置算法参数，创建 BASELINE 求解任务</p></div>
    </div>
    <div class="grid-2" style="grid-template-columns:1.5fr 1fr;align-items:start">
      <section class="card table-card">
        <div class="toolbar"><div class="filters"><b>待排订单</b><span class="muted">勾选参与本次排程的订单（默认全选）</span></div>
          <div class="buttons"><button class="btn small" id="blAll">全选</button><button class="btn small" id="blNone">清空</button></div></div>
        <div class="table-wrap" style="max-height:560px"><table class="data-table">
          <thead><tr><th class="checkbox-cell"></th><th>订单号</th><th>产品族</th><th>数量</th><th>优先级</th><th>交期</th><th>状态</th><th>工序数</th></tr></thead>
          <tbody>${orders.map(o => `
            <tr><td class="checkbox-cell"><input type="checkbox" class="bl-check" value="${esc(o.orderId)}" checked></td>
              <td>${esc(o.orderCode)}</td><td>${esc(o.productFamily)}</td><td>${o.quantity}</td><td>${o.priority}</td>
              <td>${fmtDateTime(o.dueAt)}</td><td>${statusTag(o.status)}</td><td>${(o.operations || []).length}</td></tr>`).join('')}
          </tbody></table></div>
      </section>
      <section class="card"><div class="section-pad">
        <h3 style="margin:0 0 14px;font-size:15px">排程参数</h3>
        <div class="form-row"><label>仿真起点</label><input type="datetime-local" class="field" id="blSimStart"><span class="muted" style="font-size:12px">留空 = 默认（seed 基准，RELATIVE 模式为当前时间）</span></div>
        <div class="form-row"><label>C_max 权重</label><input type="number" class="field" id="blWm" step="0.1" min="0" value="0.4"></div>
        <div class="form-row"><label>拖期权重</label><input type="number" class="field" id="blWt" step="0.1" min="0" value="0.4"></div>
        <div class="form-row"><label>均衡权重</label><input type="number" class="field" id="blWl" step="0.1" min="0" value="0.2"></div>
        <div class="form-row"><label>种群规模</label><input type="number" class="field" id="blPop" min="2" value="40"></div>
        <div class="form-row"><label>迭代代数</label><input type="number" class="field" id="blGen" min="1" value="60"></div>
        <div class="form-row"><label>随机种子</label><input type="number" class="field" id="blSeed" value="42"></div>
        <div class="form-row"><label>时间上限(秒)</label><input type="number" class="field" id="blLimit" min="1" max="600" value="30"></div>
        <div id="blErr"></div>
        <button class="btn primary" style="width:100%;height:36px" id="blSubmit" data-roles="DISPATCHER,ADMIN">创建基线排程任务</button>
        <p class="muted" style="margin-top:10px">提交后 POST /schedule-tasks（mode=BASELINE），自动跳转到调度任务页跟踪求解进度。</p>
      </div></section>
    </div>`;

  document.getElementById('blAll').onclick = () => document.querySelectorAll('.bl-check').forEach(c => c.checked = true);
  document.getElementById('blNone').onclick = () => document.querySelectorAll('.bl-check').forEach(c => c.checked = false);
  document.getElementById('blSubmit').onclick = async () => {
    const orderIds = [...document.querySelectorAll('.bl-check:checked')].map(c => c.value);
    const errEl = document.getElementById('blErr');
    errEl.innerHTML = '';
    if (!orderIds.length) { errEl.innerHTML = '<div class="error-box">请至少勾选一个订单</div>'; return; }
    const simStart = localInputToIso(document.getElementById('blSimStart').value);
    const payload = {
      mode: 'BASELINE',
      orderIds,
      objectiveWeights: {
        makespan: parseFloat(document.getElementById('blWm').value) || 0,
        weightedTardiness: parseFloat(document.getElementById('blWt').value) || 0,
        loadImbalance: parseFloat(document.getElementById('blWl').value) || 0,
      },
      algorithm: {
        populationSize: parseInt(document.getElementById('blPop').value, 10),
        generations: parseInt(document.getElementById('blGen').value, 10),
        randomSeed: parseInt(document.getElementById('blSeed').value, 10),
        timeLimitSeconds: parseInt(document.getElementById('blLimit').value, 10),
      },
    };
    if (simStart) payload.simulationStartAt = simStart;
    const btn = document.getElementById('blSubmit');
    btn.disabled = true; btn.textContent = '创建中…';
    try {
      const r = await Api.createTask(payload);
      toast(`任务 ${r.taskCode} 已创建`);
      Shared.selectedTaskId = r.taskId;
      goTo('tasks');
    } catch (e) {
      errEl.innerHTML = errorBoxHtml(e, '创建任务失败');
      btn.disabled = false; btn.textContent = '创建基线排程任务';
    }
  };
});

/* ---------------- 调度任务 ---------------- */
let taskPollTimer = null;

registerPage('tasks', ['计划调度', '调度任务'], async (el) => {
  if (taskPollTimer) { clearInterval(taskPollTimer); taskPollTimer = null; }
  el.innerHTML = loadingHtml('正在加载任务列表…');
  let tasks;
  try { tasks = await Api.tasks(); }
  catch (e) { el.innerHTML = errorBoxHtml(e, '任务列表加载失败'); return; }

  if (!tasks.length) {
    el.innerHTML = `<div class="page-header"><div><h1>调度任务</h1><p>算法求解任务的进度与结果</p></div></div>
      <section class="card"><div class="empty-screen"><div class="empty-symbol">&#9634;</div>
      <h3>暂无调度任务</h3><p>从基线排程或事件重调度创建任务。</p>
      <button class="btn primary" onclick="goTo('baseline')">去创建基线排程</button></div></section>`;
    return;
  }

  let selectedId = Shared.selectedTaskId && tasks.some(t => t.taskId === Shared.selectedTaskId)
    ? Shared.selectedTaskId : tasks[0].taskId;

  el.innerHTML = `
    <div class="page-header"><div><h1>调度任务</h1><p>算法求解任务的进度与结果，进行中的任务每 3 秒自动刷新</p></div>
      <div class="buttons"><button class="btn" id="taskRefresh">&#8635; 刷新</button>
      <button class="btn primary" onclick="goTo('baseline')">+ 基线排程</button></div></div>
    <div class="task-center">
      <section class="card task-queue">
        <div class="task-queue-head"><h2>任务队列</h2><p>${tasks.length} 个任务</p></div>
        <div class="task-queue-list">${tasks.map(t => `
          <button class="task-queue-item ${t.taskId === selectedId ? 'active' : ''}" data-task="${esc(t.taskId)}">
            <b>${esc(t.taskCode)}</b>${statusTag(t.status)}
            <span>${esc(t.mode)} · ${fmtDateTime(t.createdAt)}</span>
          </button>`).join('')}</div>
      </section>
      <section class="card task-detail" id="taskDetail">${loadingHtml('加载任务详情…')}</section>
    </div>`;

  document.getElementById('taskRefresh').onclick = () => renderCurrent();
  el.querySelectorAll('.task-queue-item').forEach(b => {
    b.onclick = () => { Shared.selectedTaskId = b.dataset.task; renderCurrent(); };
  });

  const detailEl = document.getElementById('taskDetail');
  const loadDetail = async () => {
    let t;
    try { t = await Api.task(selectedId); }
    catch (e) { detailEl.innerHTML = errorBoxHtml(e, '任务详情加载失败'); return null; }
    renderTaskDetail(detailEl, t);
    return t;
  };

  const t = await loadDetail();
  if (t && (t.status === 'PENDING' || t.status === 'RUNNING')) {
    taskPollTimer = setInterval(async () => {
      if (currentPage !== 'tasks') { clearInterval(taskPollTimer); taskPollTimer = null; return; }
      const nt = await loadDetail();
      if (nt && nt.status !== 'PENDING' && nt.status !== 'RUNNING') {
        clearInterval(taskPollTimer); taskPollTimer = null;
        toast(`任务 ${nt.taskCode} 求解结束：${(STATUS_TAGS[nt.status] || [])[1] || nt.status}`,
          nt.status === 'SUCCESS' ? 'success' : 'info');
      }
    }, 3000);
  }
});

function renderTaskDetail(detailEl, t) {
  const terminal = ['SUCCESS', 'INFEASIBLE', 'TIME_LIMIT', 'FAILED'].includes(t.status);
  const kpi = t.kpi;
  const conflicts = t.conflicts || [];
  detailEl.innerHTML = `
    <div class="task-detail-head">
      <div><h2>${esc(t.taskCode)}</h2><p>${statusTag(t.mode)} 创建于 ${fmtDateTime(t.createdAt)}</p></div>
      ${statusTag(t.status)}
    </div>
    <div class="task-progress-box">
      <div class="task-progress-main"><b>${t.progress ?? 0}%</b><span>求解进度${terminal ? '（已结束）' : '（每 3 秒刷新）'}</span>
        <div class="progress"><b style="width:${t.progress ?? 0}%"></b></div></div>
      <div class="task-progress-metric"><span>结果状态</span><b>${esc(t.resultStatus || '-')}</b></div>
      <div class="task-progress-metric"><span>算法版本</span><b>${esc(t.algorithmVersion || '-')}</b></div>
      <div class="task-progress-metric"><span>耗时</span><b>${t.elapsedMs != null ? (t.elapsedMs / 1000).toFixed(1) + 's' : '-'}</b></div>
    </div>
    <div class="section-pad">
      <dl class="detail-list">
        <dt>任务 ID</dt><dd>${esc(t.taskId)}</dd>
        <dt>随机种子</dt><dd>${t.randomSeed ?? '-'}</dd>
        <dt>输入快照</dt><dd>${esc((t.snapshotHash || '-').slice(0, 24))}…</dd>
        ${t.oldPlanVersionId ? `<dt>基于版本</dt><dd>${esc(t.oldPlanVersionId)}</dd>` : ''}
        ${t.eventId ? `<dt>关联事件</dt><dd>${esc(t.eventId)}</dd>` : ''}
        <dt>开始时间</dt><dd>${fmtDateTime(t.startedAt)}</dd>
        <dt>结束时间</dt><dd>${fmtDateTime(t.finishedAt)}</dd>
        ${t.planVersionId ? `<dt>产出计划版本</dt><dd>${esc(t.planVersionId)}</dd>` : ''}
      </dl>
      ${t.errorMessage ? `<div class="error-box"><b>错误信息</b>${esc(t.errorMessage)}</div>` : ''}
      ${kpi ? `
      <h3 style="margin:18px 0 10px;font-size:15px">结果 KPI</h3>
      <div class="task-overview-grid">
        <div class="task-overview-block"><span>总完工时间 C_max</span><b>${fmtMinutes(kpi.cMaxMinutes)}</b></div>
        <div class="task-overview-block"><span>加权拖期</span><b>${fmtMinutes(kpi.weightedTardinessMinutes)}</b></div>
        <div class="task-overview-block"><span>延期订单数</span><b>${kpi.nTardy ?? '-'}</b></div>
        <div class="task-overview-block"><span>负荷不均衡度</span><b>${kpi.loadImbalance ?? '-'}</b></div>
        <div class="task-overview-block"><span>计划扰动 Δ_plan</span><b>${kpi.deltaPlan ? kpi.deltaPlan.deltaPlan.toFixed(3) : '-'}</b></div>
        <div class="task-overview-block"><span>可行解</span><b>${t.feasibleSolution ? '是' : '否'}</b></div>
      </div>` : ''}
      <h3 style="margin:18px 0 10px;font-size:15px">冲突明细</h3>
      ${conflicts.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>类型</th><th>说明</th></tr></thead>
        <tbody>${conflicts.map(c => `<tr><td>${tag(esc(c.type || c.code || '冲突'), 'red')}</td><td>${esc(c.message || JSON.stringify(c))}</td></tr>`).join('')}</tbody></table></div>`
      : '<p class="muted">无冲突</p>'}
      <div class="buttons" style="margin-top:18px">
        ${t.status === 'SUCCESS' && t.planVersionId ? `
          <button class="btn primary" id="tdGantt">查看甘特</button>
          <button class="btn" id="tdSubmit" data-roles="DISPATCHER,ADMIN">提交审核</button>` : ''}
        ${t.status === 'SUCCESS' && t.oldPlanVersionId && t.planVersionId ? '<button class="btn" id="tdCompare">与旧版对比</button>' : ''}
      </div>
    </div>`;

  const g = document.getElementById('tdGantt');
  if (g) g.onclick = () => { Shared.ganttVersionId = t.planVersionId; goTo('resource-gantt'); };
  const sbtn = document.getElementById('tdSubmit');
  if (sbtn) sbtn.onclick = async () => {
    try {
      const pv = await Api.planVersion(t.planVersionId);
      await Api.submitReview(t.planVersionId, pv.version);
      toast('已提交审核，可在「待审核方案」中处理');
      goTo('review');
    } catch (e) { toastErr(e, '提交审核失败'); }
  };
  const c = document.getElementById('tdCompare');
  if (c) c.onclick = () => {
    Shared.compareBaselineId = t.oldPlanVersionId; Shared.compareCandidateId = t.planVersionId;
    goTo('compare');
  };
}

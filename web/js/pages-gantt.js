/* 资源甘特：版本下拉 -> GET /plan-versions/{id}，按设备行渲染 */
registerPage('resource-gantt', ['结果分析', '资源甘特'], async (el) => {
  el.innerHTML = loadingHtml('正在加载计划版本…');
  let versions, machines, orders, dash;
  try {
    [versions, machines, orders, dash] = await Promise.all(
      [Api.planVersions(), Api.machines(), Api.orders(), Api.dashboard()]);
    Shared.dashboard = dash;
  } catch (e) { el.innerHTML = errorBoxHtml(e, '基础数据加载失败'); return; }

  if (!versions.length) {
    el.innerHTML = `
      <div class="page-header"><div><h1>资源甘特</h1><p>按设备查看计划版本的工序排布</p></div></div>
      <section class="card"><div class="empty-screen"><div class="empty-symbol">&#9634;</div>
        <h3>暂无计划版本</h3><p>先创建基线排程生成计划版本。</p>
        <button class="btn primary" onclick="goTo('baseline')">去创建基线排程</button></div></section>`;
    return;
  }

  const currentId = dash.currentPlan && dash.currentPlan.id;
  let selectedId = Shared.ganttVersionId
    || (versions.find(v => v.id === currentId) ? currentId : null)
    || versions[0].id;
  if (!versions.some(v => v.id === selectedId)) selectedId = versions[0].id;

  let plan, opsPage;
  try {
    [plan, opsPage] = await Promise.all([
      Api.planVersion(selectedId), Api.planVersionOperations(selectedId)]);
  }
  catch (e) { el.innerHTML = errorBoxHtml(e, '版本详情加载失败'); return; }

  const familyOf = {};
  orders.forEach(o => { familyOf[o.orderId] = o.productFamily; });
  const FAMILY_COLOR = { '轴类A': 'blue', '盘类B': 'green', '壳体C': 'orange' };
  const colorOf = (opId) => {
    const fam = familyOf[opId.split('-').slice(0, -1).join('-')] || '';
    return FAMILY_COLOR[fam] || 'purple';
  };

  const ops = (opsPage.items || []).slice().sort((a, b) => a.startAt < b.startAt ? -1 : 1);
  const winStart = Math.min(...ops.map(o => Date.parse(o.startAt)));
  const winEnd = Math.max(...ops.map(o => Date.parse(o.endAt)));
  const span = Math.max(winEnd - winStart, 1);

  // 刻度：选一个合适的间隔让 tick 数在 8~16 之间
  const HOUR = 3600e3;
  let tick = 24 * HOUR;
  for (const t of [2, 4, 6, 8, 12, 24]) { if (span / (t * HOUR) <= 14) { tick = t * HOUR; break; } }
  const tickCount = Math.max(2, Math.ceil(span / tick) + 1);
  const pct = (t) => ((t - winStart) / span * 100);
  const tickLabel = (t) => {
    const d = new Date(t);
    const day = new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, month: '2-digit', day: '2-digit' }).format(d);
    const hm = new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
    return tick >= 24 * HOUR ? day : (hm === '00:00' ? day : hm);
  };

  // 故障维修区间（来自看板异常）
  const repairs = ((dash.exceptions && dash.exceptions.breakdowns) || [])
    .map(b => ({ machineId: b.machineId, start: Date.parse(b.occurredAt), end: Date.parse(b.repairEndAt), code: b.eventCode }))
    .filter(r => !isNaN(r.start) && !isNaN(r.end) && r.end > winStart && r.start < winEnd);

  const byMachine = {};
  machines.forEach(m => { byMachine[m.machineId] = []; });
  ops.forEach(o => { (byMachine[o.machineId] = byMachine[o.machineId] || []).push(o); });

  const machineRow = (m) => {
    const list = byMachine[m.machineId] || [];
    const bars = list.map(o => {
      const s = Date.parse(o.startAt), e = Date.parse(o.endAt);
      const setupS = o.setupStartAt ? Date.parse(o.setupStartAt) : s;
      const procS = o.processStartAt ? Date.parse(o.processStartAt) : s;
      const left = pct(Math.max(setupS, winStart));
      const width = Math.max((e - Math.max(setupS, winStart)) / span * 100, 0.35);
      const setupWidth = Math.max((procS - Math.max(setupS, winStart)) / span * 100, 0);
      const cls = ['job', colorOf(o.operationId)];
      if (o.frozen) cls.push('frozen');
      if (o.affected) cls.push('affected');
      const tip = [
        `工序 ${o.operationId}`,
        `设备 ${o.machineId}`,
        `开始 ${fmtDateTime(o.startAt)}  结束 ${fmtDateTime(o.endAt)}`,
        `准备 ${fmtHM(o.setupStartAt)}→${fmtHM(o.processStartAt)}${o.changeoverMinutes ? ` · 换型 ${o.changeoverMinutes}min` : ''}`,
        o.frozen ? '❄ 冻结工序' : '',
        o.affected ? `⚠ 受事件影响${o.reasonCode ? '（' + reasonText(o.reasonCode) + '）' : ''}` : '',
      ].filter(Boolean).join('\n');
      const label = o.operationId.split('-').slice(0, -1).join('-');
      return `<div class="${cls.join(' ')}" style="left:${left}%;width:${width}%" title="${esc(tip)}">${setupWidth > 0.2 ? `<i class="setup" style="width:${setupWidth / width * 100}%"></i>` : ''}${o.frozen ? '❄' : ''}${esc(label)}</div>`;
    }).join('');
    const repairBars = repairs.filter(r => r.machineId === m.machineId).map(r => {
      const left = pct(Math.max(r.start, winStart));
      const width = (Math.min(r.end, winEnd) - Math.max(r.start, winStart)) / span * 100;
      return `<div class="job repair" style="left:${left}%;width:${Math.max(width, 0.5)}%" title="维修区间 ${esc(r.code || '')}\n${fmtDateTime(new Date(r.start).toISOString())} → ${fmtDateTime(new Date(r.end).toISOString())}">维修</div>`;
    }).join('');
    const util = plan.kpi && plan.kpi.utilizationByMachine ? plan.kpi.utilizationByMachine[m.machineId] : null;
    return `<div class="machine-row">
      <div class="machine-label">${esc(m.machineId)} <small class="muted" style="margin-left:6px">${util !== null && util !== undefined ? fmtPct(util, 0) : ''}</small></div>
      <div class="machine-track" style="background:repeating-linear-gradient(90deg,transparent 0,transparent calc(${100 / (tickCount - 1)}% - 1px),#f2f6fc calc(${100 / (tickCount - 1)}% - 1px),#f2f6fc ${100 / (tickCount - 1)}%)">${bars}${repairBars}</div>
    </div>`;
  };

  const ticks = Array.from({ length: tickCount }, (_, i) => `<span>${esc(tickLabel(winStart + i * tick))}</span>`).join('');
  const kpi = plan.kpi || {};
  const families = [...new Set(Object.values(familyOf))];

  el.innerHTML = `
    <div class="page-header">
      <div><h1>资源甘特</h1><p>按设备行渲染计划版本的工序排布，悬停查看工序详情</p></div>
      <div class="buttons">
        ${plan.status === 'DRAFT' ? '<button class="btn" id="ganttSubmit" data-roles="DISPATCHER,ADMIN">提交审核</button>' : ''}
        ${plan.parentId ? '<button class="btn" id="ganttCompare">与父版本对比</button>' : ''}
        <button class="btn" id="ganttRefresh">&#8635; 刷新</button>
      </div>
    </div>
    <section class="card section-card">
      <div class="gantt-header">
        <div class="filters" style="display:flex;gap:10px;align-items:center">
          <span class="filter-label">计划版本</span>
          <select class="field wide" id="ganttVersion">${versions.map(v =>
            `<option value="${esc(v.id)}" ${v.id === selectedId ? 'selected' : ''}>${esc(v.versionCode)} · ${esc(v.status)}${v.id === currentId ? ' · 当前发布' : ''} · ${fmtDateTime(v.createdAt)}</option>`).join('')}
          </select>
          ${statusTag(plan.status)}
        </div>
        <div class="muted">C_max ${fmtMinutes(kpi.cMaxMinutes)} · 加权拖期 ${fmtMinutes(kpi.weightedTardinessMinutes)} · 延期 ${kpi.nTardy ?? '-'} 单 · Δ_plan ${kpi.deltaPlan ? kpi.deltaPlan.deltaPlan.toFixed(3) : '-'}</div>
      </div>
      <div class="gantt-wrap"><div class="gantt">
        <div class="legend">
          ${families.map(f => `<span><i class="dot" style="background:${{ '轴类A': '#409eff', '盘类B': '#67c23a', '壳体C': '#e6a23c' }[f] || '#8a6de9'}"></i>${esc(f)}</span>`).join('')}
          <span><i class="dot" style="background:#f56c6c"></i>维修区间</span>
          <span>❄ 冻结工序</span><span style="color:#f56c6c">红框 = 受事件影响</span>
        </div>
        <div class="gantt-scale" style="grid-template-columns:repeat(${tickCount},1fr)">${ticks}</div>
        ${machines.map(machineRow).join('')}
      </div></div>
    </section>`;

  document.getElementById('ganttVersion').onchange = (ev) => { Shared.ganttVersionId = ev.target.value; renderCurrent(); };
  document.getElementById('ganttRefresh').onclick = () => renderCurrent();
  const submitBtn = document.getElementById('ganttSubmit');
  if (submitBtn) submitBtn.onclick = async () => {
    try { await Api.submitReview(selectedId, plan.version); toast(plan.versionCode + ' 已提交审核'); renderCurrent(); }
    catch (e) { toastErr(e, '提交审核失败'); }
  };
  const cmpBtn = document.getElementById('ganttCompare');
  if (cmpBtn) cmpBtn.onclick = () => {
    Shared.compareBaselineId = plan.parentId; Shared.compareCandidateId = plan.id;
    goTo('compare');
  };
});

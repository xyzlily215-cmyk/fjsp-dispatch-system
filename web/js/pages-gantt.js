/* 甘特图：资源视图（按设备行）/ 订单视图（按订单工艺链）双视图，支持双向联动定位与 CSV 导出 */
/* 产品族颜色：演示三族固定占用前 3 个色（维持原观感），其余族名按 hash 取模取色（跳过前 3 个，避免与演示族撞色） */
const FAMILY_PALETTE = [
  { cls: 'blue', hex: '#409eff' },    // 轴类A
  { cls: 'green', hex: '#67c23a' },   // 盘类B
  { cls: 'orange', hex: '#e6a23c' },  // 壳体C
  { cls: 'purple', hex: '#8a6de9' },
  { cls: 'teal', hex: '#13c2c2' },
  { cls: 'magenta', hex: '#eb2f96' },
  { cls: 'indigo', hex: '#2f54eb' },
  { cls: 'gold', hex: '#d48806' },
  { cls: 'lime', hex: '#7cb305' },
  { cls: 'gray', hex: '#8c8c8c' },
];
const FAMILY_PINNED = { '轴类A': 0, '盘类B': 1, '壳体C': 2 };
function familyColor(fam) {
  if (Object.prototype.hasOwnProperty.call(FAMILY_PINNED, fam)) return FAMILY_PALETTE[FAMILY_PINNED[fam]];
  let h = 0;
  for (let i = 0; i < fam.length; i++) h = (h * 31 + fam.charCodeAt(i)) >>> 0;
  return FAMILY_PALETTE[3 + (h % (FAMILY_PALETTE.length - 3))];
}

registerPage('resource-gantt', ['结果分析', '甘特图'], async (el) => {
  el.innerHTML = loadingHtml('正在加载计划版本…');
  let versions, machines, orders, dash;
  try {
    [versions, machines, orders, dash] = await Promise.all(
      [Api.planVersions(), Api.machines(), Api.orders(), Api.dashboard()]);
    Shared.dashboard = dash;
  } catch (e) { el.innerHTML = errorBoxHtml(e, '基础数据加载失败'); return; }

  if (!versions.length) {
    el.innerHTML = `
      <div class="page-header"><div><h1>甘特图</h1><p>按设备或订单查看计划版本的工序排布</p></div></div>
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

  const view = Shared.ganttView === 'order' ? 'order' : 'resource';
  // 跨视图联动目标：渲染后消费一次即清除
  const focusOp = Shared.ganttFocusOp;
  Shared.ganttFocusOp = null;

  const familyOf = {};
  orders.forEach(o => { familyOf[o.orderId] = o.productFamily; });
  const familyOfOp = (op) => op.productFamily
    || familyOf[op.orderId || op.operationId.split('-').slice(0, -1).join('-')] || '';
  const colorOf = (op) => familyColor(familyOfOp(op)).cls;

  const ops = (opsPage.items || []).slice().sort((a, b) => a.startAt < b.startAt ? -1 : 1);
  const kpi = plan.kpi || {};
  const families = [...new Set(ops.map(familyOfOp).filter(Boolean))];

  const versionSelect = `
    <span class="filter-label">计划版本</span>
    <select class="field wide" id="ganttVersion">${versions.map(v =>
      `<option value="${esc(v.id)}" ${v.id === selectedId ? 'selected' : ''}>${esc(v.versionCode)} · ${esc(v.status)}${v.id === currentId ? ' · 当前发布' : ''} · ${fmtDateTime(v.createdAt)}</option>`).join('')}
    </select>
    ${statusTag(plan.status)}`;

  const headerHtml = `
    <div class="page-header">
      <div><h1>甘特图</h1><p>资源视图按设备行渲染，订单视图按订单工艺链渲染；点击工序条可在两视图间联动定位</p></div>
      <div class="buttons">
        <button class="btn ${view === 'resource' ? 'primary' : ''}" id="ganttViewResource">资源视图</button>
        <button class="btn ${view === 'order' ? 'primary' : ''}" id="ganttViewOrder">订单视图</button>
        <button class="btn" id="ganttExport">导出 CSV</button>
        ${plan.status === 'DRAFT' ? '<button class="btn" id="ganttSubmit" data-roles="DISPATCHER,ADMIN">提交审核</button>' : ''}
        ${plan.parentId ? '<button class="btn" id="ganttCompare">与父版本对比</button>' : ''}
        <button class="btn" id="ganttRefresh">&#8635; 刷新</button>
      </div>
    </div>`;

  if (!ops.length) {
    el.innerHTML = `${headerHtml}
      <section class="card section-card">
        <div class="gantt-header"><div class="filters" style="display:flex;gap:10px;align-items:center">${versionSelect}</div></div>
        <div class="empty-screen"><div class="empty-symbol">&#9634;</div><h3>该版本没有工序明细</h3></div>
      </section>`;
    bindCommon();
    return;
  }

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
  const gridBg = `repeating-linear-gradient(90deg,transparent 0,transparent calc(${100 / (tickCount - 1)}% - 1px),#f2f6fc calc(${100 / (tickCount - 1)}% - 1px),#f2f6fc ${100 / (tickCount - 1)}%)`;
  const ticks = Array.from({ length: tickCount }, (_, i) => `<span>${esc(tickLabel(winStart + i * tick))}</span>`).join('');
  const scaleHtml = `<div class="gantt-scale" style="grid-template-columns:repeat(${tickCount},1fr)">${ticks}</div>`;

  const opTip = (o) => [
    `工序 ${o.operationId}`,
    `设备 ${o.machineId}`,
    `开始 ${fmtDateTime(o.startAt)}  结束 ${fmtDateTime(o.endAt)}`,
    `准备 ${fmtHM(o.setupStartAt)}→${fmtHM(o.processStartAt)}${o.changeoverMinutes ? ` · 换型 ${o.changeoverMinutes}min` : ''}`,
    o.frozen ? '❄ 冻结工序' : '',
    o.affected ? `⚠ 受事件影响${o.reasonCode ? '（' + reasonText(o.reasonCode) + '）' : ''}` : '',
    (o.executionCompleted || o.operationStatus === 'COMPLETED') ? '✓ 已完成' : '',
  ].filter(Boolean).join('\n');

  /* ---------------- 资源视图：按设备行 ---------------- */
  const renderResourceView = () => {
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
        const cls = ['job', colorOf(o)];
        if (o.frozen) cls.push('frozen');
        if (o.affected) cls.push('affected');
        if (o.operationId === focusOp) cls.push('spotlight');
        const label = o.orderCode || o.operationId.split('-').slice(0, -1).join('-');
        return `<div class="${cls.join(' ')}" data-op="${esc(o.operationId)}" style="left:${left}%;width:${width}%" title="${esc(opTip(o))}">${setupWidth > 0.2 ? `<i class="setup" style="width:${setupWidth / width * 100}%"></i>` : ''}${o.frozen ? '❄' : ''}${esc(label)}</div>`;
      }).join('');
      const repairBars = repairs.filter(r => r.machineId === m.machineId).map(r => {
        const left = pct(Math.max(r.start, winStart));
        const width = (Math.min(r.end, winEnd) - Math.max(r.start, winStart)) / span * 100;
        return `<div class="job repair" style="left:${left}%;width:${Math.max(width, 0.5)}%" title="维修区间 ${esc(r.code || '')}\n${fmtDateTime(new Date(r.start).toISOString())} → ${fmtDateTime(new Date(r.end).toISOString())}">维修</div>`;
      }).join('');
      const util = plan.kpi && plan.kpi.utilizationByMachine ? plan.kpi.utilizationByMachine[m.machineId] : null;
      return `<div class="machine-row">
        <div class="machine-label">${esc(m.machineId)} <small class="muted" style="margin-left:6px">${util !== null && util !== undefined ? fmtPct(util, 0) : ''}</small></div>
        <div class="machine-track" style="background:${gridBg}">${bars}${repairBars}</div>
      </div>`;
    };

    return `
      <div class="legend">
        ${families.map(f => `<span><i class="dot" style="background:${familyColor(f).hex}"></i>${esc(f)}</span>`).join('')}
        <span><i class="dot" style="background:#f56c6c"></i>维修区间</span>
        <span>❄ 冻结工序</span><span style="color:#f56c6c">红虚框 = 受事件影响</span>
        <span class="muted">点击工序条 → 订单视图定位</span>
      </div>
      ${scaleHtml}
      ${machines.map(machineRow).join('')}`;
  };

  /* ---------------- 订单视图：按订单工艺链 ---------------- */
  const renderOrderView = () => {
    const groups = {};
    ops.forEach(o => {
      const oid = o.orderId || o.operationId.split('-').slice(0, -1).join('-');
      (groups[oid] = groups[oid] || []).push(o);
    });
    const orderRows = Object.entries(groups).map(([oid, list]) => {
      list.sort((a, b) => ((a.sequenceNo ?? 0) - (b.sequenceNo ?? 0)) || (a.startAt < b.startAt ? -1 : 1));
      const dueAt = list.map(o => o.dueAt).find(Boolean) || null;
      const dueMs = dueAt ? Date.parse(dueAt) : null;
      const endMs = Math.max(...list.map(o => Date.parse(o.endAt)));
      const done = list.filter(o => o.executionCompleted || o.operationStatus === 'COMPLETED').length;
      return {
        oid, ops: list, dueAt, dueMs, endMs, done, total: list.length,
        orderCode: list[0].orderCode || oid,
        family: familyOfOp(list[0]),
        priority: list[0].priority,
        late: dueMs !== null && endMs > dueMs,
      };
    }).sort((a, b) => ((a.dueMs ?? Infinity) - (b.dueMs ?? Infinity)) || a.orderCode.localeCompare(b.orderCode));

    // 关键路径（近似口径）：算法服务未输出真实关键路径，取计划完工时间最晚订单的完整工序链
    const critical = orderRows.length
      ? orderRows.reduce((a, b) => (b.endMs > a.endMs ? b : a)) : null;

    const orderRow = (r) => {
      const isCritical = critical && r.oid === critical.oid;
      const bars = [];
      if (r.ops.length > 1) {
        const s = Date.parse(r.ops[0].startAt);
        const e = Date.parse(r.ops[r.ops.length - 1].endAt);
        bars.push(`<div class="op-link" style="left:${pct(s)}%;width:${Math.max((e - s) / span * 100, 0.3)}%"></div>`);
      }
      r.ops.forEach((o, i) => {
        const s = Date.parse(o.startAt), e = Date.parse(o.endAt);
        const cls = ['job', colorOf(o)];
        if (o.frozen) cls.push('frozen');
        if (o.affected) cls.push('affected');
        if (r.dueMs !== null && e > r.dueMs) cls.push('late');
        if (isCritical) cls.push('critical');
        if (o.operationId === focusOp) cls.push('spotlight');
        const completed = o.executionCompleted || o.operationStatus === 'COMPLETED';
        bars.push(`<div class="${cls.join(' ')}" data-op="${esc(o.operationId)}" style="left:${pct(s)}%;width:${Math.max((e - s) / span * 100, 0.35)}%" title="${esc(opTip(o))}">${o.frozen ? '❄' : ''}${o.sequenceNo ?? i + 1}·${esc(o.machineId)}${completed ? ' ✓' : ''}</div>`);
      });
      if (r.dueMs !== null && r.dueMs >= winStart && r.dueMs <= winEnd) {
        bars.push(`<div class="due-marker" style="left:${pct(r.dueMs)}%" title="交期 ${fmtDateTime(r.dueAt)}"></div>`);
      }
      return `<div class="machine-row order-row${r.late ? ' late-row' : ''}${isCritical ? ' critical-row' : ''}">
        <div class="machine-label order-label"><div>
          <div><b>${esc(r.orderCode)}</b> ${isCritical ? tag('关键路径·近似', 'orange') : ''}${r.late ? tag('拖期', 'red') : ''}</div>
          <div class="muted" style="font-size:11px;margin-top:2px">${esc(r.family)} · 优先级 ${r.priority ?? '-'} · 交期 ${fmtDateTime(r.dueAt)}</div>
          <div style="margin-top:3px"><span class="order-progress" title="完成率 ${r.total ? Math.round(r.done / r.total * 100) : 0}%"><i style="width:${r.total ? r.done / r.total * 100 : 0}%"></i></span><span class="muted" style="font-size:11px">${r.done}/${r.total} 完成</span></div>
        </div></div>
        <div class="machine-track" style="background:${gridBg}">${bars.join('')}</div>
      </div>`;
    };

    return `
      <div class="legend">
        ${families.map(f => `<span><i class="dot" style="background:${familyColor(f).hex}"></i>${esc(f)}</span>`).join('')}
        <span>灰线 = 工艺顺序连线</span><span style="color:#f56c6c">┆ 交期线 / 红实框 = 拖期工序</span>
        <span style="color:#b88230">金框 = 关键路径（近似）</span><span>✓ 已完成</span>
      </div>
      <div class="muted" style="padding:6px 18px 0;font-size:12px">关键路径为近似口径：取计划完工时间最晚订单（${critical ? esc(critical.orderCode) : '-'}）的完整工序链，算法服务未输出真实关键路径。点击工序条 → 资源视图定位。</div>
      ${scaleHtml}
      ${orderRows.map(orderRow).join('')}`;
  };

  el.innerHTML = `${headerHtml}
    <section class="card section-card">
      <div class="gantt-header">
        <div class="filters" style="display:flex;gap:10px;align-items:center">${versionSelect}</div>
        <div class="muted">C_max ${fmtMinutes(kpi.cMaxMinutes)} · 加权拖期 ${fmtMinutes(kpi.weightedTardinessMinutes)} · 延期 ${kpi.nTardy ?? '-'} 单 · Δ_plan ${kpi.deltaPlan ? kpi.deltaPlan.deltaPlan.toFixed(3) : '-'}</div>
      </div>
      <div class="gantt-wrap"><div class="gantt">
        ${view === 'order' ? renderOrderView() : renderResourceView()}
      </div></div>
    </section>`;

  bindCommon();

  // 视图联动：点击工序条切换到另一视图并定位同一工序
  el.querySelectorAll('.job[data-op]').forEach(bar => {
    bar.onclick = () => {
      Shared.ganttView = view === 'order' ? 'resource' : 'order';
      Shared.ganttFocusOp = bar.dataset.op;
      renderCurrent();
    };
  });
  // 联动定位目标：滚动到可视区域（spotlight 样式已在渲染时加上）
  if (focusOp) {
    const target = el.querySelector(`.job[data-op="${CSS.escape(focusOp)}"]`);
    if (target) setTimeout(() => target.scrollIntoView({ block: 'center', inline: 'center' }), 0);
  }

  function bindCommon() {
    document.getElementById('ganttVersion').onchange = (ev) => { Shared.ganttVersionId = ev.target.value; renderCurrent(); };
    document.getElementById('ganttRefresh').onclick = () => renderCurrent();
    document.getElementById('ganttViewResource').onclick = () => { Shared.ganttView = 'resource'; renderCurrent(); };
    document.getElementById('ganttViewOrder').onclick = () => { Shared.ganttView = 'order'; renderCurrent(); };
    document.getElementById('ganttExport').onclick = async () => {
      try { await Api.exportPlanVersion(selectedId); toast(plan.versionCode + ' CSV 已开始下载'); }
      catch (e) { toastErr(e, '导出失败'); }
    };
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
  }
});

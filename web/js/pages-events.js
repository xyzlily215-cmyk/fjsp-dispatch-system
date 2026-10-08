/* 事件管理：订单插单 + 设备故障 */

/* 影响摘要 + 重调度入口（两页共用） */
function renderImpactPanel(container, data, eventDetail) {
  const summary = data.impactSummary || { total: 0, byType: {} };
  const impacts = eventDetail && eventDetail.impacts ? eventDetail.impacts : [];
  const hardLocks = impacts.filter(i => i.lockType === 'HARD' || i.lockType === 'FROZEN').length;
  container.innerHTML = `
    <div class="success-box"><b>事件已登记：${esc(data.eventCode)}</b>事件 ID ${esc(data.eventId)}</div>
    <div class="impact-kpis">
      <div class="impact-kpi ${summary.total ? 'warn' : ''}"><span>影响工序数</span><b>${summary.total ?? 0}</b></div>
      <div class="impact-kpi"><span>硬锁定工序</span><b>${hardLocks}</b></div>
    </div>
    ${Object.keys(summary.byType || {}).length ? `<p class="muted">影响类型：${Object.entries(summary.byType).map(([k, v]) => `${impactText(k)} × ${v}`).join('，')}</p>` : '<p class="muted">当前发布计划内无受影响工序。</p>'}
    ${impacts.length ? `<div class="table-wrap" style="max-height:260px;margin-top:10px"><table class="data-table">
      <thead><tr><th>工序</th><th>影响类型</th><th>锁定</th><th>原因</th></tr></thead>
      <tbody>${impacts.slice(0, 30).map(i => `<tr><td>${esc(i.operationId)}</td>
        <td>${tag(impactText(i.impactType), 'purple')}</td>
        <td>${i.lockType === 'HARD' || i.lockType === 'FROZEN' ? tag('硬锁定', 'red') : tag('可调整', 'gray')}</td>
        <td><span class="muted">${esc(i.impactReason || reasonText(i.reasonCode))}</span></td></tr>`).join('')}</tbody></table></div>` : ''}
    <div class="section-pad" style="margin-top:16px;border:1px dashed #dcdfe6;border-radius:4px;padding:14px">
      <b style="font-size:13px">去重调度</b>
      <p class="muted" style="margin:6px 0 10px">基于当前发布计划，针对该事件创建重调度任务。</p>
      <div class="inline-form">
        <select class="field" id="rsMode">
          <option value="LOCAL_RESCHEDULE">局部重调度（LOCAL）</option>
          <option value="FULL_RESCHEDULE">完全重调度（FULL）</option>
        </select>
        <button class="btn primary" id="rsCreate" data-roles="DISPATCHER,ADMIN">创建重调度任务</button>
      </div>
      <div id="rsErr"></div>
    </div>`;

  document.getElementById('rsCreate').onclick = async () => {
    const errEl = document.getElementById('rsErr');
    errEl.innerHTML = '';
    try {
      const dash = Shared.dashboard && Shared.dashboard.currentPlan ? Shared.dashboard : await Api.dashboard();
      Shared.dashboard = dash;
      if (!dash.currentPlan) { errEl.innerHTML = '<div class="error-box">当前没有已发布的计划版本，无法重调度。请先创建并发布基线。</div>'; return; }
      const r = await Api.createTask({
        mode: document.getElementById('rsMode').value,
        oldPlanVersionId: dash.currentPlan.id,
        eventId: data.eventId,
      });
      toast(`重调度任务 ${r.taskCode} 已创建`);
      Shared.selectedTaskId = r.taskId;
      goTo('tasks');
    } catch (e) {
      errEl.innerHTML = errorBoxHtml(e, '创建重调度任务失败');
    }
  };
}

async function loadEventDetail(eventId) {
  try { return await Api.event(eventId); } catch (e) { return null; }
}

/* ---------------- 订单插单 ---------------- */
registerPage('insert', ['事件管理', '订单插单'], async (el) => {
  el.innerHTML = loadingHtml('正在加载工艺模板…');
  let templates;
  try { templates = await Api.templates(); } catch (e) { el.innerHTML = errorBoxHtml(e, '工艺模板加载失败'); return; }
  const families = [...new Set(templates.map(t => t.productFamily))];
  const nowLocal = isoToLocalInput(new Date().toISOString());

  el.innerHTML = `
    <div class="page-header"><div><h1>订单插单</h1><p>登记新订单事件（POST /events/new-orders），并触发重调度</p></div></div>
    <div class="grid-2" style="grid-template-columns:1fr 1fr;align-items:start">
      <section class="card"><div class="section-pad">
        <h3 style="margin:0 0 14px;font-size:15px">新订单事件</h3>
        <div class="form-row"><label class="required">事件子类</label>
          <select class="field" id="ioSubType"><option value="URGENT_INSERT">紧急插单（URGENT_INSERT）</option><option value="NORMAL_APPEND">常规追加（NORMAL_APPEND）</option></select></div>
        <div class="form-row"><label class="required">订单号</label><input class="field" id="ioCode" value="ORD-NEW-${Date.now() % 100000}"></div>
        <div class="form-row"><label class="required">产品族</label>
          <select class="field" id="ioFamily">${families.map(f => `<option>${esc(f)}</option>`).join('')}</select></div>
        <div class="form-row"><label class="required">数量</label><input type="number" class="field" id="ioQty" min="1" value="20"></div>
        <div class="form-row"><label class="required">优先级</label><input type="number" class="field" id="ioPriority" min="1" max="5" value="1"></div>
        <div class="form-row"><label class="required">到达时间</label><input type="datetime-local" class="field" id="ioArrival" value="${isoToLocalInput(new Date(Date.now() + 24 * 3600e3).toISOString())}"></div>
        <div class="form-row"><label class="required">交期</label><input type="datetime-local" class="field" id="ioDue" value="${isoToLocalInput(new Date(Date.now() + 48 * 3600e3).toISOString())}"></div>
        <div class="form-row"><label class="required">发生时间</label><input type="datetime-local" class="field" id="ioOccurred" value="${isoToLocalInput(new Date(Date.now() + 24 * 3600e3).toISOString())}"></div>
        <div class="form-row"><label>备注</label><textarea class="field" id="ioNote" placeholder="可选"></textarea></div>
        <div id="ioErr"></div>
        <button class="btn primary" style="width:100%;height:36px" id="ioSubmit" data-roles="DISPATCHER,ADMIN">登记插单事件</button>
      </div></section>
      <section class="card"><div class="section-pad" id="ioResult">
        <h3 style="margin:0 0 10px;font-size:15px">影响集合</h3>
        <p class="muted">提交事件后在此展示影响集合摘要与重调度入口。</p>
      </div></section>
    </div>`;

  document.getElementById('ioSubmit').onclick = async () => {
    const errEl = document.getElementById('ioErr');
    errEl.innerHTML = '';
    const payload = {
      subType: document.getElementById('ioSubType').value,
      orderCode: document.getElementById('ioCode').value.trim(),
      productFamily: document.getElementById('ioFamily').value,
      quantity: parseInt(document.getElementById('ioQty').value, 10),
      priority: parseInt(document.getElementById('ioPriority').value, 10),
      arrivalAt: localInputToIso(document.getElementById('ioArrival').value),
      dueAt: localInputToIso(document.getElementById('ioDue').value),
      occurredAt: localInputToIso(document.getElementById('ioOccurred').value),
      note: document.getElementById('ioNote').value.trim() || undefined,
    };
    if (!payload.orderCode || !payload.arrivalAt || !payload.dueAt || !payload.occurredAt) {
      errEl.innerHTML = '<div class="error-box">请完整填写订单号、到达时间、交期与发生时间</div>'; return;
    }
    const btn = document.getElementById('ioSubmit');
    btn.disabled = true; btn.textContent = '提交中…';
    try {
      const r = await Api.newOrderEvent(payload);
      toast(`插单事件 ${r.eventCode} 已登记`);
      const detail = await loadEventDetail(r.eventId);
      renderImpactPanel(document.getElementById('ioResult'), r, detail);
    } catch (e) {
      errEl.innerHTML = errorBoxHtml(e, '插单登记失败');
    } finally {
      btn.disabled = false; btn.textContent = '登记插单事件';
    }
  };
});

/* ---------------- 设备故障 ---------------- */
registerPage('breakdown', ['事件管理', '设备故障'], async (el) => {
  el.innerHTML = loadingHtml('正在加载设备…');
  let machines, eventsPage;
  try {
    [machines, eventsPage] = await Promise.all([
      Api.machines(),
      Api.eventsPage({ page: Shared.eventsPageNo || 0, size: 10, eventType: Shared.eventsType || undefined })]);
  } catch (e) { el.innerHTML = errorBoxHtml(e, '设备加载失败'); return; }

  el.innerHTML = `
    <div class="page-header"><div><h1>设备故障</h1><p>登记设备故障事件（POST /events/breakdowns），并触发重调度</p></div></div>
    <div class="grid-2" style="grid-template-columns:1fr 1fr;align-items:start">
      <section class="card"><div class="section-pad">
        <h3 style="margin:0 0 14px;font-size:15px">故障事件</h3>
        <div class="form-row"><label class="required">设备</label>
          <select class="field" id="bdMachine">${machines.map(m => `<option value="${esc(m.machineId)}">${esc(m.machineId)} · ${esc(m.workCenterId)}（${esc(m.status)}）</option>`).join('')}</select></div>
        <div class="form-row"><label class="required">发生时间</label><input type="datetime-local" class="field" id="bdOccurred" value="${isoToLocalInput(new Date(Date.now() + 24 * 3600e3).toISOString())}"></div>
        <div class="form-row"><label class="required">维修时长(分)</label><input type="number" class="field" id="bdRepair" min="1" value="120"></div>
        <div class="form-row"><label>来源</label>
          <select class="field" id="bdSource"><option value="manual">人工登记</option><option value="iot">IoT 采集</option><option value="mes">MES 推送</option></select></div>
        <div class="form-row"><label>备注</label><textarea class="field" id="bdNote" placeholder="可选"></textarea></div>
        <div id="bdErr"></div>
        <button class="btn primary" style="width:100%;height:36px" id="bdSubmit" data-roles="DISPATCHER,ADMIN">登记故障事件</button>
        <p class="muted" style="margin-top:10px">若事件正在被求解任务使用（E_EVENT_IN_PROCESS），会以红色错误提示返回，请稍后再试。</p>
      </div></section>
      <section class="card"><div class="section-pad" id="bdResult">
        <h3 style="margin:0 0 10px;font-size:15px">影响集合</h3>
        <p class="muted">提交事件后在此展示影响集合摘要与重调度入口。</p>
      </div></section>
    </div>
    <section class="card table-card" style="margin-top:14px">
      <div class="section-pad" style="display:flex;justify-content:space-between;align-items:center;padding-bottom:8px">
        <h3 style="margin:0;font-size:15px">事件记录</h3>
        <select class="field" id="evTypeFilter" style="width:auto">
          <option value="">全部类型</option>
          <option value="NEW_ORDER" ${Shared.eventsType === 'NEW_ORDER' ? 'selected' : ''}>新订单</option>
          <option value="BREAKDOWN" ${Shared.eventsType === 'BREAKDOWN' ? 'selected' : ''}>设备故障</option>
        </select>
      </div>
      <div class="table-wrap" style="max-height:360px"><table class="data-table">
        <thead><tr><th>事件号</th><th>类型</th><th>对象</th><th>发生时间</th><th>状态</th><th>来源</th></tr></thead>
        <tbody>${eventsPage.items.map(ev => `<tr>
          <td>${esc(ev.eventCode)}</td><td>${statusTag(ev.subType || ev.eventType)}</td>
          <td>${esc(ev.machineId || ev.orderId || '-')}</td><td>${fmtDateTime(ev.occurredAt)}</td>
          <td>${statusTag(ev.status)}</td><td>${esc(ev.source || '-')}</td></tr>`).join('')
          || '<tr><td colspan="6" style="text-align:center;color:#909399">暂无事件</td></tr>'}</tbody>
      </table></div>
      ${pagerHtml(eventsPage)}
    </section>`;

  document.getElementById('evTypeFilter').onchange = (ev) => {
    Shared.eventsType = ev.target.value; Shared.eventsPageNo = 0; renderCurrent();
  };
  bindPager(el, (delta) => { Shared.eventsPageNo = (Shared.eventsPageNo || 0) + delta; renderCurrent(); });

  document.getElementById('bdSubmit').onclick = async () => {
    const errEl = document.getElementById('bdErr');
    errEl.innerHTML = '';
    const occurred = localInputToIso(document.getElementById('bdOccurred').value);
    if (!occurred) { errEl.innerHTML = '<div class="error-box">请填写故障发生时间</div>'; return; }
    const payload = {
      machineId: document.getElementById('bdMachine').value,
      occurredAt: occurred,
      repairDurationMinutes: parseInt(document.getElementById('bdRepair').value, 10),
      source: document.getElementById('bdSource').value,
      note: document.getElementById('bdNote').value.trim() || undefined,
    };
    const btn = document.getElementById('bdSubmit');
    btn.disabled = true; btn.textContent = '提交中…';
    try {
      const r = await Api.breakdownEvent(payload);
      toast(`故障事件 ${r.eventCode} 已登记`);
      const detail = await loadEventDetail(r.eventId);
      renderImpactPanel(document.getElementById('bdResult'), r, detail);
    } catch (e) {
      errEl.innerHTML = errorBoxHtml(e, '故障登记失败');
    } finally {
      btn.disabled = false; btn.textContent = '登记故障事件';
    }
  };
});

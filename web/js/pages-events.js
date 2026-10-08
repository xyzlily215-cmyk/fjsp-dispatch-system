/* 事件管理：订单插单 + 设备故障 */

/* 影响摘要 + 重调度向导入口（两页共用） */
function renderImpactPanel(container, data, eventDetail) {
  const summary = data.impactSummary || { total: 0, byType: {} };
  const impacts = eventDetail && eventDetail.impacts ? eventDetail.impacts : [];
  const hardLocks = impacts.filter(i => i.lockType === 'HARD_LOCKED' || i.lockType === 'FROZEN').length;
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
        <td>${i.lockType === 'HARD_LOCKED' || i.lockType === 'FROZEN' ? tag('硬锁定', 'red') : tag('可调整', 'gray')}</td>
        <td><span class="muted">${esc(i.impactReason || reasonText(i.reasonCode))}</span></td></tr>`).join('')}</tbody></table></div>` : ''}
    <div class="section-pad" style="margin-top:16px;border:1px dashed #dcdfe6;border-radius:4px;padding:14px">
      <b style="font-size:13px">去重调度</b>
      <p class="muted" style="margin:6px 0 10px">进入重调度向导：选择原计划版本 → 预览影响范围（硬/软锁定、局部/完全规模）→ 选择模式并创建任务。</p>
      <button class="btn primary" id="rsWizard" data-roles="DISPATCHER,ADMIN">打开重调度向导</button>
    </div>`;
  applyRoleVisibility(container);

  document.getElementById('rsWizard').onclick = () => goTo('reschedule', { eventId: data.eventId });
}

async function loadEventDetail(eventId) {
  try { return await Api.event(eventId); } catch (e) { return null; }
}

/* ---------------- 订单插单 ---------------- */
registerPage('insert', ['事件管理', '订单插单'], async (el, params) => {
  el.innerHTML = loadingHtml('正在加载工艺模板…');
  let templates;
  try { templates = await Api.templates(); } catch (e) { el.innerHTML = errorBoxHtml(e, '工艺模板加载失败'); return; }
  const families = [...new Set(templates.map(t => t.productFamily))];
  // F-07 事件修订：从事件记录携带 reviseFrom 进入时预填原事件并切换为修订提交；
  // 订单本体不随修订重建，仅事件子类/发生时间/备注可更正
  const reviseFrom = params && params.reviseFrom && params.reviseFrom.eventType === 'NEW_ORDER'
    ? params.reviseFrom : null;

  el.innerHTML = `
    <div class="page-header"><div><h1>${reviseFrom ? '修订插单事件' : '订单插单'}</h1>
      <p>${reviseFrom ? `更正事件 ${esc(reviseFrom.eventCode)}：创建携带 revisionOf 的新事件，原事件自动关闭` : '登记新订单事件（POST /events/new-orders），并触发重调度'}</p></div></div>
    ${reviseFrom ? `<div class="success-box" style="margin-bottom:12px"><b>修订模式</b>原事件 ${esc(reviseFrom.eventCode)}（${esc(reviseFrom.orderId || '-')}）；订单号、产品族、数量等订单字段不可随事件修订更改。</div>` : ''}
    <div class="grid-2" style="grid-template-columns:1fr 1fr;align-items:start">
      <section class="card"><div class="section-pad">
        <h3 style="margin:0 0 14px;font-size:15px">${reviseFrom ? '修订内容' : '新订单事件'}</h3>
        ${reviseFrom ? `<div class="form-row"><label class="required">修订原因</label><input class="field" id="ioReason" placeholder="必填，随新事件保存"></div>` : ''}
        <div class="form-row"><label class="required">事件子类</label>
          <select class="field" id="ioSubType">
            <option value="URGENT_INSERT" ${reviseFrom && reviseFrom.subType === 'URGENT_INSERT' ? 'selected' : ''}>紧急插单（URGENT_INSERT）</option>
            <option value="NORMAL_APPEND" ${reviseFrom && reviseFrom.subType === 'NORMAL_APPEND' ? 'selected' : ''}>常规追加（NORMAL_APPEND）</option>
          </select></div>
        <div class="form-row"><label class="required">订单号</label><input class="field" id="ioCode" value="${esc(reviseFrom ? (reviseFrom.orderId || '') : 'ORD-NEW-' + Date.now() % 100000)}" ${reviseFrom ? 'disabled' : ''}></div>
        <div class="form-row"><label class="required">产品族</label>
          <select class="field" id="ioFamily" ${reviseFrom ? 'disabled' : ''}>${families.map(f => `<option>${esc(f)}</option>`).join('')}</select></div>
        <div class="form-row"><label class="required">数量</label><input type="number" class="field" id="ioQty" min="1" value="20" ${reviseFrom ? 'disabled' : ''}></div>
        <div class="form-row"><label class="required">优先级</label><input type="number" class="field" id="ioPriority" min="1" max="5" value="1" ${reviseFrom ? 'disabled' : ''}></div>
        <div class="form-row"><label class="required">到达时间</label><input type="datetime-local" class="field" id="ioArrival" value="${isoToLocalInput(new Date(Date.now() + 24 * 3600e3).toISOString())}" ${reviseFrom ? 'disabled' : ''}></div>
        <div class="form-row"><label class="required">交期</label><input type="datetime-local" class="field" id="ioDue" value="${isoToLocalInput(new Date(Date.now() + 48 * 3600e3).toISOString())}" ${reviseFrom ? 'disabled' : ''}></div>
        <div class="form-row"><label class="required">发生时间</label><input type="datetime-local" class="field" id="ioOccurred" value="${reviseFrom ? isoToLocalInput(reviseFrom.occurredAt) : isoToLocalInput(new Date(Date.now() + 24 * 3600e3).toISOString())}"></div>
        <div class="form-row"><label>备注</label><textarea class="field" id="ioNote" placeholder="可选">${reviseFrom ? esc(reviseFrom.note || '') : ''}</textarea></div>
        <div id="ioErr"></div>
        <button class="btn primary" style="width:100%;height:36px" id="ioSubmit" data-roles="DISPATCHER,ADMIN">${reviseFrom ? '提交修订' : '登记插单事件'}</button>
      </div></section>
      <section class="card"><div class="section-pad" id="ioResult">
        <h3 style="margin:0 0 10px;font-size:15px">影响集合</h3>
        <p class="muted">提交事件后在此展示影响集合摘要与重调度入口。</p>
      </div></section>
    </div>`;

  document.getElementById('ioSubmit').onclick = async () => {
    const errEl = document.getElementById('ioErr');
    errEl.innerHTML = '';
    const occurredAt = localInputToIso(document.getElementById('ioOccurred').value);
    const btn = document.getElementById('ioSubmit');
    btn.disabled = true; btn.textContent = '提交中…';
    try {
      let r;
      if (reviseFrom) {
        const reason = document.getElementById('ioReason').value.trim();
        if (!reason) {
          errEl.innerHTML = '<div class="error-box">请填写修订原因</div>';
          btn.disabled = false; btn.textContent = '提交修订';
          return;
        }
        r = await Api.reviseEvent(reviseFrom.eventId, {
          reason,
          subType: document.getElementById('ioSubType').value,
          occurredAt,
          note: document.getElementById('ioNote').value.trim() || null,
        });
        toast(`修订事件 ${r.eventCode} 已创建，原事件 ${reviseFrom.eventCode} 已关闭`);
      } else {
        const payload = {
          subType: document.getElementById('ioSubType').value,
          orderCode: document.getElementById('ioCode').value.trim(),
          productFamily: document.getElementById('ioFamily').value,
          quantity: parseInt(document.getElementById('ioQty').value, 10),
          priority: parseInt(document.getElementById('ioPriority').value, 10),
          arrivalAt: localInputToIso(document.getElementById('ioArrival').value),
          dueAt: localInputToIso(document.getElementById('ioDue').value),
          occurredAt,
          note: document.getElementById('ioNote').value.trim() || undefined,
        };
        if (!payload.orderCode || !payload.arrivalAt || !payload.dueAt || !payload.occurredAt) {
          errEl.innerHTML = '<div class="error-box">请完整填写订单号、到达时间、交期与发生时间</div>';
          btn.disabled = false; btn.textContent = '登记插单事件';
          return;
        }
        r = await Api.newOrderEvent(payload);
        toast(`插单事件 ${r.eventCode} 已登记`);
      }
      const detail = await loadEventDetail(r.eventId);
      renderImpactPanel(document.getElementById('ioResult'), r, detail);
    } catch (e) {
      errEl.innerHTML = errorBoxHtml(e, reviseFrom ? '修订提交失败' : '插单登记失败');
    } finally {
      btn.disabled = false; btn.textContent = reviseFrom ? '提交修订' : '登记插单事件';
    }
  };
});

/* ---------------- 设备故障 ---------------- */
registerPage('breakdown', ['事件管理', '设备故障'], async (el, params) => {
  el.innerHTML = loadingHtml('正在加载设备…');
  let machines, eventsPage;
  try {
    [machines, eventsPage] = await Promise.all([
      Api.machines(),
      Api.eventsPage({ page: Shared.eventsPageNo || 0, size: 10, eventType: Shared.eventsType || undefined })]);
  } catch (e) { el.innerHTML = errorBoxHtml(e, '设备加载失败'); return; }
  // F-07 事件修订：从事件记录携带 reviseFrom 进入时预填原事件并切换为修订提交；设备不可随修订更改
  const reviseFrom = params && params.reviseFrom && params.reviseFrom.eventType === 'BREAKDOWN'
    ? params.reviseFrom : null;

  el.innerHTML = `
    <div class="page-header"><div><h1>${reviseFrom ? '修订故障事件' : '设备故障'}</h1>
      <p>${reviseFrom ? `更正事件 ${esc(reviseFrom.eventCode)}：创建携带 revisionOf 的新事件，原事件自动关闭` : '登记设备故障事件（POST /events/breakdowns），并触发重调度'}</p></div></div>
    ${reviseFrom ? `<div class="success-box" style="margin-bottom:12px"><b>修订模式</b>原事件 ${esc(reviseFrom.eventCode)}（设备 ${esc(reviseFrom.machineId || '-')}）；维修结束时间与影响集合将按修订后字段重算。</div>` : ''}
    <div class="grid-2" style="grid-template-columns:1fr 1fr;align-items:start">
      <section class="card"><div class="section-pad">
        <h3 style="margin:0 0 14px;font-size:15px">${reviseFrom ? '修订内容' : '故障事件'}</h3>
        ${reviseFrom ? `<div class="form-row"><label class="required">修订原因</label><input class="field" id="bdReason" placeholder="必填，随新事件保存"></div>` : ''}
        <div class="form-row"><label class="required">设备</label>
          <select class="field" id="bdMachine" ${reviseFrom ? 'disabled' : ''}>${machines.map(m => `<option value="${esc(m.machineId)}" ${reviseFrom && reviseFrom.machineId === m.machineId ? 'selected' : ''}>${esc(m.machineId)} · ${esc(m.workCenterId)}（${esc(m.status)}）</option>`).join('')}</select></div>
        <div class="form-row"><label class="required">发生时间</label><input type="datetime-local" class="field" id="bdOccurred" value="${reviseFrom ? isoToLocalInput(reviseFrom.occurredAt) : isoToLocalInput(new Date(Date.now() + 24 * 3600e3).toISOString())}"></div>
        <div class="form-row"><label class="required">维修时长(分)</label><input type="number" class="field" id="bdRepair" min="1" value="${reviseFrom ? (reviseFrom.repairDurationMinutes || 120) : 120}"></div>
        <div class="form-row"><label>来源</label>
          <select class="field" id="bdSource">
            <option value="manual" ${reviseFrom && reviseFrom.source === 'manual' ? 'selected' : ''}>人工登记</option>
            <option value="iot" ${reviseFrom && reviseFrom.source === 'iot' ? 'selected' : ''}>IoT 采集</option>
            <option value="mes" ${reviseFrom && reviseFrom.source === 'mes' ? 'selected' : ''}>MES 推送</option>
          </select></div>
        <div class="form-row"><label>备注</label><textarea class="field" id="bdNote" placeholder="可选">${reviseFrom ? esc(reviseFrom.note || '') : ''}</textarea></div>
        <div id="bdErr"></div>
        <button class="btn primary" style="width:100%;height:36px" id="bdSubmit" data-roles="DISPATCHER,ADMIN">${reviseFrom ? '提交修订' : '登记故障事件'}</button>
        <p class="muted" style="margin-top:10px">若事件正在被求解任务使用（E_EVENT_IN_PROCESS），或同设备存在维修区间重叠的未关闭故障（E_DUPLICATE），会以红色错误提示返回。</p>
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
        <thead><tr><th>事件号</th><th>类型</th><th>对象</th><th>发生时间</th><th>状态</th><th>来源</th><th>操作</th></tr></thead>
        <tbody>${eventsPage.items.map((ev, i) => `<tr>
          <td>${esc(ev.eventCode)}${ev.revisionOf ? ' ' + tag('修订', 'purple') : ''}</td><td>${statusTag(ev.subType || ev.eventType)}</td>
          <td>${esc(ev.machineId || ev.orderId || '-')}</td><td>${fmtDateTime(ev.occurredAt)}</td>
          <td>${statusTag(ev.status)}</td><td>${esc(ev.source || '-')}</td>
          <td>${ev.status === 'CLOSED' ? '<span class="muted">已关闭</span>'
            : `<button class="btn small" data-ev-revise="${i}" data-roles="DISPATCHER,ADMIN">修订</button>
               <button class="btn small" data-ev-close="${i}" data-roles="DISPATCHER,ADMIN">关闭</button>`}</td></tr>`).join('')
          || '<tr><td colspan="7" style="text-align:center;color:#909399">暂无事件</td></tr>'}</tbody>
      </table></div>
      ${pagerHtml(eventsPage)}
    </section>`;

  document.getElementById('evTypeFilter').onchange = (ev) => {
    Shared.eventsType = ev.target.value; Shared.eventsPageNo = 0; renderCurrent();
  };
  bindPager(el, (delta) => { Shared.eventsPageNo = (Shared.eventsPageNo || 0) + delta; renderCurrent(); });

  el.querySelectorAll('[data-ev-revise]').forEach(btn => {
    btn.onclick = () => {
      const ev = eventsPage.items[parseInt(btn.dataset.evRevise, 10)];
      goTo(ev.eventType === 'NEW_ORDER' ? 'insert' : 'breakdown', { reviseFrom: ev });
    };
  });
  el.querySelectorAll('[data-ev-close]').forEach(btn => {
    btn.onclick = async () => {
      const ev = eventsPage.items[parseInt(btn.dataset.evClose, 10)];
      if (!window.confirm(`确认关闭事件 ${ev.eventCode}？关闭后不可再触发重调度。`)) return;
      btn.disabled = true;
      try {
        await Api.closeEvent(ev.eventId);
        toast(`事件 ${ev.eventCode} 已关闭`);
        renderCurrent();
      } catch (e) {
        btn.disabled = false;
        toast(errMsg(e), 'error');
      }
    };
  });

  document.getElementById('bdSubmit').onclick = async () => {
    const errEl = document.getElementById('bdErr');
    errEl.innerHTML = '';
    const occurred = localInputToIso(document.getElementById('bdOccurred').value);
    if (!occurred) { errEl.innerHTML = '<div class="error-box">请填写故障发生时间</div>'; return; }
    const btn = document.getElementById('bdSubmit');
    btn.disabled = true; btn.textContent = '提交中…';
    try {
      let r;
      if (reviseFrom) {
        const reason = document.getElementById('bdReason').value.trim();
        if (!reason) {
          errEl.innerHTML = '<div class="error-box">请填写修订原因</div>';
          btn.disabled = false; btn.textContent = '提交修订';
          return;
        }
        r = await Api.reviseEvent(reviseFrom.eventId, {
          reason,
          occurredAt: occurred,
          repairDurationMinutes: parseInt(document.getElementById('bdRepair').value, 10),
          source: document.getElementById('bdSource').value,
          note: document.getElementById('bdNote').value.trim() || null,
        });
        toast(`修订事件 ${r.eventCode} 已创建，原事件 ${reviseFrom.eventCode} 已关闭`);
      } else {
        const payload = {
          machineId: document.getElementById('bdMachine').value,
          occurredAt: occurred,
          repairDurationMinutes: parseInt(document.getElementById('bdRepair').value, 10),
          source: document.getElementById('bdSource').value,
          note: document.getElementById('bdNote').value.trim() || undefined,
        };
        r = await Api.breakdownEvent(payload);
        toast(`故障事件 ${r.eventCode} 已登记`);
      }
      const detail = await loadEventDetail(r.eventId);
      renderImpactPanel(document.getElementById('bdResult'), r, detail);
    } catch (e) {
      errEl.innerHTML = errorBoxHtml(e, reviseFrom ? '修订提交失败' : '故障登记失败');
    } finally {
      btn.disabled = false; btn.textContent = reviseFrom ? '提交修订' : '登记故障事件';
    }
  };
});

/* ---------------- F-08 重调度向导 ----------------
 * 五步：选择原计划版本 → 选择事件 → 影响范围预览 → 模式与参数 → 确认提交。
 * 步骤间跳转只替换 #wzBody，不整页重渲染，已加载的版本/事件列表保持不变。
 */
const WIZARD_STEPS = ['选择原计划', '选择事件', '影响范围预览', '模式与参数', '确认提交'];
const Wizard = {
  step: 0,
  planVersionId: null,
  eventId: null,
  preview: null,
  previewDetail: null,
  previewKey: '',
  mode: 'BOTH',
  freezeWindowMinutes: '',
  timeLimitSeconds: 30,
  weights: { weightedTardiness: 0.4, makespan: 0.3, deltaPlan: 0.2, machineChange: 0.1 },
};

registerPage('reschedule', ['计划调度', '重调度向导'], async (el, params) => {
  el.innerHTML = loadingHtml('正在加载计划版本与事件…');
  let versions, events;
  try {
    const [vs, ep] = await Promise.all([Api.planVersions(), Api.eventsPage({ size: 50 })]);
    versions = vs;
    events = ep.items;
  } catch (e) { el.innerHTML = errorBoxHtml(e, '向导数据加载失败'); return; }

  if (params && params.eventId) Wizard.eventId = params.eventId;
  if (!versions.some(v => v.id === Wizard.planVersionId)) {
    const cur = Shared.dashboard && Shared.dashboard.currentPlan;
    Wizard.planVersionId = cur && versions.some(v => v.id === cur.id) ? cur.id
      : ((versions.find(v => v.status === 'PUBLISHED' || v.status === 'EXECUTING') || versions[0] || {}).id || null);
  }
  const selectableEvents = events.filter(e => e.status !== 'CLOSED');
  if (!selectableEvents.some(e => e.eventId === Wizard.eventId)) {
    Wizard.eventId = (selectableEvents[0] || {}).eventId || null;
  }
  Wizard.preview = null;
  Wizard.previewDetail = null;
  Wizard.previewKey = '';
  if (Wizard.step < 0 || Wizard.step >= WIZARD_STEPS.length) Wizard.step = 0;

  el.innerHTML = `
    <div class="page-header"><div><h1>重调度向导</h1>
      <p>基于原计划与事件生成候选重调度方案；已完成、加工中与冻结窗口内工序硬锁定不可变更</p></div></div>
    <section class="card"><div class="section-pad">
      <div id="wzSteps" style="margin-bottom:16px"></div>
      <div id="wzBody"></div>
      <div class="buttons" style="margin-top:18px">
        <button class="btn" id="wzPrev">&larr; 上一步</button>
        <button class="btn primary" id="wzNext">下一步 &rarr;</button>
      </div>
    </div></section>`;

  const body = () => document.getElementById('wzBody');
  const versionOf = (id) => versions.find(v => v.id === id);
  const eventOf = (id) => events.find(e => e.eventId === id);
  const estimate = (mode) => {
    const m = Wizard.preview && Wizard.preview.modeEstimates && Wizard.preview.modeEstimates[mode];
    return m ? m.estimatedOperationCount : null;
  };

  function renderStepsBar() {
    document.getElementById('wzSteps').innerHTML = WIZARD_STEPS.map((s, i) =>
      tag(`${i + 1}. ${s}`, i === Wizard.step ? 'blue' : i < Wizard.step ? 'green' : 'gray')).join(' ');
    document.getElementById('wzPrev').disabled = Wizard.step === 0;
    document.getElementById('wzNext').style.display = Wizard.step === WIZARD_STEPS.length - 1 ? 'none' : '';
  }

  function renderStep() {
    renderStepsBar();
    if (Wizard.step === 0) renderStepPlan();
    else if (Wizard.step === 1) renderStepEvent();
    else if (Wizard.step === 2) renderStepPreview();
    else if (Wizard.step === 3) renderStepMode();
    else renderStepConfirm();
    applyRoleVisibility(el);
  }

  /* 第 1 步：原计划版本 */
  function renderStepPlan() {
    const curId = Shared.dashboard && Shared.dashboard.currentPlan ? Shared.dashboard.currentPlan.id : null;
    body().innerHTML = versions.length ? `
      <h3 style="margin:0 0 12px;font-size:15px">选择原计划版本</h3>
      <p class="muted" style="margin:0 0 12px">重调度在该版本基础上进行；通常选择当前发布/执行中的版本。</p>
      <select class="field wide" id="wzPlan">${versions.map(v =>
        `<option value="${esc(v.id)}" ${v.id === Wizard.planVersionId ? 'selected' : ''}>${esc(v.versionCode)} · ${(STATUS_TAGS[v.status] || [])[1] || v.status}${v.candidateType ? ' · ' + ((STATUS_TAGS[v.candidateType] || [])[1] || v.candidateType) : ''} · ${fmtDateTime(v.createdAt)}${v.id === curId ? '（当前发布）' : ''}</option>`).join('')}</select>`
      : '<div class="empty-screen" style="padding:30px">暂无计划版本，请先创建基线排程。</div>';
    const sel = document.getElementById('wzPlan');
    if (sel) sel.onchange = () => { Wizard.planVersionId = sel.value; };
  }

  /* 第 2 步：事件 */
  function renderStepEvent() {
    body().innerHTML = events.length ? `
      <h3 style="margin:0 0 12px;font-size:15px">选择触发事件</h3>
      <p class="muted" style="margin:0 0 12px">展示最近 50 条事件；事件的影响集合在登记时已计算并保存。已关闭事件不可再触发重调度。</p>
      <select class="field wide" id="wzEvent">${events.map(ev =>
        `<option value="${esc(ev.eventId)}" ${ev.eventId === Wizard.eventId ? 'selected' : ''} ${ev.status === 'CLOSED' ? 'disabled' : ''}>${esc(ev.eventCode)} · ${(STATUS_TAGS[ev.subType || ev.eventType] || [])[1] || ev.eventType} · ${esc(ev.machineId || ev.orderId || '-')} · ${fmtDateTime(ev.occurredAt)} · ${(STATUS_TAGS[ev.status] || [])[1] || ev.status}</option>`).join('')}</select>`
      : '<div class="empty-screen" style="padding:30px">暂无事件，请先在「订单插单 / 设备故障」中登记事件。</div>';
    const sel = document.getElementById('wzEvent');
    if (sel) sel.onchange = () => { Wizard.eventId = sel.value; };
  }

  /* 第 3 步：影响范围预览 */
  function renderStepPreview() {
    body().innerHTML = `
      <h3 style="margin:0 0 12px;font-size:15px">影响范围预览</h3>
      <div class="inline-form" style="margin-bottom:12px">
        <label class="muted">冻结窗口(分钟)</label>
        <input type="number" class="field" id="wzFreeze" min="0" max="1440" style="width:120px"
          value="${esc(Wizard.freezeWindowMinutes)}" placeholder="默认">
        <button class="btn small" id="wzReload">重新预览</button>
      </div>
      <div id="wzPreview"></div>`;
    document.getElementById('wzFreeze').onchange = (e) => { Wizard.freezeWindowMinutes = e.target.value; };
    document.getElementById('wzReload').onclick = () => {
      Wizard.freezeWindowMinutes = document.getElementById('wzFreeze').value;
      Wizard.previewKey = '';
      loadPreview();
    };
    loadPreview();
  }

  async function loadPreview() {
    const key = `${Wizard.planVersionId}|${Wizard.eventId}|${Wizard.freezeWindowMinutes}`;
    const box = document.getElementById('wzPreview');
    if (!box) return;
    if (Wizard.preview && Wizard.previewKey === key) {
      box.innerHTML = previewHtml(Wizard.preview, Wizard.previewDetail);
      return;
    }
    box.innerHTML = loadingHtml('正在计算影响范围…');
    try {
      const [p, detail] = await Promise.all([
        Api.reschedulePreview(Wizard.eventId, {
          planVersionId: Wizard.planVersionId,
          freezeWindowMinutes: Wizard.freezeWindowMinutes === '' ? undefined : Wizard.freezeWindowMinutes,
        }),
        Api.event(Wizard.eventId)]);
      if (!document.getElementById('wzPreview')) return;
      Wizard.preview = p;
      Wizard.previewDetail = detail;
      Wizard.previewKey = key;
      document.getElementById('wzPreview').innerHTML = previewHtml(p, detail);
    } catch (e) {
      if (!document.getElementById('wzPreview')) return;
      Wizard.preview = null;
      Wizard.previewKey = '';
      document.getElementById('wzPreview').innerHTML = errorBoxHtml(e, '影响范围预览失败');
    }
  }

  function previewHtml(p, detail) {
    const byType = (p.impactSummary && p.impactSummary.byType) || {};
    const impacts = detail && detail.impacts ? detail.impacts : [];
    return `
      <div class="impact-kpis">
        <div class="impact-kpi"><span>硬锁定工序</span><b>${p.hardLockedCount ?? 0}</b></div>
        <div class="impact-kpi"><span>软锁定工序</span><b>${p.softLockedCount ?? 0}</b></div>
        <div class="impact-kpi ${p.impactedOperationCount ? 'warn' : ''}"><span>影响工序数</span><b>${p.impactedOperationCount ?? 0}</b></div>
        <div class="impact-kpi"><span>受影响订单</span><b>${p.impactedOrderCount ?? 0}</b></div>
        <div class="impact-kpi"><span>局部模式规模</span><b>${estimate('LOCAL_RESCHEDULE') ?? '-'} 道</b></div>
        <div class="impact-kpi"><span>完全模式规模</span><b>${estimate('FULL_RESCHEDULE') ?? '-'} 道</b></div>
      </div>
      <p class="muted" style="margin:10px 0 0">原计划版本 <b>${esc(p.planVersionCode)}</b> · 冻结窗口 ${p.freezeWindowMinutes} 分钟
        ${Object.keys(byType).length ? ' · 影响类型：' + Object.entries(byType).map(([k, v]) => `${impactText(k)} × ${v}`).join('，') : ''}</p>
      ${(p.impactedOrders || []).length ? `<p class="muted" style="margin:6px 0 0">受影响订单：${p.impactedOrders.map(o => esc(o)).join('、')}</p>` : ''}
      ${impacts.length ? `<div class="table-wrap" style="max-height:240px;margin-top:10px"><table class="data-table">
        <thead><tr><th>工序</th><th>影响类型</th><th>锁定</th><th>原因</th></tr></thead>
        <tbody>${impacts.slice(0, 30).map(i => `<tr><td>${esc(i.operationId)}</td>
          <td>${tag(impactText(i.impactType), 'purple')}</td>
          <td>${i.lockType === 'HARD_LOCKED' || i.lockType === 'FROZEN' ? tag('硬锁定', 'red') : tag('可调整', 'gray')}</td>
          <td><span class="muted">${esc(i.impactReason || reasonText(i.reasonCode))}</span></td></tr>`).join('')}</tbody></table></div>` : ''}`;
  }

  /* 第 4 步：模式与参数 */
  function renderStepMode() {
    const local = estimate('LOCAL_RESCHEDULE');
    const full = estimate('FULL_RESCHEDULE');
    const modeCard = (value, title, desc) => `
      <label style="display:block;border:1px solid ${Wizard.mode === value ? '#409eff' : '#dcdfe6'};border-radius:4px;padding:12px 14px;margin-bottom:10px;cursor:pointer">
        <input type="radio" name="wzMode" value="${value}" ${Wizard.mode === value ? 'checked' : ''}>
        <b style="margin-left:6px">${title}</b>
        <p class="muted" style="margin:6px 0 0">${desc}</p>
      </label>`;
    body().innerHTML = `
      <h3 style="margin:0 0 12px;font-size:15px">选择重调度模式</h3>
      ${modeCard('LOCAL_RESCHEDULE', '局部重调度（LOCAL）',
        `仅调整影响集合内尚未开始的工序，尽量保持其他原计划不变。预计求解规模 ${local ?? '-'} 道工序。`)}
      ${modeCard('FULL_RESCHEDULE', '完全重调度（FULL）',
        `调整事件发生后所有未完成且不在冻结窗口内的工序。预计求解规模 ${full ?? '-'} 道工序。`)}
      ${modeCard('BOTH', '两种都算（局部 + 完全）',
        '一次提交两个任务，生成同一候选组的 LOCAL 与 FULL 两个草稿方案，便于在「方案对比」中并列比较拖期、总工期、设备变更数与计划扰动。')}
      <h3 style="margin:16px 0 12px;font-size:15px">求解参数</h3>
      <div class="form-row"><label>时间上限(秒)</label><input type="number" class="field" id="wzLimit" min="1" max="600" value="${Wizard.timeLimitSeconds}"></div>
      <div class="form-row"><label>拖期权重</label><input type="number" class="field wz-w" data-k="weightedTardiness" step="0.1" min="0" value="${Wizard.weights.weightedTardiness}"></div>
      <div class="form-row"><label>C_max 权重</label><input type="number" class="field wz-w" data-k="makespan" step="0.1" min="0" value="${Wizard.weights.makespan}"></div>
      <div class="form-row"><label>扰动权重</label><input type="number" class="field wz-w" data-k="deltaPlan" step="0.1" min="0" value="${Wizard.weights.deltaPlan}"></div>
      <div class="form-row"><label>换机权重</label><input type="number" class="field wz-w" data-k="machineChange" step="0.1" min="0" value="${Wizard.weights.machineChange}"></div>`;
    body().querySelectorAll('input[name="wzMode"]').forEach(r => {
      r.onchange = () => { Wizard.mode = r.value; renderStepMode(); };
    });
    document.getElementById('wzLimit').onchange = (e) => {
      Wizard.timeLimitSeconds = parseInt(e.target.value, 10) || 30;
    };
    body().querySelectorAll('.wz-w').forEach(inp => {
      inp.onchange = () => { Wizard.weights[inp.dataset.k] = parseFloat(inp.value) || 0; };
    });
  }

  /* 第 5 步：确认提交 */
  function renderStepConfirm() {
    const v = versionOf(Wizard.planVersionId);
    const ev = eventOf(Wizard.eventId);
    const modeText = Wizard.mode === 'BOTH' ? '局部 + 完全（两个任务，同一候选组）'
      : Wizard.mode === 'LOCAL_RESCHEDULE' ? '局部重调度（LOCAL）' : '完全重调度（FULL）';
    const local = estimate('LOCAL_RESCHEDULE');
    const full = estimate('FULL_RESCHEDULE');
    body().innerHTML = `
      <h3 style="margin:0 0 12px;font-size:15px">确认并创建任务</h3>
      <dl class="detail-list">
        <dt>原计划版本</dt><dd>${v ? esc(v.versionCode) + '（' + esc(v.status) + '）' : '-'}</dd>
        <dt>关联事件</dt><dd>${ev ? esc(ev.eventCode) + ' · ' + esc(ev.machineId || ev.orderId || '') : '-'}</dd>
        <dt>重调度模式</dt><dd>${modeText}</dd>
        <dt>冻结窗口</dt><dd>${Wizard.freezeWindowMinutes === '' ? '默认（系统配置）' : esc(Wizard.freezeWindowMinutes) + ' 分钟'}</dd>
        <dt>时间上限</dt><dd>${Wizard.timeLimitSeconds} 秒</dd>
        ${Wizard.preview ? `<dt>预计求解规模</dt><dd>局部 ${local ?? '-'} 道 / 完全 ${full ?? '-'} 道工序</dd>` : ''}
      </dl>
      <p class="muted" style="margin:10px 0">提交后 POST /schedule-tasks（携带幂等键），自动跳转调度任务页跟踪求解进度；求解成功后可在「方案对比」并列查看局部与完全方案。</p>
      <div id="wzErr"></div>
      <button class="btn primary" id="wzSubmit" data-roles="DISPATCHER,ADMIN" style="height:36px">创建重调度任务</button>`;

    document.getElementById('wzSubmit').onclick = async () => {
      const errEl = document.getElementById('wzErr');
      errEl.innerHTML = '';
      const modes = Wizard.mode === 'BOTH' ? ['LOCAL_RESCHEDULE', 'FULL_RESCHEDULE'] : [Wizard.mode];
      const btn = document.getElementById('wzSubmit');
      btn.disabled = true;
      btn.textContent = '创建中…';
      const created = [];
      try {
        for (const mode of modes) {
          const payload = {
            mode,
            oldPlanVersionId: Wizard.planVersionId,
            eventId: Wizard.eventId,
            objectiveWeights: { ...Wizard.weights },
            algorithm: { timeLimitSeconds: Wizard.timeLimitSeconds },
          };
          if (Wizard.freezeWindowMinutes !== '') {
            payload.freezeWindowMinutes = parseInt(Wizard.freezeWindowMinutes, 10);
          }
          created.push(await Api.createTask(payload));
        }
        toast(`已创建重调度任务 ${created.map(c => c.taskCode).join('、')}`
          + (modes.length > 1 ? '（同一候选组，可在方案对比中并列查看）' : ''));
        Shared.selectedTaskId = created[0].taskId;
        Wizard.step = 0;
        goTo('tasks');
      } catch (e) {
        errEl.innerHTML = errorBoxHtml(e, created.length
          ? `任务 ${created.map(c => c.taskCode).join('、')} 已创建，其余创建失败`
          : '创建重调度任务失败');
        btn.disabled = false;
        btn.textContent = '创建重调度任务';
      }
    };
  }

  document.getElementById('wzPrev').onclick = () => {
    if (Wizard.step > 0) { Wizard.step--; renderStep(); }
  };
  document.getElementById('wzNext').onclick = () => {
    if (Wizard.step === 0 && !Wizard.planVersionId) { toast('请先选择原计划版本', 'error'); return; }
    if (Wizard.step === 1 && !Wizard.eventId) { toast('请先选择事件', 'error'); return; }
    if (Wizard.step === 2 && !Wizard.preview) { toast('影响范围预览尚未加载完成', 'error'); return; }
    if (Wizard.step < WIZARD_STEPS.length - 1) { Wizard.step++; renderStep(); }
  };

  renderStep();
});

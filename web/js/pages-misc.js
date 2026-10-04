/* 基础数据页（含弹窗 CRUD）：设备 / 日历 / 工艺模板 / 订单 / 计划版本 / 实际执行 */

/* 收集所有已知产品族（模板 + 设备能力） */
function collectFamilies(templates, machines) {
  const set = new Set();
  (templates || []).forEach(t => t.productFamily && set.add(t.productFamily));
  (machines || []).forEach(m => (m.productFamilies || []).forEach(f => set.add(f)));
  return [...set];
}

/* ---------------- 设备管理 ---------------- */
registerPage('machines', ['基础数据', '设备管理'], async (el) => {
  el.innerHTML = loadingHtml('正在加载设备…');
  let machines, templates;
  try { [machines, templates] = await Promise.all([Api.machines(), Api.templates()]); }
  catch (e) { el.innerHTML = errorBoxHtml(e, '设备加载失败'); return; }
  const families = collectFamilies(templates, machines);
  const calendarIds = [...new Set(machines.map(m => m.calendarId).filter(Boolean))];

  el.innerHTML = `
    <div class="page-header"><div><h1>设备管理</h1><p>车间设备清单与能力（新增 / 编辑 / 启停，停用后不进入新任务候选集）</p></div>
      <div class="buttons"><button class="btn" onclick="renderCurrent()">&#8635; 刷新</button>
      <button class="btn primary" id="mcAdd" data-roles="ADMIN">+ 新增设备</button></div></div>
    <section class="card table-card"><div class="table-wrap"><table class="data-table">
      <thead><tr><th>设备号</th><th>名称</th><th>工作中心</th><th>日历</th><th>可加工产品族</th><th>备注</th><th>状态</th><th>操作</th></tr></thead>
      <tbody>${machines.map(m => `<tr>
        <td class="machine-name">${esc(m.machineId)}</td>
        <td>${esc(m.machineName || '-')}</td>
        <td>${esc(m.workCenterId)}</td><td>${esc(m.calendarId || '-')}</td>
        <td>${(m.productFamilies || []).map(f => `<span class="ability">${esc(f)}</span>`).join(' ')}</td>
        <td><span class="muted">${esc(m.remark || '-')}</span></td>
        <td>${statusTag(m.status)}</td>
        <td class="table-actions">
          <a data-act="edit" data-id="${esc(m.machineId)}">编辑</a>
          ${m.status === 'ACTIVE'
            ? `<a data-act="off" data-id="${esc(m.machineId)}" style="color:#e6a23c">停用</a>`
            : `<a data-act="on" data-id="${esc(m.machineId)}" style="color:#67c23a">启用</a>`}
        </td></tr>`).join('')}</tbody>
    </table></div></section>`;

  const machineForm = (m) => `
    <div class="form-grid">
      <label class="required">设备编码</label><input class="field" id="mfCode" value="${esc(m ? m.machineCode : '')}" placeholder="如 M-09">
      <label>设备名称</label><input class="field" id="mfName" value="${esc(m ? m.machineName || '' : '')}" placeholder="如 车削中心 3 号机">
      <label class="required">工作中心</label><input class="field" id="mfWc" value="${esc(m ? m.workCenterId : '')}" placeholder="如 WC-车削" list="mfWcList">
      <datalist id="mfWcList">${[...new Set(machines.map(x => x.workCenterId).filter(Boolean))].map(w => `<option value="${esc(w)}">`).join('')}</datalist>
      <label>绑定日历</label><select class="field" id="mfCal">
        <option value="">（不绑定）</option>
        ${calendarIds.map(c => `<option value="${esc(c)}" ${m && m.calendarId === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
      </select>
      <label class="required">能力产品族</label><div class="check-group" id="mfFam">
        ${families.map(f => `<label><input type="checkbox" value="${esc(f)}" ${m && (m.productFamilies || []).includes(f) ? 'checked' : ''}>${esc(f)}</label>`).join('')}
        <input class="field" id="mfFamCustom" placeholder="自定义族，逗号分隔" style="width:170px">
      </div>
      <label>备注</label><textarea class="field" id="mfRemark">${esc(m ? m.remark || '' : '')}</textarea>
    </div>`;

  const collectMachineForm = () => {
    const machineCode = document.getElementById('mfCode').value.trim();
    const workCenterId = document.getElementById('mfWc').value.trim();
    const fams = [...document.querySelectorAll('#mfFam input[type=checkbox]:checked')].map(c => c.value);
    const custom = document.getElementById('mfFamCustom').value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
    const productFamilies = [...new Set([...fams, ...custom])];
    if (!machineCode) { modalError('请填写设备编码'); return null; }
    if (!workCenterId) { modalError('请填写工作中心'); return null; }
    if (!productFamilies.length) { modalError('请至少选择一个能力产品族'); return null; }
    return {
      machineCode,
      machineName: document.getElementById('mfName').value.trim() || null,
      workCenterId,
      calendarId: document.getElementById('mfCal').value || null,
      productFamilies,
      remark: document.getElementById('mfRemark').value.trim() || null,
    };
  };

  document.getElementById('mcAdd').onclick = () => {
    openModal({
      title: '新增设备', body: machineForm(null), okText: '创建',
      onOk: async () => {
        const payload = collectMachineForm();
        if (!payload) return false;
        await Api.createMachine(payload);
        toast('设备 ' + payload.machineCode + ' 已创建');
        renderCurrent();
      },
    });
  };

  el.querySelectorAll('a[data-act]').forEach(a => {
    a.onclick = async () => {
      const id = a.dataset.id;
      const m = machines.find(x => x.machineId === id);
      if (a.dataset.act === 'edit') {
        openModal({
          title: '编辑设备 ' + id, body: machineForm(m), okText: '保存',
          onOk: async () => {
            const payload = collectMachineForm();
            if (!payload) return false;
            await Api.updateMachine(id, payload);
            toast('设备 ' + id + ' 已更新');
            renderCurrent();
          },
        });
      } else {
        const toInactive = a.dataset.act === 'off';
        if (toInactive && !confirm(`确定停用设备 ${id}？停用后不再进入新任务的候选设备集。`)) return;
        try {
          await Api.setMachineStatus(id, toInactive ? 'INACTIVE' : 'ACTIVE');
          toast(`设备 ${id} 已${toInactive ? '停用' : '启用'}`);
          renderCurrent();
        } catch (e) { toastErr(e, '操作失败'); }
      }
    };
  });
});

/* ---------------- 设备日历 ---------------- */
registerPage('calendar', ['基础数据', '设备日历'], async (el) => {
  el.innerHTML = loadingHtml('正在加载设备日历…');
  let machines;
  try { machines = await Api.machines(); } catch (e) { el.innerHTML = errorBoxHtml(e, '加载失败'); return; }
  const withCal = machines.filter(m => m.calendarId);
  if (!withCal.length) {
    el.innerHTML = `<div class="page-header"><div><h1>设备日历</h1><p>设备日历与不可用区间维护</p></div></div>
      <section class="card"><div class="empty-screen"><h3>暂无绑定日历的设备</h3></div></section>`;
    return;
  }
  const selected = Shared.calendarMachineId && withCal.some(m => m.machineId === Shared.calendarMachineId)
    ? Shared.calendarMachineId : withCal[0].machineId;
  const machine = withCal.find(m => m.machineId === selected);

  let intervals;
  try { intervals = await Api.calendarIntervals(machine.calendarId); }
  catch (e) { el.innerHTML = errorBoxHtml(e, '日历区间加载失败'); return; }
  const TYPE_TEXT = { WORK: '班次可用', BREAK: '休息', HOLIDAY: '节假日', REPAIR: '维修' };

  el.innerHTML = `
    <div class="page-header"><div><h1>设备日历</h1><p>班次（WORK）定义可用时间；不可用区间从可用时间中扣除</p></div>
      <div class="buttons"><button class="btn" onclick="renderCurrent()">&#8635; 刷新</button>
      <button class="btn primary" id="calAdd" data-roles="ADMIN">+ 新增不可用区间</button></div></div>
    <section class="card section-card"><div class="toolbar"><div class="filters">
      <span class="filter-label">设备 / 日历</span>
      <select class="field wide" id="calMachine">${withCal.map(m =>
        `<option value="${esc(m.machineId)}" ${m.machineId === selected ? 'selected' : ''}>${esc(m.machineId)} · ${esc(m.machineName || m.workCenterId)}（${esc(m.calendarId)}）</option>`).join('')}
      </select></div></div>
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>类型</th><th>开始时间</th><th>结束时间</th><th>时长</th><th>备注</th></tr></thead>
        <tbody>${intervals.map(i => `<tr>
          <td><span class="interval-type ${esc(i.intervalType)}">${esc(TYPE_TEXT[i.intervalType] || i.intervalType)}</span></td>
          <td>${fmtDateTime(i.startAt)}</td><td>${fmtDateTime(i.endAt)}</td>
          <td>${Math.round((Date.parse(i.endAt) - Date.parse(i.startAt)) / 60000)} 分钟</td>
          <td><span class="muted">${esc(i.note || '-')}</span></td></tr>`).join('')
          || '<tr><td colspan="5" style="text-align:center;color:#909399">暂无区间</td></tr>'}</tbody>
      </table></div></section>`;

  document.getElementById('calMachine').onchange = (ev) => { Shared.calendarMachineId = ev.target.value; renderCurrent(); };
  document.getElementById('calAdd').onclick = () => {
    openModal({
      title: `新增不可用区间（${machine.calendarId}）`, okText: '保存',
      body: `
      <div class="form-grid">
        <label class="required">类型</label><select class="field" id="ciType">
          <option value="BREAK">休息（BREAK）</option>
          <option value="HOLIDAY">节假日（HOLIDAY）</option>
          <option value="REPAIR">维修（REPAIR）</option>
        </select>
        <label class="required">开始时间</label><input type="datetime-local" class="field" id="ciStart" value="${isoToLocalInput(new Date(Date.now() + 24 * 3600e3).toISOString())}">
        <label class="required">结束时间</label><input type="datetime-local" class="field" id="ciEnd" value="${isoToLocalInput(new Date(Date.now() + 25 * 3600e3).toISOString())}">
        <label>备注</label><textarea class="field" id="ciNote" placeholder="可选"></textarea>
      </div>
      <p class="hint">区间不可与已有不可用区间重叠；结束时间必须晚于开始时间。保存后对之后创建的排程任务生效。</p>`,
      onOk: async () => {
        const startAt = localInputToIso(document.getElementById('ciStart').value);
        const endAt = localInputToIso(document.getElementById('ciEnd').value);
        if (!startAt || !endAt) { modalError('请填写完整的起止时间'); return false; }
        if (Date.parse(endAt) <= Date.parse(startAt)) { modalError('结束时间必须晚于开始时间'); return false; }
        await Api.addCalendarInterval(machine.calendarId, {
          intervalType: document.getElementById('ciType').value,
          startAt, endAt,
          note: document.getElementById('ciNote').value.trim() || undefined,
        });
        toast('不可用区间已保存');
        renderCurrent();
      },
    });
  };
});

/* ---------------- 工艺模板 ---------------- */
registerPage('templates', ['基础数据', '工艺模板'], async (el) => {
  el.innerHTML = loadingHtml('正在加载工艺模板…');
  let templates, machines;
  try { [templates, machines] = await Promise.all([Api.templates(), Api.machines()]); }
  catch (e) { el.innerHTML = errorBoxHtml(e, '工艺模板加载失败'); return; }
  const machineIds = machines.map(m => m.machineId);

  el.innerHTML = `
    <div class="page-header"><div><h1>工艺模板</h1><p>产品族工艺路线与候选设备；启用前校验工序完整性</p></div>
      <div class="buttons"><button class="btn" onclick="renderCurrent()">&#8635; 刷新</button>
      <button class="btn primary" id="tplAdd" data-roles="ADMIN">+ 新建模板</button></div></div>
    ${templates.map(t => `
    <section class="card table-card section-card">
      <div class="card-title"><span>${esc(t.templateCode)} · ${esc(t.productFamily)} · v${t.templateVersion} ${statusTag(t.status)}</span>
        <span class="buttons">
          <a class="link" data-act="copy" data-id="${esc(t.templateId)}" data-code="${esc(t.templateCode)}">复制新版本</a>
          ${t.status === 'ACTIVE'
            ? `<a class="link" data-act="off" data-id="${esc(t.templateId)}" data-code="${esc(t.templateCode)}" style="color:#e6a23c">停用</a>`
            : `<a class="link" data-act="on" data-id="${esc(t.templateId)}" data-code="${esc(t.templateCode)}" style="color:#67c23a">启用</a>`}
        </span></div>
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>序号</th><th>工序编码</th><th>候选设备（设备 / 准备 / 加工 分钟）</th></tr></thead>
        <tbody>${(t.operations || []).map(o => `<tr><td>${o.sequenceNo}</td><td>${esc(o.operationCode)}</td>
          <td>${(o.defaultCandidates || []).map(c => `<span class="machine-chip">${esc(c.machineId)} · ${c.setupMinutes}/${c.processMinutes}</span>`).join(' ')}</td></tr>`).join('')}</tbody>
      </table></div>
    </section>`).join('')}`;

  const candRowHtml = (c) => `
    <div class="cand-row">
      <select class="field cand-machine">${machineIds.map(id =>
        `<option value="${esc(id)}" ${c && c.machineId === id ? 'selected' : ''}>${esc(id)}</option>`).join('')}</select>
      <input type="number" class="field cand-setup" min="1" placeholder="准备min" value="${c ? c.setupMinutes : 5}">
      <input type="number" class="field cand-process" min="1" placeholder="加工min" value="${c ? c.processMinutes : 30}">
      <button class="icon-btn cand-del" title="删除候选">×</button>
    </div>`;
  const opRowHtml = (seq) => `
    <div class="op-row">
      <input type="number" class="field op-seq" min="1" step="10" placeholder="序号" value="${seq}">
      <input class="field op-code" placeholder="工序名称/编码，如 OP-10 车削">
      <div class="cand-rows">${candRowHtml(null)}</div>
      <button class="icon-btn op-del" title="删除工序">×</button>
    </div>`;

  document.getElementById('tplAdd').onclick = () => {
    openModal({
      title: '新建工艺模板', wide: true, okText: '创建并启用',
      body: `
      <div class="form-grid" style="grid-template-columns:100px 1fr">
        <label class="required">模板编码</label><input class="field" id="tfCode" placeholder="如 TPL-齿轮D">
        <label class="required">产品族</label><input class="field" id="tfFamily" placeholder="如 齿轮D" list="tfFamList">
        <datalist id="tfFamList">${collectFamilies(templates, machines).map(f => `<option value="${esc(f)}">`).join('')}</datalist>
        <label class="required">工序列表</label><div>
          <div class="op-rows" id="tfOps">${opRowHtml(10)}</div>
          <div class="buttons" style="margin-top:8px">
            <button class="btn small" id="tfAddOp" data-roles="ADMIN">+ 添加工序</button>
            <span class="muted">每道工序至少一个候选设备，准备/加工时长均需 &gt; 0</span>
          </div>
        </div>
      </div>`,
      onOk: async () => {
        const templateCode = document.getElementById('tfCode').value.trim();
        const productFamily = document.getElementById('tfFamily').value.trim();
        if (!templateCode || !productFamily) { modalError('请填写模板编码与产品族'); return false; }
        const operations = [];
        for (const row of document.querySelectorAll('#tfOps .op-row')) {
          const sequenceNo = parseInt(row.querySelector('.op-seq').value, 10);
          const operationCode = row.querySelector('.op-code').value.trim();
          if (!sequenceNo || !operationCode) { modalError('每道工序需填写序号与名称'); return false; }
          const defaultCandidates = [];
          for (const cr of row.querySelectorAll('.cand-row')) {
            const setupMinutes = parseInt(cr.querySelector('.cand-setup').value, 10);
            const processMinutes = parseInt(cr.querySelector('.cand-process').value, 10);
            if (!setupMinutes || !processMinutes || setupMinutes <= 0 || processMinutes <= 0) {
              modalError(`工序 ${operationCode} 的准备/加工时长必须为正整数`); return false;
            }
            defaultCandidates.push({ machineId: cr.querySelector('.cand-machine').value, setupMinutes, processMinutes });
          }
          if (!defaultCandidates.length) { modalError(`工序 ${operationCode} 至少需要一个候选设备`); return false; }
          operations.push({ sequenceNo, operationCode, defaultCandidates });
        }
        if (!operations.length) { modalError('至少添加一道工序'); return false; }
        const seqs = operations.map(o => o.sequenceNo).sort((a, b) => a - b);
        for (let i = 1; i < seqs.length; i++) {
          if (seqs[i] === seqs[i - 1]) { modalError('工序序号不能重复'); return false; }
        }
        await Api.createTemplate({ templateCode, productFamily, operations });
        toast('模板 ' + templateCode + ' 已创建并启用');
        renderCurrent();
      },
    });
    // 动态行交互（弹窗渲染后绑定）
    const opsBox = document.getElementById('tfOps');
    document.getElementById('tfAddOp').onclick = (e) => {
      e.preventDefault();
      const seqs = [...opsBox.querySelectorAll('.op-seq')].map(i => parseInt(i.value, 10) || 0);
      opsBox.insertAdjacentHTML('beforeend', opRowHtml((Math.max(...seqs, 0) || 0) + 10));
    };
    opsBox.addEventListener('click', (e) => {
      if (e.target.classList.contains('op-del')) {
        if (opsBox.querySelectorAll('.op-row').length <= 1) { modalError('至少保留一道工序'); return; }
        e.target.closest('.op-row').remove();
      }
      if (e.target.classList.contains('cand-del')) {
        const rows = e.target.closest('.cand-rows');
        if (rows.querySelectorAll('.cand-row').length <= 1) { modalError('每道工序至少保留一个候选设备'); return; }
        e.target.closest('.cand-row').remove();
      }
    });
    opsBox.addEventListener('dblclick', (e) => {
      // 双击工序行的候选区追加一个候选设备
      const rows = e.target.closest('.cand-rows');
      if (rows) rows.insertAdjacentHTML('beforeend', candRowHtml(null));
    });
  };

  el.querySelectorAll('a[data-act]').forEach(a => {
    a.onclick = async () => {
      const { act, id, code } = a.dataset;
      try {
        if (act === 'copy') {
          const r = await Api.copyTemplate(id);
          toast(`已复制为新版本 ${r.templateCode} v${r.templateVersion}（草稿，启用前需校验）`);
          renderCurrent();
        } else if (act === 'on') {
          await Api.setTemplateStatus(id, 'ACTIVE');
          toast(code + ' 已启用');
          renderCurrent();
        } else if (act === 'off') {
          await Api.setTemplateStatus(id, 'INACTIVE');
          toast(code + ' 已停用', 'info');
          renderCurrent();
        }
      } catch (e) { toastErr(e, '操作失败'); }
    };
  });
});

/* ---------------- 订单管理 ---------------- */
registerPage('orders', ['基础数据', '订单管理'], async (el) => {
  el.innerHTML = loadingHtml('正在加载订单…');
  let orders, templates;
  try { [orders, templates] = await Promise.all([Api.orders(), Api.templates()]); }
  catch (e) { el.innerHTML = errorBoxHtml(e, '订单加载失败'); return; }
  const activeTemplates = templates.filter(t => t.status === 'ACTIVE');
  const families = [...new Set(activeTemplates.map(t => t.productFamily))];

  el.innerHTML = `
    <div class="page-header"><div><h1>订单管理</h1><p>生产订单与工序明细；仅未排程（WAITING）订单可编辑</p></div>
      <div class="buttons"><button class="btn" onclick="renderCurrent()">&#8635; 刷新</button>
      <button class="btn primary" id="ordAdd" data-roles="ADMIN">+ 新增订单</button></div></div>
    <section class="card table-card"><div class="table-wrap"><table class="data-table">
      <thead><tr><th></th><th>订单号</th><th>产品族</th><th>数量</th><th>优先级</th><th>到达时间</th><th>交期</th><th>状态</th><th>工序数</th><th>操作</th></tr></thead>
      <tbody>${orders.map((o, i) => `
        <tr class="clickable" data-order="${i}"><td>▸</td><td>${esc(o.orderCode)}</td><td>${esc(o.productFamily)}</td>
          <td>${o.quantity}</td><td>${o.priority}</td><td>${fmtDateTime(o.arrivalAt)}</td><td>${fmtDateTime(o.dueAt)}</td>
          <td>${statusTag(o.status)}</td><td>${(o.operations || []).length}</td>
          <td class="table-actions">${o.status === 'WAITING' ? `<a data-edit="${esc(o.orderId)}">编辑</a>` : ''}</td></tr>
        <tr class="ops-expand is-hidden" id="ops-${i}"><td colspan="10"><table class="data-table">
          <thead><tr><th>工序</th><th>序号</th><th>状态</th><th>候选设备（准备/加工 分钟）</th></tr></thead>
          <tbody>${(o.operations || []).map(op => `<tr><td>${esc(op.operationId)}</td><td>${op.seqNo}</td><td>${statusTag(op.status)}</td>
            <td>${(op.candidates || []).map(c => `<span class="machine-chip">${esc(c.machineId)} ${c.setupMinutes}/${c.processMinutes}</span>`).join(' ')}</td></tr>`).join('')}</tbody>
        </table></td></tr>`).join('')}</tbody>
    </table></div></section>`;

  el.querySelectorAll('tr[data-order]').forEach(tr => {
    tr.onclick = (e) => {
      if (e.target.tagName === 'A') return;
      document.getElementById('ops-' + tr.dataset.order).classList.toggle('is-hidden');
    };
  });

  const tplOptions = (family, selectedId) => activeTemplates.filter(t => t.productFamily === family)
    .map(t => `<option value="${esc(t.templateId)}" ${t.templateId === selectedId ? 'selected' : ''}>${esc(t.templateCode)} v${t.templateVersion}</option>`).join('');

  document.getElementById('ordAdd').onclick = () => {
    if (!families.length) { toast('当前没有启用中的工艺模板，请先在「工艺模板」创建', 'error'); return; }
    openModal({
      title: '新增订单', okText: '创建',
      body: `
      <div class="form-grid">
        <label class="required">订单号</label><input class="field" id="ofCode" value="ORD-${Date.now() % 1000000}">
        <label class="required">产品族</label><select class="field" id="ofFamily">${families.map(f => `<option>${esc(f)}</option>`).join('')}</select>
        <label class="required">工艺模板</label><select class="field" id="ofTpl">${tplOptions(families[0])}</select>
        <label class="required">数量</label><input type="number" class="field" id="ofQty" min="1" value="20">
        <label class="required">优先级</label><input type="number" class="field" id="ofPriority" min="1" max="5" value="3">
        <label class="required">到达时间</label><input type="datetime-local" class="field" id="ofArrival" value="${isoToLocalInput(new Date().toISOString())}">
        <label class="required">交期</label><input type="datetime-local" class="field" id="ofDue" value="${isoToLocalInput(new Date(Date.now() + 48 * 3600e3).toISOString())}">
      </div>
      <p class="hint">创建后按所选模板实例化工序，订单进入待排程（WAITING）状态，可在基线排程中勾选参与。</p>`,
      onOk: async () => {
        const orderCode = document.getElementById('ofCode').value.trim();
        const quantity = parseInt(document.getElementById('ofQty').value, 10);
        const priority = parseInt(document.getElementById('ofPriority').value, 10);
        const arrivalAt = localInputToIso(document.getElementById('ofArrival').value);
        const dueAt = localInputToIso(document.getElementById('ofDue').value);
        if (!orderCode) { modalError('请填写订单号'); return false; }
        if (!quantity || quantity <= 0) { modalError('数量必须是正整数'); return false; }
        if (!priority || priority < 1 || priority > 5) { modalError('优先级必须在 1-5 之间'); return false; }
        if (!arrivalAt || !dueAt) { modalError('请填写到达时间与交期'); return false; }
        if (Date.parse(dueAt) < Date.parse(arrivalAt)) { modalError('交期不能早于到达时间'); return false; }
        const r = await Api.createOrder({
          orderCode, productFamily: document.getElementById('ofFamily').value,
          quantity, priority, arrivalAt, dueAt,
          templateId: document.getElementById('ofTpl').value,
        });
        toast(`订单 ${r.orderCode} 已创建，实例化 ${r.operationIds.length} 道工序`);
        renderCurrent();
      },
    });
    document.getElementById('ofFamily').onchange = (ev) => {
      document.getElementById('ofTpl').innerHTML = tplOptions(ev.target.value);
    };
  };

  el.querySelectorAll('a[data-edit]').forEach(a => {
    a.onclick = () => {
      const o = orders.find(x => x.orderId === a.dataset.edit);
      openModal({
        title: '编辑订单 ' + o.orderCode, okText: '保存',
        body: `
        <div class="form-grid">
          <label>订单号</label><input class="field" value="${esc(o.orderCode)}" disabled>
          <label>产品族</label><input class="field" value="${esc(o.productFamily)}" disabled>
          <label class="required">数量</label><input type="number" class="field" id="efQty" min="1" value="${o.quantity}">
          <label class="required">优先级</label><input type="number" class="field" id="efPriority" min="1" max="5" value="${o.priority}">
          <label class="required">到达时间</label><input type="datetime-local" class="field" id="efArrival" value="${isoToLocalInput(o.arrivalAt)}">
          <label class="required">交期</label><input type="datetime-local" class="field" id="efDue" value="${isoToLocalInput(o.dueAt)}">
        </div>
        <p class="hint">仅未排程订单可编辑；产品族与工艺路线不可变更（会影响已实例化工序）。</p>`,
        onOk: async () => {
          const quantity = parseInt(document.getElementById('efQty').value, 10);
          const priority = parseInt(document.getElementById('efPriority').value, 10);
          const arrivalAt = localInputToIso(document.getElementById('efArrival').value);
          const dueAt = localInputToIso(document.getElementById('efDue').value);
          if (!quantity || quantity <= 0) { modalError('数量必须是正整数'); return false; }
          if (!priority || priority < 1 || priority > 5) { modalError('优先级必须在 1-5 之间'); return false; }
          if (Date.parse(dueAt) < Date.parse(arrivalAt)) { modalError('交期不能早于到达时间'); return false; }
          await Api.updateOrder(o.orderId, { quantity, priority, arrivalAt, dueAt });
          toast('订单 ' + o.orderCode + ' 已更新');
          renderCurrent();
        },
      });
    };
  });
});

/* ---------------- 计划版本 ---------------- */
registerPage('versions', ['计划调度', '计划版本'], async (el) => {
  el.innerHTML = loadingHtml('正在加载版本…');
  let versions, dash;
  try { [versions, dash] = await Promise.all([Api.planVersions(), Api.dashboard()]); Shared.dashboard = dash; }
  catch (e) { el.innerHTML = errorBoxHtml(e, '版本列表加载失败'); return; }
  const currentId = dash.currentPlan && dash.currentPlan.id;
  const byId = Object.fromEntries(versions.map(v => [v.id, v]));
  el.innerHTML = `
    <div class="page-header"><div><h1>计划版本</h1><p>不可变版本账本（GET /plan-versions）</p></div>
      <div class="buttons"><button class="btn" onclick="renderCurrent()">&#8635; 刷新</button></div></div>
    <section class="card table-card"><div class="table-wrap"><table class="data-table">
      <thead><tr><th>版本</th><th>类型</th><th>父版本</th><th>状态</th><th>C_max</th><th>加权拖期</th><th>延期单数</th><th>发布时间</th><th>创建时间</th><th>操作</th></tr></thead>
      <tbody>${versions.map(v => `<tr>
        <td><b>${esc(v.versionCode)}</b>${v.id === currentId ? ' ' + tag('当前发布', 'green') : ''}</td>
        <td>${statusTag(v.candidateType)}</td>
        <td>${v.parentId && byId[v.parentId] ? esc(byId[v.parentId].versionCode) : '-'}</td>
        <td>${statusTag(v.status)}</td>
        <td>${fmtMinutes(v.kpi && v.kpi.cMaxMinutes)}</td>
        <td>${fmtMinutes(v.kpi && v.kpi.weightedTardinessMinutes)}</td>
        <td>${v.kpi ? v.kpi.nTardy : '-'}</td>
        <td>${fmtDateTime(v.publishedAt)}</td>
        <td>${fmtDateTime(v.createdAt)}</td>
        <td class="table-actions">
          <a data-act="gantt" data-id="${esc(v.id)}">甘特</a>
          ${v.parentId ? `<a data-act="compare" data-id="${esc(v.id)}" data-parent="${esc(v.parentId)}">对比</a>` : ''}
          ${v.status === 'DRAFT' ? `<a data-act="submit" data-id="${esc(v.id)}" data-code="${esc(v.versionCode)}">提交审核</a>` : ''}
        </td></tr>`).join('') || '<tr><td colspan="10" style="text-align:center;color:#909399">暂无版本</td></tr>'}</tbody>
    </table></div></section>`;
  el.querySelectorAll('a[data-act]').forEach(a => {
    a.onclick = async () => {
      const { act, id, parent, code } = a.dataset;
      if (act === 'gantt') { Shared.ganttVersionId = id; goTo('resource-gantt'); }
      else if (act === 'compare') { Shared.compareBaselineId = parent; Shared.compareCandidateId = id; goTo('compare'); }
      else if (act === 'submit') {
        try {
          const pv = await Api.planVersion(id);
          await Api.submitReview(id, pv.version);
          toast(code + ' 已提交审核'); renderCurrent();
        } catch (e) { toastErr(e, '提交审核失败'); }
      }
    };
  });
});

/* ---------------- 实际执行 ---------------- */
registerPage('execution', ['执行反馈', '实际执行'], async (el) => {
  el.innerHTML = loadingHtml('正在加载当前执行计划…');
  let dash, orders;
  try { [dash, orders] = await Promise.all([Api.dashboard(), Api.orders()]); Shared.dashboard = dash; }
  catch (e) { el.innerHTML = errorBoxHtml(e, '加载失败'); return; }

  if (!dash.currentPlan) {
    el.innerHTML = `<div class="page-header"><div><h1>实际执行反馈</h1><p>对当前发布计划的工序提交实际执行状态</p></div></div>
      <section class="card"><div class="empty-screen"><div class="empty-symbol">&#9634;</div>
      <h3>暂无执行中的计划</h3><p>发布一个计划版本后才能反馈执行。</p>
      <button class="btn primary" onclick="goTo('review')">去审核发布</button></div></section>`;
    return;
  }

  let plan;
  try { plan = await Api.planVersion(dash.currentPlan.id); }
  catch (e) { el.innerHTML = errorBoxHtml(e, '计划详情加载失败'); return; }

  const opStatus = {};
  orders.forEach(o => (o.operations || []).forEach(op => { opStatus[op.operationId] = op.status; }));
  const ops = (plan.operations || []).slice().sort((a, b) => a.startAt < b.startAt ? -1 : 1);
  const counts = { NOT_STARTED: 0, RUNNING: 0, COMPLETED: 0 };
  ops.forEach(o => { const s = opStatus[o.operationId] || 'NOT_STARTED'; counts[s] = (counts[s] || 0) + 1; });

  el.innerHTML = `
    <div class="page-header"><div><h1>实际执行反馈</h1><p>当前执行计划 ${esc(plan.versionCode)} 的工序执行状态反馈（POST /operations/{id}/execution）</p></div>
      <div class="buttons"><button class="btn" onclick="renderCurrent()">&#8635; 刷新</button></div></div>
    <div class="stat-cards">
      <div class="card stat-card"><span>当前版本</span><b>${esc(plan.versionCode)}</b></div>
      <div class="card stat-card"><span>未开始</span><b>${counts.NOT_STARTED || 0}</b></div>
      <div class="card stat-card"><span>加工中</span><b style="color:#348dd5">${counts.RUNNING || 0}</b></div>
      <div class="card stat-card"><span>已完成</span><b style="color:#67a23c">${counts.COMPLETED || 0}</b></div>
    </div>
    <section class="card table-card"><div class="table-wrap" style="max-height:600px"><table class="data-table">
      <thead><tr><th>工序</th><th>设备</th><th>计划开始</th><th>计划结束</th><th>冻结</th><th>执行状态</th><th>反馈</th></tr></thead>
      <tbody>${ops.map(o => {
        const s = opStatus[o.operationId] || 'NOT_STARTED';
        return `<tr><td>${esc(o.operationId)}</td><td>${esc(o.machineId)}</td>
          <td>${fmtDateTime(o.startAt)}</td><td>${fmtDateTime(o.endAt)}</td>
          <td>${o.frozen ? tag('冻结', 'orange') : '-'}</td><td>${statusTag(s)}</td>
          <td class="table-actions">
            ${s !== 'RUNNING' && s !== 'COMPLETED' ? `<a data-roles="PRODUCTION_MANAGER,ADMIN" data-op="${esc(o.operationId)}" data-st="RUNNING">开工</a>` : ''}
            ${s === 'RUNNING' ? `<a data-roles="PRODUCTION_MANAGER,ADMIN" data-op="${esc(o.operationId)}" data-st="COMPLETED">完工</a>` : ''}
          </td></tr>`;
      }).join('')}</tbody>
    </table></div></section>`;

  el.querySelectorAll('a[data-op]').forEach(a => {
    a.onclick = async () => {
      const now = new Date().toISOString();
      const payload = a.dataset.st === 'RUNNING'
        ? { status: 'RUNNING', actualStartAt: now }
        : { status: 'COMPLETED', actualEndAt: now };
      try {
        await Api.execution(a.dataset.op, payload);
        toast(`工序 ${a.dataset.op} 已反馈 ${a.dataset.st === 'RUNNING' ? '开工' : '完工'}`);
        renderCurrent();
      } catch (e) { toastErr(e, '执行反馈失败'); }
    };
  });
});

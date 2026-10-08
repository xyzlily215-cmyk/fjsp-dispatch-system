/* F-05 批量导入与校验（仅 ADMIN）：下载模板 → 上传预览 → 逐行错误 → 整批入库 */
registerPage('import', ['基础数据', '批量导入'], async (el) => {
  const IMPORT_TYPES = { orders: '生产订单', machines: '设备' };
  const state = { type: 'orders', preview: null };

  el.innerHTML = `
    <div class="page-header"><div><h1>批量导入</h1>
      <p>按模板批量导入订单 / 设备（CSV，UTF-8，≤2MB，≤1000 行）；先预览校验，仅无错误批次可整批入库，失败不产生半批数据</p></div>
      <div class="buttons"><button class="btn" onclick="renderCurrent()">&#8635; 重置</button></div></div>
    <section class="card" style="margin-bottom:14px"><div class="form-grid">
      <label class="required">导入类型</label>
      <select class="field" id="impType">
        ${Object.entries(IMPORT_TYPES).map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}
      </select>
      <label>CSV 模板</label>
      <div><button class="btn" id="impTpl">&#11015; 下载模板</button>
        <span class="muted" style="margin-left:8px">含表头与示例行，表头不可修改</span></div>
      <label class="required">数据文件</label>
      <div><input type="file" class="field" id="impFile" accept=".csv">
        <button class="btn primary" id="impPreviewBtn" style="margin-left:8px">上传预览</button></div>
    </div></section>
    <section id="impResult"></section>`;

  const resultEl = el.querySelector('#impResult');

  el.querySelector('#impType').onchange = (e) => {
    state.type = e.target.value;
    state.preview = null;
    resultEl.innerHTML = '';
    el.querySelector('#impFile').value = '';
  };

  el.querySelector('#impTpl').onclick = async () => {
    try { await Api.importTemplate(state.type); } catch (e) { toastErr(e, '模板下载失败'); }
  };

  el.querySelector('#impPreviewBtn').onclick = async () => {
    const file = el.querySelector('#impFile').files[0];
    if (!file) { toast('请先选择 CSV 文件', 'error'); return; }
    state.preview = null;
    resultEl.innerHTML = loadingHtml('正在预检与逐行校验…');
    try {
      state.preview = await Api.importPreview(state.type, file);
      renderPreview();
    } catch (e) {
      resultEl.innerHTML = errorBoxHtml(e, '预检未通过');
    }
  };

  function renderPreview() {
    const d = state.preview;
    const errors = d.errors || [];
    const shown = errors.slice(0, 200);
    resultEl.innerHTML = `
      <div class="card">
        <div style="display:flex;gap:18px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
          <span>批次号 <b>${esc(d.batchCode)}</b></span>
          <span class="muted">文件 ${esc(d.fileName || '-')}</span>
          <span class="muted">SHA-256 ${esc(String(d.fileSha256 || '').slice(0, 16))}…</span>
          <span>总行数 <b>${d.totalRows}</b></span>
          <span style="color:#67c23a">成功 <b>${d.successRows}</b></span>
          <span style="color:${d.errorRows ? '#f56c6c' : 'inherit'}">错误 <b>${d.errorRows}</b></span>
        </div>
        ${errors.length ? `
          <div class="table-wrap"><table class="data-table">
            <thead><tr><th>行号</th><th>错误码</th><th>字段</th><th>原值</th><th>修正建议</th></tr></thead>
            <tbody>${shown.map(err => `<tr>
              <td>${err.row}</td><td>${tag(err.code, 'red')}</td><td>${esc(err.field)}</td>
              <td>${esc(err.value)}</td><td>${esc(err.suggestion)}</td></tr>`).join('')}</tbody>
          </table></div>
          ${errors.length > shown.length ? `<p class="muted">仅展示前 ${shown.length} 条错误，共 ${errors.length} 条</p>` : ''}
          <p class="muted">存在错误行，禁止入库；请修正后重新上传预览。</p>`
        : `<p style="color:#67c23a">全部 ${d.totalRows} 行校验通过，可整批入库。</p>
           <button class="btn primary" id="impCommitBtn">确认入库 ${d.totalRows} 行</button>`}
      </div>`;

    const commitBtn = resultEl.querySelector('#impCommitBtn');
    if (commitBtn) {
      commitBtn.onclick = async () => {
        commitBtn.disabled = true;
        try {
          const r = await Api.importCommit(state.type, d.batchCode);
          if (r.status === 'COMMITTED') {
            toast(`批次 ${r.batchCode} 已整批入库 ${r.committedRows} 行`);
            renderCurrent();
          } else {
            state.preview = { ...d, errorRows: (r.errors || []).length, errors: r.errors || [] };
            renderPreview();
            toast('提交复检未通过，批次已标记失败，请修正后重新导入', 'error');
          }
        } catch (e) {
          commitBtn.disabled = false;
          toastErr(e, '入库失败');
        }
      };
    }
  }
});

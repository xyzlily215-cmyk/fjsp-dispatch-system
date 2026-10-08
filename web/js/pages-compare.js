/* 方案对比：基准 + 候选版本 -> GET /plan-versions/{id}/diff */
registerPage('compare', ['结果分析', '方案对比'], async (el) => {
  el.innerHTML = loadingHtml('正在加载版本列表…');
  let versions;
  try { versions = await Api.planVersions(); }
  catch (e) { el.innerHTML = errorBoxHtml(e, '版本列表加载失败'); return; }

  if (versions.length < 1) {
    el.innerHTML = `<div class="page-header"><div><h1>方案对比</h1><p>对比两个计划版本的逐工序差异</p></div></div>
      <section class="card"><div class="empty-screen"><h3>暂无计划版本</h3><p>先创建基线排程。</p></div></section>`;
    return;
  }

  let baselineId = Shared.compareBaselineId;
  let candidateId = Shared.compareCandidateId;
  if (!versions.some(v => v.id === candidateId)) candidateId = versions[0].id;
  if (!versions.some(v => v.id === baselineId)) {
    const cand = versions.find(v => v.id === candidateId);
    baselineId = (cand && cand.parentId && versions.some(v => v.id === cand.parentId))
      ? cand.parentId
      : (versions.find(v => v.id !== candidateId) || {}).id;
  }

  const sel = (id, list, cur) => `<select class="field wide" id="${id}">${list.map(v =>
    `<option value="${esc(v.id)}" ${v.id === cur ? 'selected' : ''}>${esc(v.versionCode)} · ${esc(v.status)} · ${fmtDateTime(v.createdAt)}</option>`).join('')}</select>`;

  const headHtml = `
    <div class="page-header"><div><h1>方案对比</h1><p>基准版本与候选版本的 KPI 与逐工序差异</p></div>
      <div class="buttons"><button class="btn" id="cmpRun">开始对比</button><button class="btn" id="cmpExport">导出候选版本 CSV</button></div></div>
    <section class="card section-card"><div class="toolbar"><div class="filters">
      <span class="filter-label">基准版本</span>${sel('cmpBaseline', versions, baselineId)}
      <span class="filter-label" style="margin-left:10px">候选版本</span>${sel('cmpCandidate', versions, candidateId)}
    </div></div>
    <div id="cmpResult">${baselineId && candidateId && baselineId !== candidateId ? loadingHtml('正在计算差异…') : '<div class="empty-screen" style="padding:30px">请选择两个不同的版本进行对比</div>'}</div>
    </section>`;
  el.innerHTML = headHtml;

  const bind = () => {
    document.getElementById('cmpRun').onclick = () => {
      Shared.compareBaselineId = document.getElementById('cmpBaseline').value;
      Shared.compareCandidateId = document.getElementById('cmpCandidate').value;
      renderCurrent();
    };
    document.getElementById('cmpExport').onclick = async () => {
      try {
        await Api.exportPlanVersion(document.getElementById('cmpCandidate').value);
        toast('CSV 已开始下载');
      } catch (e) { toastErr(e, '导出失败'); }
    };
  };
  bind();

  if (!baselineId || !candidateId || baselineId === candidateId) return;

  let diff, candVer;
  try {
    [diff, candVer] = await Promise.all([Api.diff(candidateId, baselineId), Api.planVersion(candidateId)]);
  } catch (e) {
    document.getElementById('cmpResult').innerHTML = errorBoxHtml(e, '差异计算失败');
    return;
  }

  const s = diff.summary || {};
  const kd = diff.kpiDiff || {};
  const kpi = candVer.kpi || {};
  const delta = kpi.deltaPlan ? kpi.deltaPlan.deltaPlan : null;
  const deltaCls = (v, invert = true) => {
    if (v === null || v === undefined || v === 0) return '<em class="good">±0</em>';
    const better = invert ? v < 0 : v > 0;
    return `<em class="${better ? 'good' : 'bad'}">${v > 0 ? '+' : ''}${typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(3) : v}</em>`;
  };

  const score = (label, value, diffVal) => `
    <div class="compare-score"><label>${label}</label><b>${value}</b><br>${diffVal}</div>`;

  const changeTag = (o) => {
    const tags = [];
    if (o.machineChanged) tags.push(tag('换机', 'red'));
    if (o.sequenceChanged) tags.push(tag('顺序变化', 'orange'));
    if (o.timeShiftMinutes) tags.push(tag(`偏移 ${o.timeShiftMinutes > 0 ? '+' : ''}${o.timeShiftMinutes}min`, 'blue'));
    if (o.isAdded) tags.push(tag('新增', 'green'));
    if (!tags.length) tags.push(tag('不变', 'gray'));
    return tags.join(' ');
  };

  const changedOps = (diff.operations || []).filter(o =>
    o.timeShiftMinutes || o.machineChanged || o.sequenceChanged || o.frozen || o.impactType);
  const addedSet = new Set(s.addedOperations || []);
  const removedSet = new Set(s.removedOperations || []);
  const rows = changedOps.map(o => `
    <tr>
      <td>${esc(o.operationId)}${addedSet.has(o.operationId) ? ' ' + tag('新增', 'green') : ''}${o.frozen ? ' ' + tag('冻结', 'orange') : ''}</td>
      <td>${esc(o.oldMachineId || '-')}<br><span class="muted">${fmtDateTime(o.oldStartAt)}</span></td>
      <td>${esc(o.newMachineId || '-')}<br><span class="muted">${fmtDateTime(o.newStartAt)}</span></td>
      <td>${changeTag(o)}</td>
      <td>${o.impactType ? tag(impactText(o.impactType), 'purple') : '<span class="muted">-</span>'}${o.reasonCode ? `<br><span class="muted">${esc(reasonText(o.reasonCode))}</span>` : ''}</td>
      <td>${o.frozen ? tag('冻结未动', 'gray') : (o.timeShiftMinutes || o.machineChanged || o.sequenceChanged ? tag('已调整', 'blue') : tag('保持', 'green'))}</td>
    </tr>`).join('');

  document.getElementById('cmpResult').innerHTML = `
    <div class="compare-top">
      ${score('总完工时间 C_max', fmtMinutes(kpi.cMaxMinutes), deltaCls(kd.cMaxMinutes != null ? kd.cMaxMinutes / 60 : null))}
      ${score('加权拖期', fmtMinutes(kpi.weightedTardinessMinutes), deltaCls(kd.weightedTardinessMinutes != null ? kd.weightedTardinessMinutes / 60 : null))}
      ${score('延期订单数', (kpi.nTardy ?? '-') + ' 单', deltaCls(kd.nTardy))}
      ${score('计划扰动 Δ_plan', delta !== null ? delta.toFixed(3) : '-', `<em>${s.timeShiftedCount || 0} 偏移 / ${s.machineChangedCount || 0} 换机 / ${s.sequenceChangedCount || 0} 顺序</em>`)}
    </div>
    <div class="section-pad" style="border-bottom:1px solid #ebeef5">
      <span class="muted">对比 ${esc(diff.baselineVersionCode)} → ${esc(diff.candidateVersionCode)}：共 ${s.comparedOperations ?? '-'} 道工序，
      新增 ${(s.addedOperations || []).length} 道，移除 ${(s.removedOperations || []).length} 道，发生变化 ${changedOps.length} 道。</span>
      ${removedSet.size ? `<div class="error-box" style="margin:10px 0 0">移除工序：${esc([...removedSet].join('、'))}</div>` : ''}
    </div>
    <div class="table-wrap"><table class="data-table">
      <thead><tr><th>工序</th><th>原计划（${esc(diff.baselineVersionCode)}）</th><th>候选方案（${esc(diff.candidateVersionCode)}）</th><th>变更类型</th><th>影响原因</th><th>状态</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6" style="text-align:center;color:#909399">两个版本的工序计划完全一致</td></tr>'}</tbody>
    </table></div>
    <div id="cmpGroup"></div>`;

  /* F-08：同候选组（局部/完全重调度）并列比较，异步填充，不阻塞主差异渲染 */
  renderCandidateGroup(versions, candVer, baselineId, diff);
});

/* 同 candidateGroupId 的候选方案（局部/完全）并列：KPI、计划扰动与变更规模相对同一基准版本比较 */
async function renderCandidateGroup(versions, candVer, baselineId, candDiff) {
  const box = document.getElementById('cmpGroup');
  if (!box || !candVer || !candVer.candidateGroupId) return;
  const members = versions.filter(v => v.candidateGroupId === candVer.candidateGroupId).slice(0, 4);
  if (members.length < 2) return;
  box.innerHTML = `<div class="section-pad" style="border-top:1px solid #ebeef5">
    <h3 style="margin:0 0 10px;font-size:15px">同候选组并列比较（${esc(candVer.candidateGroupId)}）</h3>
    <div id="cmpGroupTable">${loadingHtml('正在计算组内差异…')}</div></div>`;
  const rows = [];
  for (const v of members) {
    if (v.id === candVer.id) { rows.push({ v, d: candDiff }); continue; }
    try { rows.push({ v, d: await Api.diff(v.id, baselineId) }); }
    catch (e) { rows.push({ v, error: e }); }
  }
  const tableEl = document.getElementById('cmpGroupTable');
  if (!tableEl) return;
  const kpiOf = (v) => v.kpi || {};
  const dPlanOf = (v) => kpiOf(v).deltaPlan ? kpiOf(v).deltaPlan.deltaPlan : null;
  tableEl.innerHTML = `<div class="table-wrap"><table class="data-table">
    <thead><tr><th>版本</th><th>候选类型</th><th>状态</th><th>C_max</th><th>加权拖期</th><th>延期订单</th><th>Δ_plan</th><th>偏移/换机/顺序</th><th>操作</th></tr></thead>
    <tbody>${rows.map(({ v, d, error }) => {
      const sm = (d && d.summary) || {};
      return `<tr>
      <td>${esc(v.versionCode)}${v.id === candVer.id ? ' ' + tag('当前选中', 'blue') : ''}</td>
      <td>${v.candidateType ? statusTag(v.candidateType) : '-'}</td>
      <td>${statusTag(v.status)}</td>
      ${error ? `<td colspan="5">${errorBoxHtml(error, '差异计算失败')}</td>` : `
      <td>${fmtMinutes(kpiOf(v).cMaxMinutes)}</td>
      <td>${fmtMinutes(kpiOf(v).weightedTardinessMinutes)}</td>
      <td>${kpiOf(v).nTardy ?? '-'}</td>
      <td>${dPlanOf(v) !== null ? dPlanOf(v).toFixed(3) : '-'}</td>
      <td><span class="muted">${sm.timeShiftedCount || 0} / ${sm.machineChangedCount || 0} / ${sm.sequenceChangedCount || 0}</span></td>`}
      <td>${v.id === candVer.id ? '<span class="muted">-</span>' : `<button class="btn small" data-cmp-pick="${esc(v.id)}">设为候选</button>`}</td>
    </tr>`;
    }).join('')}</tbody></table></div>`;
  box.querySelectorAll('[data-cmp-pick]').forEach(b => {
    b.onclick = () => { Shared.compareCandidateId = b.dataset.cmpPick; renderCurrent(); };
  });
}

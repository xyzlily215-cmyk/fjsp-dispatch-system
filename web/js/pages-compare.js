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
    <div class="page-header"><div><h1>方案对比</h1><p>基准版本与候选版本的 KPI 与逐工序差异（GET /plan-versions/{id}/diff）</p></div>
      <div class="buttons"><button class="btn" id="cmpRun">开始对比</button></div></div>
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
    </table></div>`;
});

/* 审核发布：REVIEW_PENDING 列表 -> 对比 / 通过 / 驳回 / 发布 */
registerPage('review', ['审核发布', '待审核方案'], async (el) => {
  el.innerHTML = loadingHtml('正在加载审核队列…');
  let versions;
  try { versions = await Api.planVersions(); }
  catch (e) { el.innerHTML = errorBoxHtml(e, '版本列表加载失败'); return; }

  const queue = versions.filter(v => v.status === 'REVIEW_PENDING' || v.status === 'REVIEWED' || v.status === 'REJECTED');
  const byId = Object.fromEntries(versions.map(v => [v.id, v]));

  el.innerHTML = `
    <div class="page-header"><div><h1>待审核方案</h1><p>审核候选计划版本并发布为车间执行计划</p></div>
      <div class="buttons"><button class="btn" id="rvRefresh">&#8635; 刷新队列</button></div></div>
    <div class="task-center">
      <section class="card task-queue">
        <div class="task-queue-head"><h2>审批队列</h2><p>${queue.length} 项待处理</p></div>
        <div class="task-queue-list" id="rvList">${queue.length ? queue.map((v, i) => `
          <button class="task-queue-item ${i === 0 ? 'active' : ''}" data-v="${esc(v.id)}">
            <b>${esc(v.versionCode)}</b>${statusTag(v.status)}
            <span>${statusTag(v.candidateType)} ${fmtDateTime(v.createdAt)}</span>
          </button>`).join('') : '<div class="empty-screen" style="padding:30px">暂无待审核方案</div>'}</div>
      </section>
      <section class="card task-detail" id="rvDetail">${queue.length ? loadingHtml('加载版本详情…') : '<div class="empty-screen">没有需要处理的方案</div>'}</section>
    </div>`;

  document.getElementById('rvRefresh').onclick = () => renderCurrent();
  el.querySelectorAll('#rvList .task-queue-item').forEach(b => {
    b.onclick = () => {
      el.querySelectorAll('#rvList .task-queue-item').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      loadDetail(b.dataset.v);
    };
  });

  async function loadDetail(id) {
    const box = document.getElementById('rvDetail');
    box.innerHTML = loadingHtml('加载版本详情…');
    let v;
    try { v = await Api.planVersion(id); }
    catch (e) { box.innerHTML = errorBoxHtml(e, '版本详情加载失败'); return; }
    const parent = v.parentId ? byId[v.parentId] : null;
    const kpi = v.kpi || {};
    const stage = (label, done, active) => `<div class="stage-node" style="flex:1;text-align:center;padding:8px 0;border-bottom:3px solid ${active ? '#409eff' : done ? '#67c23a' : '#ebeef5'}">
      <b style="display:block;font-size:13px;color:${active ? '#409eff' : done ? '#67c23a' : '#909399'}">${label}</b></div>`;
    const statusFlow = ['DRAFT', 'REVIEW_PENDING', 'REVIEWED', 'PUBLISHED/EXECUTING'];
    const pos = statusFlow.findIndex(s => v.status === s || (s === 'PUBLISHED/EXECUTING' && (v.status === 'PUBLISHED' || v.status === 'EXECUTING')));
    box.innerHTML = `
      <div class="task-detail-head">
        <div><h2>${esc(v.versionCode)}</h2><p>${statusTag(v.candidateType)} 创建于 ${fmtDateTime(v.createdAt)}${parent ? ' · 基于 ' + esc(parent.versionCode) : ''}</p></div>
        ${statusTag(v.status)}
      </div>
      <div style="display:flex;gap:14px;padding:12px 20px;border-bottom:1px solid #ebeef5">
        ${statusFlow.map((s, i) => stage(s.replace('_', ' '), i < pos, i === pos)).join('')}
      </div>
      <div class="section-pad">
        <div class="task-overview-grid">
          <div class="task-overview-block"><span>总完工时间 C_max</span><b>${fmtMinutes(kpi.cMaxMinutes)}</b></div>
          <div class="task-overview-block"><span>加权拖期</span><b>${fmtMinutes(kpi.weightedTardinessMinutes)}</b></div>
          <div class="task-overview-block"><span>延期订单数</span><b>${kpi.nTardy ?? '-'}</b></div>
          <div class="task-overview-block"><span>计划扰动 Δ_plan</span><b>${kpi.deltaPlan ? kpi.deltaPlan.deltaPlan.toFixed(3) : '-'}</b></div>
          <div class="task-overview-block"><span>乐观锁版本号</span><b>${v.version}</b></div>
          <div class="task-overview-block"><span>工序数</span><b>${(v.operations || []).length}</b></div>
        </div>
        ${v.reviewComment ? `<div class="info-box"><b>审核意见</b>${esc(v.reviewComment)}</div>` : ''}
        <div id="rvMsg"></div>
        <div class="review-actions" style="margin-top:16px">
          <input class="field" id="rvComment" placeholder="审核意见（驳回时必填）">
          ${v.parentId ? '<button class="btn" id="rvCompare">查看对比</button>' : ''}
          <button class="btn" id="rvGantt">查看甘特</button>
          ${v.status === 'REVIEW_PENDING' ? '<button class="btn primary" id="rvApprove">通过</button><button class="btn danger" id="rvReject">驳回</button>' : ''}
          ${v.status === 'REVIEWED' ? '<button class="btn primary" id="rvPublish">发布</button>' : ''}
          ${v.status === 'REJECTED' ? '<button class="btn primary" id="rvRevise">修改重提</button>' : ''}
        </div>
      </div>`;

    const msg = (html) => { document.getElementById('rvMsg').innerHTML = html; };
    const cmp = document.getElementById('rvCompare');
    if (cmp) cmp.onclick = () => { Shared.compareBaselineId = v.parentId; Shared.compareCandidateId = v.id; goTo('compare'); };
    document.getElementById('rvGantt').onclick = () => { Shared.ganttVersionId = v.id; goTo('resource-gantt'); };

    const ap = document.getElementById('rvApprove');
    if (ap) ap.onclick = async () => {
      try {
        await Api.review(v.id, { decision: 'APPROVE', comment: document.getElementById('rvComment').value.trim(), version: v.version });
        toast(v.versionCode + ' 已审核通过'); renderCurrent();
      } catch (e) { msg(errorBoxHtml(e, '审核失败')); }
    };
    const rj = document.getElementById('rvReject');
    if (rj) rj.onclick = async () => {
      const comment = document.getElementById('rvComment').value.trim();
      if (!comment) { msg('<div class="error-box">驳回前必须填写审核意见</div>'); return; }
      try {
        await Api.review(v.id, { decision: 'REJECT', comment, version: v.version });
        toast(v.versionCode + ' 已驳回', 'info'); renderCurrent();
      } catch (e) { msg(errorBoxHtml(e, '驳回失败')); }
    };
    const pb = document.getElementById('rvPublish');
    if (pb) pb.onclick = async () => {
      try {
        const before = Shared.dashboard && Shared.dashboard.currentPlan ? Shared.dashboard.currentPlan.versionCode : null;
        await Api.publish(v.id, v.version);
        toast(`发布成功：${before ? before + ' → ' : ''}${v.versionCode} 已成为当前执行计划`);
        await refreshShared(); renderCurrent();
      } catch (e) { msg(errorBoxHtml(e, '发布失败')); }
    };
    const reviseBtn = document.getElementById('rvRevise');
    if (reviseBtn) reviseBtn.onclick = async () => {
      try {
        await Api.revise(v.id, v.version);
        toast(v.versionCode + ' 已退回草稿，可修改后重新提交审核', 'info');
        renderCurrent();
      } catch (e) { msg(errorBoxHtml(e, '退回修改失败')); }
    };
  }

  if (queue.length) await loadDetail(queue[0].id);
});

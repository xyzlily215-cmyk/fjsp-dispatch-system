/* 工具函数：时间格式化（Asia/Shanghai）、toast、tag、HTML 转义等 */
const TZ = 'Asia/Shanghai';

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtTime(iso, withSeconds) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  const f = new Intl.DateTimeFormat('zh-CN', {
    timeZone: TZ, month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', ...(withSeconds ? { second: '2-digit' } : {}), hour12: false,
  });
  return f.format(d).replace(/\//g, '-');
}

function fmtDateTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  const f = new Intl.DateTimeFormat('zh-CN', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  return f.format(d).replace(/\//g, '-');
}

function fmtHM(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (isNaN(d)) return '-';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}

function fmtMinutes(min) {
  if (min === null || min === undefined) return '-';
  const h = min / 60;
  return (Math.round(h * 10) / 10) + 'h';
}

function fmtPct(x, digits = 1) {
  if (x === null || x === undefined) return '-';
  return (x * 100).toFixed(digits) + '%';
}

/* datetime-local input value -> ISO Zulu string */
function localInputToIso(v) {
  if (!v) return null;
  return new Date(v).toISOString();
}
/* ISO -> datetime-local input value (Asia/Shanghai 墙钟) */
function isoToLocalInput(iso) {
  if (!iso) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(iso));
  const get = t => parts.find(p => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

let toastTimer = null;
function toast(msg, type = 'success') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (type === 'error' ? ' error' : type === 'info' ? ' info' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 3200);
}

function errMsg(e) { return e && e.message ? e.message : String(e); }

function toastErr(e, prefix) {
  toast((prefix ? prefix + '：' : '') + errMsg(e), 'error');
}

function loadingHtml(text = '加载中…') {
  return `<div class="loading-block"><div class="spin"></div><div>${esc(text)}</div></div>`;
}

function errorBoxHtml(e, title = '请求失败') {
  const code = e && e.code ? ` <span class="pill">${esc(e.code)}</span>` : '';
  return `<div class="error-box"><b>${esc(title)}${code}</b>${esc(errMsg(e))}</div>`;
}

const STATUS_TAGS = {
  PENDING: ['gray', '排队中'], RUNNING: ['blue', '求解中'], SUCCESS: ['green', '成功'],
  INFEASIBLE: ['red', '无可行解'], TIME_LIMIT: ['orange', '达到时间上限'], FAILED: ['red', '失败'],
  DRAFT: ['gray', '草稿'], REVIEW_PENDING: ['orange', '待审核'], REVIEWED: ['blue', '已审核'],
  PUBLISHED: ['purple', '已发布'], EXECUTING: ['green', '执行中'], SUPERSEDED: ['gray', '已替代'],
  REJECTED: ['red', '已驳回'],
  ACTIVE: ['green', '正常'], DOWN: ['red', '故障'], MAINTENANCE: ['orange', '维护中'],
  SCHEDULED: ['blue', '已排程'], WAITING: ['gray', '待排程'], COMPLETED: ['green', '已完成'],
  NOT_STARTED: ['gray', '未开始'], CONFIRMED: ['orange', '已确认'], USED_FOR_SOLVE: ['green', '已用于求解'],
  BASELINE: ['blue', '基线排程'], LOCAL_RESCHEDULE: ['orange', '局部重调度'], FULL_RESCHEDULE: ['red', '完全重调度'],
  LOCAL: ['orange', '局部重调度'], FULL: ['red', '完全重调度'],
  BREAKDOWN: ['red', '设备故障'], NEW_ORDER: ['blue', '新订单'], URGENT_INSERT: ['red', '紧急插单'], NORMAL_APPEND: ['blue', '常规追加'],
};

function tag(text, color = 'gray') { return `<span class="tag ${color}">${esc(text)}</span>`; }
function statusTag(status) {
  const [color, text] = STATUS_TAGS[status] || ['gray', status || '-'];
  return tag(text, color);
}

const IMPACT_TYPE_TEXT = {
  MACHINE_BREAKDOWN: '故障设备工序', SAME_MACHINE_CONFLICT: '同机时间冲突', SUCCESSOR: '后继工序',
  NEW_ORDER: '新订单工序', FROZEN: '冻结', PRECEDENCE: '工艺顺序',
};
function impactText(t) { return IMPACT_TYPE_TEXT[t] || t || '-'; }

const REASON_TEXT = {
  BREAKDOWN_OVERLAP: '与维修区间冲突', MACHINE_DOWN: '设备停机', FROZEN_WINDOW: '冻结窗口',
  NEW_ORDER: '新订单插入', SUCCESSOR_SHIFT: '前序偏移',
};
function reasonText(r) { return REASON_TEXT[r] || r || '-'; }

/* ---------------- 弹窗（复用原型 modal-mask/modal/form-grid 样式） ----------------
 * openModal({ title, body, okText, wide, onOk })
 * body 为 HTML 字符串；onOk 返回 false 或抛错则不关闭弹窗，错误显示在弹窗内。
 */
function openModal({ title, body, okText = '确定', wide = false, onOk }) {
  const mask = document.getElementById('modalMask');
  mask.innerHTML = `
    <div class="modal${wide ? ' wide' : ''}">
      <div class="modal-head"><span>${esc(title)}</span><button class="close" id="modalClose">×</button></div>
      <div class="modal-body">${body}<div id="modalErr"></div></div>
      <div class="modal-foot">
        <button class="btn" id="modalCancel">取消</button>
        <button class="btn primary" id="modalOk">${esc(okText)}</button>
      </div>
    </div>`;
  mask.classList.add('open');
  const close = () => { mask.classList.remove('open'); mask.innerHTML = ''; };
  document.getElementById('modalClose').onclick = close;
  document.getElementById('modalCancel').onclick = close;
  mask.onmousedown = (e) => { if (e.target === mask) close(); };
  document.getElementById('modalOk').onclick = async () => {
    const errEl = document.getElementById('modalErr');
    errEl.innerHTML = '';
    const btn = document.getElementById('modalOk');
    btn.disabled = true;
    try {
      const r = await onOk();
      if (r === false) { btn.disabled = false; return; }
      close();
    } catch (e) {
      errEl.innerHTML = errorBoxHtml(e, '操作失败');
      btn.disabled = false;
    }
  };
  return { close, errEl: () => document.getElementById('modalErr') };
}

function modalError(msg) {
  const errEl = document.getElementById('modalErr');
  if (errEl) errEl.innerHTML = `<div class="error-box">${esc(msg)}</div>`;
}

/* ---------------- 分页组件（Page 包络 {items,page,size,total,totalPages}） ----------------
 * pagerHtml(pageObj) 渲染上一页/下一页 + 页码/总数；
 * bindPager(container, onPageDelta) 绑定翻页回调（delta = -1/+1）。
 */
function pagerHtml(p) {
  const totalPages = p.totalPages || 0;
  return `<div class="pager">
    <button class="btn small" data-pager="prev" ${p.page <= 0 ? 'disabled' : ''}>上一页</button>
    <span class="muted">第 ${totalPages === 0 ? 0 : p.page + 1} / ${totalPages} 页 · 共 ${p.total} 条</span>
    <button class="btn small" data-pager="next" ${p.page >= totalPages - 1 ? 'disabled' : ''}>下一页</button>
  </div>`;
}

function bindPager(container, onPageDelta) {
  container.querySelectorAll('[data-pager]').forEach(b => {
    if (!b.disabled) b.onclick = () => onPageDelta(b.dataset.pager === 'prev' ? -1 : 1);
  });
}

/* 纯函数工具：时间格式化（Asia/Shanghai）、状态映射等（自旧版 web/js/util.js 移植） */
export const TZ = 'Asia/Shanghai';

export function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function fmtTime(iso, withSeconds) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  const f = new Intl.DateTimeFormat('zh-CN', {
    timeZone: TZ, month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', ...(withSeconds ? { second: '2-digit' } : {}), hour12: false,
  });
  return f.format(d).replace(/\//g, '-');
}

export function fmtDateTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  const f = new Intl.DateTimeFormat('zh-CN', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  return f.format(d).replace(/\//g, '-');
}

export function fmtHM(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (isNaN(d)) return '-';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}

export function fmtMinutes(min) {
  if (min === null || min === undefined) return '-';
  const h = min / 60;
  return (Math.round(h * 10) / 10) + 'h';
}

export function fmtPct(x, digits = 1) {
  if (x === null || x === undefined) return '-';
  return (x * 100).toFixed(digits) + '%';
}

/* datetime-local input value -> ISO Zulu string（按 Asia/Shanghai 墙钟解析，与 fmtTime/fmtDateTime 展示时区一致） */
export function localInputToIso(v) {
  if (!v) return null;
  return new Date(v.length === 16 ? v + ':00+08:00' : v + '+08:00').toISOString();
}
/* ISO -> datetime-local input value (Asia/Shanghai 墙钟) */
export function isoToLocalInput(iso) {
  if (!iso) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(iso));
  const get = t => parts.find(p => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

export function errMsg(e) { return e && e.message ? e.message : String(e); }

export const STATUS_TAGS = {
  PENDING: ['gray', '排队中'], RUNNING: ['blue', '求解中'], SUCCESS: ['green', '成功'],
  INFEASIBLE: ['red', '无可行解'], TIME_LIMIT: ['orange', '达到时间上限'], FAILED: ['red', '失败'],
  RETRY_WAIT: ['orange', '等待重试'], CANCELLED: ['gray', '已取消'],
  DRAFT: ['gray', '草稿'], REVIEW_PENDING: ['orange', '待审核'], REVIEWED: ['blue', '已审核'],
  PUBLISHED: ['purple', '已发布'], EXECUTING: ['green', '执行中'], SUPERSEDED: ['gray', '已替代'],
  REJECTED: ['red', '已驳回'],
  ACTIVE: ['green', '正常'], DOWN: ['red', '故障'], MAINTENANCE: ['orange', '维护中'],
  SCHEDULED: ['blue', '已排程'], WAITING: ['gray', '待排程'], COMPLETED: ['green', '已完成'],
  NOT_STARTED: ['gray', '未开始'], PAUSED: ['orange', '已暂停'], RESUMED: ['blue', '已恢复'],
  EXCEPTION: ['red', '异常'], EXECUTION_DEVIATION: ['red', '执行偏差'],
  CONFIRMED: ['orange', '已确认'], USED_FOR_SOLVE: ['green', '已用于求解'],
  CREATED: ['gray', '已录入'], CLOSED: ['gray', '已关闭'],
  BASELINE: ['blue', '基线排程'], LOCAL_RESCHEDULE: ['orange', '局部重调度'], FULL_RESCHEDULE: ['red', '完全重调度'],
  LOCAL: ['orange', '局部重调度'], FULL: ['red', '完全重调度'], ROLLBACK: ['purple', '回滚'],
  BREAKDOWN: ['red', '设备故障'], NEW_ORDER: ['blue', '新订单'], URGENT_INSERT: ['red', '紧急插单'], NORMAL_APPEND: ['blue', '常规追加'],
};

export function statusTagInfo(status) {
  return STATUS_TAGS[status] || ['gray', status || '-'];
}

const IMPACT_TYPE_TEXT = {
  MACHINE_BREAKDOWN: '故障设备工序', SAME_MACHINE_CONFLICT: '同机时间冲突', SUCCESSOR: '后继工序',
  NEW_ORDER: '新订单工序', FROZEN: '冻结', PRECEDENCE: '工艺顺序',
};
export function impactText(t) { return IMPACT_TYPE_TEXT[t] || t || '-'; }

const REASON_TEXT = {
  BREAKDOWN_OVERLAP: '与维修区间冲突', MACHINE_DOWN: '设备停机', FROZEN_WINDOW: '冻结窗口',
  NEW_ORDER: '新订单插入', SUCCESSOR_SHIFT: '前序偏移',
};
export function reasonText(r) { return REASON_TEXT[r] || r || '-'; }

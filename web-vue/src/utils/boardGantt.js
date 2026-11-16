/* 调度看板甘特缩略条：把计划工序按设备分泳道，换算成相对时间窗的百分比位置（纯函数便于测试）。 */

const orderKey = (op) => op.orderId || String(op.operationId || '').split('-').slice(0, -1).join('-');

/**
 * @param ops       计划工序 [{ operationId, orderId?, orderCode?, machineId, startAt, endAt }]
 * @param machines  设备列表 [{ machineId }]，决定泳道顺序；工序里出现但列表没有的设备追加在末尾
 * @param nowMs     当前时刻（毫秒），落在窗口内时给出 nowPct
 * @returns { lanes: [{ machineId, bars: [{ key, left, width, orderKey, label, startAt, endAt }] }], start, end, nowPct, orders }
 */
export function buildGanttStrip(ops = [], machines = [], nowMs = Date.now()) {
  const valid = ops.filter(o => o.machineId && Number.isFinite(Date.parse(o.startAt)) && Number.isFinite(Date.parse(o.endAt)));
  if (!valid.length) return { lanes: [], start: null, end: null, nowPct: null, orders: [] };

  const start = Math.min(...valid.map(o => Date.parse(o.startAt)));
  const end = Math.max(...valid.map(o => Date.parse(o.endAt)));
  const span = Math.max(1, end - start);
  const pct = (t) => ((t - start) / span) * 100;

  const order = machines.map(m => m.machineId);
  for (const o of valid) if (!order.includes(o.machineId)) order.push(o.machineId);
  const lanes = order.map(machineId => ({ machineId, bars: [] }));
  const laneOf = new Map(lanes.map(l => [l.machineId, l]));

  const orders = [];
  for (const o of valid) {
    const s = Date.parse(o.startAt);
    const e = Date.parse(o.endAt);
    const ok = orderKey(o);
    if (!orders.includes(ok)) orders.push(ok);
    laneOf.get(o.machineId).bars.push({
      key: o.operationId, orderKey: ok, label: o.orderCode || ok,
      left: pct(s), width: Math.max(0.4, pct(e) - pct(s)), startAt: o.startAt, endAt: o.endAt,
    });
  }
  for (const l of lanes) l.bars.sort((a, b) => a.left - b.left);

  const nowPct = nowMs >= start && nowMs <= end ? pct(nowMs) : null;
  return { lanes, start, end, nowPct, orders };
}

/* 时间刻度：均分 n 段，返回 [{ pct, ms }] */
export function ganttTicks(start, end, n = 6) {
  if (start === null || end === null) return [];
  return Array.from({ length: n + 1 }, (_, i) => ({ pct: (i / n) * 100, ms: start + ((end - start) * i) / n }));
}

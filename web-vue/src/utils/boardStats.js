/* 调度看板「生产态势」统计：只依赖订单 / 设备基础数据，没有排程时也能出数。
 * 口径（均为排程前的理论值，求解后以计划 KPI 为准）：
 * - 工序最短工时：候选设备中 setup + process 最小者；订单最短加工链 = 各工序最短工时之和
 * - 交期紧迫度：最短加工链 / (交期 - 到达)；越接近 1 越紧，≥1 表示理论上已无法按期
 * - 设备理论负荷：每道工序的平均工时按候选设备数均摊（未排程时设备分配未知）
 * - 计划周期：最早到达 ~ 最晚交期；理论负荷率 = 理论负荷 / 计划周期 */
import { TZ } from './format.js';

export const URGENCY_LEVELS = [
  { key: 'critical', label: '高风险', min: 0.5 },
  { key: 'warning', label: '需关注', min: 0.35 },
  { key: 'good', label: '宽裕', min: 0 },
];

export const PRIORITY_LEVELS = [5, 4, 3, 2, 1];

function opMinutes(c) { return (c.setupMinutes || 0) + (c.processMinutes || 0); }

export function urgencyLevel(ratio) {
  if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return URGENCY_LEVELS[2];
  return URGENCY_LEVELS.find(l => ratio >= l.min) || URGENCY_LEVELS[2];
}

export function orderProfile(o) {
  const ops = o.operations || [];
  const minChain = ops.reduce((sum, op) => {
    const c = op.candidates || [];
    return sum + (c.length ? Math.min(...c.map(opMinutes)) : 0);
  }, 0);
  const lead = (Date.parse(o.dueAt) - Date.parse(o.arrivalAt)) / 60000;
  const ratio = lead > 0 ? minChain / lead : null;
  return {
    orderId: o.orderId, orderCode: o.orderCode, productFamily: o.productFamily,
    quantity: o.quantity || 0, priority: o.priority, status: o.status, dueAt: o.dueAt,
    ops: ops.length, minChainMinutes: minChain, leadMinutes: lead > 0 ? lead : null,
    slackMinutes: lead > 0 ? lead - minChain : null, urgency: ratio,
  };
}

const hourFmt = new Intl.DateTimeFormat('zh-CN', {
  timeZone: TZ, month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
});
export function hourKey(iso) {
  const parts = Object.fromEntries(hourFmt.formatToParts(new Date(iso)).map(p => [p.type, p.value]));
  return `${parts.month}-${parts.day} ${parts.hour === '24' ? '00' : parts.hour}时`;
}

export function buildBoardStats(orders = [], machines = []) {
  const profiles = orders.map(orderProfile);
  const activeOrders = profiles.filter(p => p.status !== 'COMPLETED');

  const byStatus = { WAITING: 0, SCHEDULED: 0, RUNNING: 0, COMPLETED: 0 };
  for (const p of profiles) byStatus[p.status] = (byStatus[p.status] || 0) + 1;

  const familyMap = new Map();
  for (const p of profiles) {
    const f = familyMap.get(p.productFamily) || { family: p.productFamily, orders: 0, quantity: 0 };
    f.orders += 1; f.quantity += p.quantity;
    familyMap.set(p.productFamily, f);
  }
  const families = [...familyMap.values()].sort((a, b) => b.orders - a.orders || a.family.localeCompare(b.family));

  const priorities = PRIORITY_LEVELS.map(level => ({ level, orders: profiles.filter(p => p.priority === level).length }));

  const urgency = URGENCY_LEVELS.map(l => ({ ...l, orders: 0 }));
  for (const p of activeOrders) urgency.find(u => u.key === urgencyLevel(p.urgency).key).orders += 1;
  const riskOrders = activeOrders
    .filter(p => p.urgency !== null)
    .sort((a, b) => b.urgency - a.urgency)
    .slice(0, 6)
    .map(p => ({ ...p, level: urgencyLevel(p.urgency) }));

  const arrivals = orders.map(o => Date.parse(o.arrivalAt)).filter(Number.isFinite);
  const dues = orders.map(o => Date.parse(o.dueAt)).filter(Number.isFinite);
  const horizonMinutes = arrivals.length && dues.length ? Math.max(0, (Math.max(...dues) - Math.min(...arrivals)) / 60000) : 0;

  // 交期按小时分桶（Asia/Shanghai），桶之间补齐空小时，时间轴连续
  const dueBuckets = [];
  if (dues.length) {
    const counts = new Map();
    for (const t of dues) counts.set(hourKey(t), (counts.get(hourKey(t)) || 0) + 1);
    const start = Math.floor(Math.min(...dues) / 3600000) * 3600000;
    const end = Math.floor(Math.max(...dues) / 3600000) * 3600000;
    for (let t = start; t <= end; t += 3600000) dueBuckets.push({ label: hourKey(t), orders: counts.get(hourKey(t)) || 0 });
  }

  const machineIds = machines.map(m => m.machineId);
  const load = new Map(machineIds.map(id => [id, { machineId: id, minutes: 0, ops: 0 }]));
  let totalOps = 0;
  let totalMinMinutes = 0;
  for (const o of orders) {
    if (o.status === 'COMPLETED') continue;
    for (const op of o.operations || []) {
      const c = op.candidates || [];
      if (!c.length) continue;
      totalOps += 1;
      totalMinMinutes += Math.min(...c.map(opMinutes));
      const avg = c.reduce((s, x) => s + opMinutes(x), 0) / c.length;
      for (const cand of c) {
        if (!load.has(cand.machineId)) load.set(cand.machineId, { machineId: cand.machineId, minutes: 0, ops: 0 });
        const m = load.get(cand.machineId);
        m.minutes += avg / c.length;
        m.ops += 1;
      }
    }
  }
  const machineLoad = [...load.values()]
    .map(m => ({ ...m, rate: horizonMinutes ? m.minutes / horizonMinutes : null }))
    .sort((a, b) => b.minutes - a.minutes);

  const workCenters = new Map();
  for (const m of machines) {
    const w = workCenters.get(m.workCenterId) || { workCenterId: m.workCenterId, total: 0, active: 0 };
    w.total += 1; if (m.status === 'ACTIVE') w.active += 1;
    workCenters.set(m.workCenterId, w);
  }

  const activeMachines = machines.filter(m => m.status === 'ACTIVE').length;
  return {
    totals: {
      orders: profiles.length,
      quantity: profiles.reduce((s, p) => s + p.quantity, 0),
      operations: totalOps,
      machines: machines.length,
      activeMachines,
      minWorkMinutes: totalMinMinutes,
      horizonMinutes,
      theoreticalLoad: horizonMinutes && activeMachines ? totalMinMinutes / (horizonMinutes * activeMachines) : null,
      highRisk: urgency.find(u => u.key === 'critical').orders,
    },
    byStatus, families, priorities, urgency, riskOrders, dueBuckets, machineLoad,
    workCenters: [...workCenters.values()],
  };
}

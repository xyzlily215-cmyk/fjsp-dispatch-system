<template>
  <div class="gantt-wrap"><div ref="chartEl" :style="{ width: '100%', height: chartH + 'px' }"></div></div>
</template>

<script setup>
/* 甘特图图表组件（ECharts custom series）：资源视图（按设备行）/ 订单视图（按订单工艺链）双视图，
   支持工序条点击联动、PNG 导出（getDataURL 2x）。逻辑自旧版 web/js/pages-gantt.js 移植 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as echarts from 'echarts';
import { esc, fmtDateTime, fmtHM, fmtMinutes, fmtPct, reasonText, TZ } from '../utils/format';
import { toast } from '../utils/ui';

const props = defineProps({
  plan: { type: Object, required: true },
  ops: { type: Array, default: () => [] },
  machines: { type: Array, default: () => [] },
  orders: { type: Array, default: () => [] },
  dash: { type: Object, default: null },
  view: { type: String, default: 'resource' }, // resource / order
  focusOp: { type: String, default: null },
});
const emit = defineEmits(['op-click']);

/* 产品族颜色：演示三族固定占用前 3 个色（维持原观感），其余族名按 hash 取模取色（跳过前 3 个，避免与演示族撞色） */
const FAMILY_PALETTE = [
  { cls: 'blue', hex: '#409eff' },    // 轴类A
  { cls: 'green', hex: '#67c23a' },   // 盘类B
  { cls: 'orange', hex: '#e6a23c' },  // 壳体C
  { cls: 'purple', hex: '#8a6de9' },
  { cls: 'teal', hex: '#13c2c2' },
  { cls: 'magenta', hex: '#eb2f96' },
  { cls: 'indigo', hex: '#2f54eb' },
  { cls: 'gold', hex: '#d48806' },
  { cls: 'lime', hex: '#7cb305' },
  { cls: 'gray', hex: '#8c8c8c' },
];
const FAMILY_PINNED = { '轴类A': 0, '盘类B': 1, '壳体C': 2 };
function familyColor(fam) {
  if (Object.prototype.hasOwnProperty.call(FAMILY_PINNED, fam)) return FAMILY_PALETTE[FAMILY_PINNED[fam]];
  let h = 0;
  for (let i = 0; i < fam.length; i++) h = (h * 31 + fam.charCodeAt(i)) >>> 0;
  return FAMILY_PALETTE[3 + (h % (FAMILY_PALETTE.length - 3))];
}

const familyOf = computed(() => {
  const m = {};
  props.orders.forEach(o => { m[o.orderId] = o.productFamily; });
  return m;
});
const familyOfOp = (op) => op.productFamily
  || familyOf.value[op.orderId || op.operationId.split('-').slice(0, -1).join('-')] || '';

const opsSorted = computed(() => props.ops.slice().sort((a, b) => (a.startAt < b.startAt ? -1 : 1)));
const kpi = computed(() => props.plan.kpi || {});
const families = computed(() => [...new Set(opsSorted.value.map(familyOfOp).filter(Boolean))]);

const winStart = computed(() => Math.min(...opsSorted.value.map(o => Date.parse(o.startAt))));
const winEnd = computed(() => Math.max(...opsSorted.value.map(o => Date.parse(o.endAt))));

// 时间轴标签格式：选一个合适的间隔让刻度在 8~16 个之间
const HOUR = 3600e3;
const tick = computed(() => {
  const span = Math.max(winEnd.value - winStart.value, 1);
  for (const t of [2, 4, 6, 8, 12, 24]) { if (span / (t * HOUR) <= 14) return t * HOUR; }
  return 24 * HOUR;
});
const tickLabel = (t) => {
  const d = new Date(t);
  const day = new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, month: '2-digit', day: '2-digit' }).format(d);
  const hm = new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  return tick.value >= 24 * HOUR ? day : (hm === '00:00' ? day : hm);
};

const opTipHtml = (o) => [
  `工序 ${esc(o.operationId)}`,
  `设备 ${esc(o.machineId)}`,
  `开始 ${fmtDateTime(o.startAt)}  结束 ${fmtDateTime(o.endAt)}`,
  `准备 ${fmtHM(o.setupStartAt)}→${fmtHM(o.processStartAt)}${o.changeoverMinutes ? ` · 换型 ${o.changeoverMinutes}min` : ''}`,
  o.frozen ? '❄ 冻结工序' : '',
  o.affected ? `⚠ 受事件影响${o.reasonCode ? '（' + esc(reasonText(o.reasonCode)) + '）' : ''}` : '',
  (o.executionCompleted || o.operationStatus === 'COMPLETED') ? '✓ 已完成' : '',
].filter(Boolean).join('<br/>');

// 故障维修区间（来自看板异常）
const repairs = computed(() => (((props.dash && props.dash.exceptions && props.dash.exceptions.breakdowns) || [])
  .map(b => ({ machineId: b.machineId, start: Date.parse(b.occurredAt), end: Date.parse(b.repairEndAt), code: b.eventCode }))
  .filter(r => !isNaN(r.start) && !isNaN(r.end) && r.end > winStart.value && r.start < winEnd.value)));

const byMachine = computed(() => {
  const m = {};
  props.machines.forEach(mc => { m[mc.machineId] = []; });
  opsSorted.value.forEach(o => { (m[o.machineId] = m[o.machineId] || []).push(o); });
  return m;
});

/* 订单行分组：按订单工艺链排序（交期升序） */
function buildOrderRows() {
  const groups = {};
  opsSorted.value.forEach(o => {
    const oid = o.orderId || o.operationId.split('-').slice(0, -1).join('-');
    (groups[oid] = groups[oid] || []).push(o);
  });
  return Object.entries(groups).map(([oid, list]) => {
    list.sort((a, b) => ((a.sequenceNo ?? 0) - (b.sequenceNo ?? 0)) || (a.startAt < b.startAt ? -1 : 1));
    const dueAt = list.map(o => o.dueAt).find(Boolean) || null;
    const dueMs = dueAt ? Date.parse(dueAt) : null;
    const endMs = Math.max(...list.map(o => Date.parse(o.endAt)));
    const done = list.filter(o => o.executionCompleted || o.operationStatus === 'COMPLETED').length;
    return {
      oid, ops: list, dueAt, dueMs, endMs, done, total: list.length,
      orderCode: list[0].orderCode || oid,
      family: familyOfOp(list[0]),
      priority: list[0].priority,
      late: dueMs !== null && endMs > dueMs,
    };
  }).sort((a, b) => ((a.dueMs ?? Infinity) - (b.dueMs ?? Infinity)) || a.orderCode.localeCompare(b.orderCode));
}
// 关键路径（近似口径）：算法服务未输出真实关键路径，取计划完工时间最晚订单的完整工序链
const criticalOf = (rows) => (rows.length ? rows.reduce((a, b) => (b.endMs > a.endMs ? b : a)) : null);

const rows = computed(() => (props.view === 'order' ? buildOrderRows() : props.machines));
const chartH = computed(() => Math.max(rows.value.length * 44 + 130, 360));

/* ---------------- ECharts option 构建 ---------------- */
function buildOption() {
  const isOrder = props.view === 'order';
  const ws = winStart.value, we = winEnd.value;
  const rs = rows.value;
  const critical = isOrder ? criticalOf(rs) : null;
  const cats = rs.map(r => (isOrder ? r.orderCode : r.machineId));

  const bars = [];  // 工序条（custom series，可点击）
  const marks = []; // 背景标记：关键路径行底 / 工艺连线 / 交期线 / 维修区间（静默）

  const barItem = (ci, o, extra) => {
    const s = Date.parse(o.startAt), e = Date.parse(o.endAt);
    const setupS = o.setupStartAt ? Date.parse(o.setupStartAt) : s;
    const procS = o.processStartAt ? Date.parse(o.processStartAt) : s;
    const clippedStart = Math.max(setupS, ws);
    return Object.assign({
      kind: 'bar', op: o,
      value: [ci, clippedStart, e, Math.max(procS, clippedStart)],
    }, extra);
  };

  if (!isOrder) {
    props.machines.forEach((m, ci) => {
      (byMachine.value[m.machineId] || []).forEach(o => bars.push(barItem(ci, o, {
        label: (o.frozen ? '❄' : '') + (o.orderCode || o.operationId.split('-').slice(0, -1).join('-')),
      })));
      repairs.value.filter(r => r.machineId === m.machineId).forEach(r => marks.push({
        kind: 'repair', value: [ci, Math.max(r.start, ws), Math.min(r.end, we)],
      }));
    });
  } else {
    rs.forEach((r, ci) => {
      const isCritical = critical && r.oid === critical.oid;
      if (isCritical) marks.push({ kind: 'rowbg', value: [ci, ws, we] });
      if (r.ops.length > 1) marks.push({
        kind: 'link',
        value: [ci, Date.parse(r.ops[0].startAt), Date.parse(r.ops[r.ops.length - 1].endAt)],
      });
      r.ops.forEach((o, i) => {
        const completed = o.executionCompleted || o.operationStatus === 'COMPLETED';
        bars.push(barItem(ci, o, {
          label: (o.frozen ? '❄' : '') + `${o.sequenceNo ?? i + 1}·${o.machineId}` + (completed ? ' ✓' : ''),
          late: r.dueMs !== null && Date.parse(o.endAt) > r.dueMs,
          critical: isCritical,
        }));
      });
      if (r.dueMs !== null && r.dueMs >= ws && r.dueMs <= we) {
        marks.push({ kind: 'due', value: [ci, r.dueMs, r.dueMs] });
      }
    });
  }

  const coordBoxOf = (params) => ({
    x: params.coordSys.x, y: params.coordSys.y,
    width: params.coordSys.width, height: params.coordSys.height,
  });
  const borderRect = (rect, color, w, dash) => ({
    type: 'rect',
    shape: { x: rect.x + w / 2, y: rect.y + w / 2, width: Math.max(rect.width - w, 0), height: Math.max(rect.height - w, 0), r: 2 },
    style: { fill: 'none', stroke: color, lineWidth: w, lineDash: dash || undefined },
  });

  const renderBar = (params, api) => {
    const item = bars[params.dataIndex];
    const ci = api.value(0);
    const p0 = api.coord([api.value(1), ci]);
    const p1 = api.coord([api.value(2), ci]);
    const pProc = api.coord([api.value(3), ci]);
    const h = api.size([0, 1])[1] * 0.58;
    const rect = echarts.graphic.clipRectByRect(
      { x: p0[0], y: p0[1] - h / 2, width: Math.max(p1[0] - p0[0], 1.5), height: h },
      coordBoxOf(params));
    if (!rect) return { type: 'group', children: [] };
    const children = [{
      type: 'rect',
      shape: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, r: 2 },
      style: { fill: familyColor(familyOfOp(item.op)).hex },
    }];
    // 准备时段（setup）浅色段
    const setupW = pProc[0] - p0[0];
    if (setupW > 1.5) children.push({
      type: 'rect',
      shape: { x: rect.x, y: rect.y, width: Math.min(setupW, rect.width), height: rect.height },
      style: { fill: 'rgba(255,255,255,.35)' },
    });
    if (item.critical) children.push(borderRect(rect, '#b88230', 2));
    if (item.op.frozen) children.push(borderRect(rect, '#e6a23c', 2));
    if (item.late) children.push(borderRect(rect, '#f56c6c', 2));
    if (item.op.affected) children.push(borderRect(rect, '#f56c6c', 1.5, [4, 3]));
    if (item.op.operationId === props.focusOp) children.push(borderRect(rect, '#303133', 2.5));
    if (rect.width > 16) children.push({
      type: 'text',
      style: {
        x: rect.x + 5, y: rect.y + rect.height / 2, text: item.label,
        fill: '#fff', fontSize: 11, align: 'left', verticalAlign: 'middle',
        width: rect.width - 8, overflow: 'truncate',
      },
    });
    return { type: 'group', children };
  };

  const renderMark = (params, api) => {
    const item = marks[params.dataIndex];
    const ci = api.value(0);
    const rowH = api.size([0, 1])[1];
    const p0 = api.coord([api.value(1), ci]);
    const p1 = api.coord([api.value(2), ci]);
    const box = coordBoxOf(params);
    const clip = (shape) => echarts.graphic.clipRectByRect(shape, box);
    if (item.kind === 'due') {
      if (p0[0] < box.x || p0[0] > box.x + box.width) return { type: 'group', children: [] };
      return {
        type: 'line',
        shape: { x1: p0[0], y1: p0[1] - rowH * 0.42, x2: p0[0], y2: p0[1] + rowH * 0.42 },
        style: { stroke: '#f56c6c', lineWidth: 1.5, lineDash: [4, 3] },
      };
    }
    if (item.kind === 'link') {
      const rect = clip({ x: p0[0], y: p0[1] - 1, width: Math.max(p1[0] - p0[0], 1), height: 2 });
      return rect ? { type: 'rect', shape: rect, style: { fill: '#c9d2de' } } : { type: 'group', children: [] };
    }
    if (item.kind === 'rowbg') {
      const rect = clip({ x: p0[0], y: p0[1] - rowH / 2, width: Math.max(p1[0] - p0[0], 1), height: rowH });
      return rect ? { type: 'rect', shape: rect, style: { fill: '#fdf6e3' } } : { type: 'group', children: [] };
    }
    if (item.kind === 'repair') {
      const h = rowH * 0.58;
      const rect = clip({ x: p0[0], y: p0[1] - h / 2, width: Math.max(p1[0] - p0[0], 2), height: h });
      if (!rect) return { type: 'group', children: [] };
      const children = [{
        type: 'rect', shape: rect,
        style: { fill: 'rgba(245,108,108,.18)', stroke: '#f56c6c', lineWidth: 1, lineDash: [4, 3] },
      }];
      if (rect.width > 32) children.push({
        type: 'text',
        style: { x: rect.x + 4, y: rect.y + rect.height / 2, text: '维修', fill: '#d94444', fontSize: 10, align: 'left', verticalAlign: 'middle' },
      });
      return { type: 'group', children };
    }
    return { type: 'group', children: [] };
  };

  const yLabel = (value, idx) => {
    const r = rs[idx];
    if (!r) return value;
    if (isOrder) return `${r.orderCode}  ${r.done}/${r.total}✓`;
    const util = props.plan.kpi && props.plan.kpi.utilizationByMachine ? props.plan.kpi.utilizationByMachine[r.machineId] : null;
    return r.machineId + (util !== null && util !== undefined ? '  ' + fmtPct(util, 0) : '');
  };

  const noteText = isOrder
    ? '灰线 = 工艺顺序连线   ┆ 交期线 / 红实框 = 拖期工序   金框 = 关键路径（近似：完工最晚订单的工序链）   ✓ 已完成'
    : '❄ 冻结工序   红虚框 = 受事件影响   红虚块 = 维修区间   点击工序条可切换到另一视图定位';

  return {
    title: {
      text: `甘特图（${isOrder ? '订单视图' : '资源视图'}） · ${props.plan.versionCode}`,
      subtext: `C_max ${fmtMinutes(kpi.value.cMaxMinutes)} · 加权拖期 ${fmtMinutes(kpi.value.weightedTardinessMinutes)} · 延期 ${kpi.value.nTardy ?? '-'} 单 · 导出时间 ${fmtDateTime(new Date().toISOString())}`,
      left: 10, top: 6,
      textStyle: { fontSize: 15, color: '#303133' },
      subtextStyle: { fontSize: 11, color: '#909399' },
    },
    legend: {
      top: 8, right: 10, itemWidth: 10, itemHeight: 10,
      textStyle: { fontSize: 11, color: '#606266' },
      /* 只展示产品族/维修区间占位系列，隐藏 custom 系列名（marks/bars） */
      data: [...families.value, ...(isOrder ? [] : ['维修区间'])],
    },
    graphic: [{
      type: 'text', left: 12, bottom: 6,
      style: { text: noteText, fill: '#909399', fontSize: 11 },
    }],
    grid: { left: 10, right: 26, top: 64, bottom: 34, containLabel: true },
    tooltip: {
      trigger: 'item', confine: true,
      formatter: (p) => (p.data && p.data.op) ? opTipHtml(p.data.op) : '',
    },
    xAxis: {
      type: 'time', min: ws, max: we,
      axisLabel: { color: '#909399', fontSize: 11, formatter: (v) => tickLabel(v), hideOverlap: true },
      splitLine: { show: true, lineStyle: { color: '#f2f6fc' } },
      axisLine: { show: false }, axisTick: { show: false },
    },
    yAxis: {
      type: 'category', data: cats, inverse: true,
      axisLabel: { color: '#606266', fontSize: 12, formatter: yLabel },
      splitLine: { show: true, lineStyle: { color: '#ebeef5' } },
      axisLine: { show: false }, axisTick: { show: false },
    },
    series: [
      { type: 'custom', name: 'marks', renderItem: renderMark, data: marks, encode: { x: [1, 2], y: 0 }, z: 1, silent: true },
      { type: 'custom', name: 'bars', renderItem: renderBar, data: bars, encode: { x: [1, 2], y: 0 }, z: 3 },
      // 图例占位系列：无数据，仅为让产品族/维修区间出现在 legend 中（导出图片自带图例）
      ...families.value.map(f => ({ name: f, type: 'bar', data: [], silent: true, itemStyle: { color: familyColor(f).hex } })),
      ...(isOrder ? [] : [{ name: '维修区间', type: 'bar', data: [], silent: true, itemStyle: { color: '#f56c6c' } }]),
    ],
  };
}

/* ---------------- 实例生命周期 ---------------- */
const chartEl = ref(null);
let chart = null;
let resizeObs = null;

function render() {
  if (!chart) return;
  if (!props.ops.length) { chart.clear(); return; }
  chart.setOption(buildOption(), true);
}

/* ---------------- PNG 导出：整图（含标题/图例）以 2x 像素输出 ---------------- */
function exportPng() {
  if (!props.ops.length || !chart) { toast('该版本没有工序明细，无法导出图片'); return; }
  const url = chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#fff' });
  const a = document.createElement('a');
  a.href = url;
  a.download = `${props.plan.versionCode}-${props.view === 'order' ? '订单视图' : '资源视图'}-甘特图.png`;
  a.click();
  toast('甘特图 PNG 已开始下载');
}
defineExpose({ exportPng });

onMounted(() => {
  chart = echarts.init(chartEl.value);
  render();
  // 视图联动：点击工序条由父页面切换到另一视图并定位同一工序
  chart.on('click', (p) => {
    if (p.data && p.data.op) emit('op-click', p.data.op);
  });
  resizeObs = new ResizeObserver(() => { if (chart) chart.resize(); });
  resizeObs.observe(chartEl.value);
});

watch(
  [() => props.ops, () => props.machines, () => props.orders, () => props.plan, () => props.dash, () => props.view, () => props.focusOp],
  render,
);

onBeforeUnmount(() => {
  if (resizeObs) { resizeObs.disconnect(); resizeObs = null; }
  if (chart) { chart.dispose(); chart = null; }
});
</script>

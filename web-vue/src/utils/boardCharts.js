/* 调度看板图表配置（ECharts option 构造，纯函数便于测试）。
 * 配色经 dataviz 校验器：产品族用分类色前 3 槽（all-pairs 通过，aqua 对比度不足 3:1 → 直接标注数值）；
 * 优先级用单色蓝序数梯度（250→650，ordinal 通过）；紧迫度用保留状态色并始终配文字标签。 */
export const BOARD_COLORS = {
  series: ['#2a78d6', '#eb6834', '#1baf7a'],
  ramp: ['#86b6ef', '#5598e7', '#2a78d6', '#1c5cab', '#104281'], // P1 → P5
  status: { good: '#0ca30c', warning: '#fab219', critical: '#d03b3b' },
  ink: '#1d1d1f', muted: '#6e6e73', grid: '#eceef2', surface: '#ffffff',
};

const AXIS_LABEL = { color: BOARD_COLORS.muted, fontSize: 11 };
const TOOLTIP = {
  backgroundColor: 'rgba(255,255,255,.96)', borderColor: '#e2e2e6', borderWidth: 1,
  textStyle: { color: BOARD_COLORS.ink, fontSize: 12 }, extraCssText: 'box-shadow:0 8px 24px rgba(16,36,52,.12);border-radius:8px;',
};

export function machineLoadOption(machineLoad) {
  const rows = [...machineLoad].reverse(); // 横向条形：负荷最高的在最上方
  return {
    animationDuration: 900,
    grid: { left: 52, right: 56, top: 8, bottom: 22 },
    tooltip: {
      ...TOOLTIP, trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(42,120,214,.06)' } },
      formatter: (ps) => {
        const r = rows[ps[0].dataIndex];
        return `<b>${r.machineId}</b><br>理论负荷率 ${(r.rate * 100).toFixed(1)}%<br>候选工序 ${r.ops} 道 · 均摊 ${(r.minutes / 60).toFixed(1)}h`;
      },
    },
    xAxis: {
      type: 'value', max: (v) => Math.max(1, Math.ceil(v.max * 10) / 10),
      axisLabel: { ...AXIS_LABEL, formatter: (v) => `${Math.round(v * 100)}%` },
      splitLine: { lineStyle: { color: BOARD_COLORS.grid } },
    },
    yAxis: {
      type: 'category', data: rows.map(r => r.machineId),
      axisTick: { show: false }, axisLine: { show: false }, axisLabel: { ...AXIS_LABEL, color: BOARD_COLORS.ink, fontSize: 12 },
    },
    series: [{
      type: 'bar', barWidth: 12, data: rows.map(r => r.rate ?? 0),
      itemStyle: {
        borderRadius: [0, 4, 4, 0],
        color: { type: 'linear', x: 0, y: 0, x2: 1, y2: 0, colorStops: [{ offset: 0, color: '#86b6ef' }, { offset: 1, color: BOARD_COLORS.series[0] }] },
      },
      showBackground: true, backgroundStyle: { color: '#f3f6fb', borderRadius: [0, 4, 4, 0] },
      label: { show: true, position: 'right', color: BOARD_COLORS.ink, fontSize: 11, formatter: (p) => `${(p.value * 100).toFixed(0)}%` },
    }],
  };
}

export function dueDistributionOption(dueBuckets) {
  return {
    animationDuration: 900,
    grid: { left: 34, right: 12, top: 18, bottom: 40 },
    tooltip: { ...TOOLTIP, trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(42,120,214,.06)' } },
      formatter: (ps) => `${ps[0].name}<br><b>${ps[0].value}</b> 单到期` },
    xAxis: {
      type: 'category', data: dueBuckets.map(b => b.label),
      axisTick: { show: false }, axisLine: { lineStyle: { color: '#d8dce3' } },
      axisLabel: { ...AXIS_LABEL, interval: (i) => i % 4 === 0, formatter: (v) => v.replace(' ', '\n') },
    },
    yAxis: { type: 'value', minInterval: 1, axisLabel: AXIS_LABEL, splitLine: { lineStyle: { color: BOARD_COLORS.grid } } },
    series: [{
      type: 'bar', barMaxWidth: 14, data: dueBuckets.map(b => b.orders),
      itemStyle: {
        borderRadius: [4, 4, 0, 0],
        color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: BOARD_COLORS.series[0] }, { offset: 1, color: '#9ec5f4' }] },
      },
      emphasis: { itemStyle: { color: '#1c5cab' } },
    }],
  };
}

export function urgencyOption(urgency, total) {
  return {
    animationDuration: 900,
    tooltip: { ...TOOLTIP, trigger: 'item', formatter: (p) => `${p.name}<br><b>${p.value}</b> 单 · ${p.percent}%` },
    title: {
      text: String(total), subtext: '在制订单', left: 'center', top: '36%',
      textStyle: { color: BOARD_COLORS.ink, fontSize: 26, fontWeight: 700 },
      subtextStyle: { color: BOARD_COLORS.muted, fontSize: 12 }, itemGap: 2,
    },
    series: [{
      type: 'pie', radius: ['62%', '82%'], center: ['50%', '50%'], padAngle: 2,
      itemStyle: { borderRadius: 4, borderColor: BOARD_COLORS.surface, borderWidth: 2 },
      label: { show: false }, emphasis: { scale: true, scaleSize: 4 },
      data: urgency.map(u => ({ name: u.label, value: u.orders, itemStyle: { color: BOARD_COLORS.status[u.key] } })),
    }],
  };
}

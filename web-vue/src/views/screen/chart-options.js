/* 大屏 ECharts option 构建器：暗夜发光主题，与视图分离。 */

export const SCREEN_COLORS = {
  cyan: '#2CE8FF',
  blue: '#3B8BFF',
  green: '#00E2A8',
  amber: '#FFC74A',
  orange: '#FF9340',
  red: '#FF5470',
  text: '#DCEFFF',
  muted: '#83A9D1',
  axis: '#3A5578',
};

const AXIS_LABEL = { color: SCREEN_COLORS.muted, fontSize: 12 };
const AXIS_LINE = { lineStyle: { color: 'rgba(90, 140, 190, 0.35)' } };
const SPLIT_LINE = { lineStyle: { color: 'rgba(80, 160, 235, 0.18)', type: 'dashed' } };
const TOOLTIP = {
  backgroundColor: 'rgba(7, 22, 41, 0.92)',
  borderColor: 'rgba(44, 232, 255, 0.35)',
  textStyle: { color: SCREEN_COLORS.text, fontSize: 12 },
};

export function fmtNum(v) {
  if (v == null || Number.isNaN(Number(v))) return '—';
  return Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

/* 近 7 日产出：实际产出渐变柱（左轴）+ 达成率折线（右轴），双轴柱线组合 */
export function buildTrendOption(rows) {
  return {
    tooltip: { trigger: 'axis', ...TOOLTIP },
    legend: {
      data: ['实际产出', '达成率'],
      textStyle: { color: SCREEN_COLORS.muted, fontSize: 12 },
      top: 2,
      right: 8,
      itemWidth: 14,
      itemHeight: 8,
      icon: 'rect',
    },
    grid: { left: 48, right: 48, top: 34, bottom: 26 },
    xAxis: {
      type: 'category',
      data: rows.map(r => r.day),
      axisLabel: AXIS_LABEL,
      axisLine: AXIS_LINE,
      axisTick: { show: false },
    },
    yAxis: [
      {
        type: 'value',
        name: '件',
        nameTextStyle: { color: SCREEN_COLORS.muted },
        axisLabel: AXIS_LABEL,
        splitLine: SPLIT_LINE,
      },
      {
        type: 'value',
        name: '%',
        min: 80,
        max: 110,
        nameTextStyle: { color: SCREEN_COLORS.muted },
        axisLabel: AXIS_LABEL,
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: '实际产出',
        type: 'bar',
        barWidth: 14,
        itemStyle: {
          color: {
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: '#6FF5FF' },
              { offset: 0.45, color: '#21B7F0' },
              { offset: 1, color: 'rgba(10, 74, 148, 0.55)' },
            ],
          },
          shadowColor: 'rgba(44, 232, 255, 0.35)',
          shadowBlur: 8,
        },
        data: rows.map(r => r.actual),
      },
      {
        name: '达成率',
        type: 'line',
        yAxisIndex: 1,
        smooth: true,
        symbol: 'circle',
        symbolSize: 6,
        lineStyle: { width: 2.5, color: SCREEN_COLORS.amber, shadowColor: 'rgba(255, 199, 74, 0.6)', shadowBlur: 10 },
        itemStyle: { color: SCREEN_COLORS.amber, borderColor: '#3a2a08', borderWidth: 2 },
        areaStyle: {
          color: {
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(255, 181, 71, 0.18)' },
              { offset: 1, color: 'rgba(255, 181, 71, 0)' },
            ],
          },
        },
        data: rows.map(r => (r.planned ? +(r.actual / r.planned * 100).toFixed(1) : null)),
      },
    ],
  };
}

/* 设备负荷排行：横向柱状，高负荷暖色、低负荷红色、故障设备灰显 */
export function buildLoadOption(rows) {
  const sorted = [...rows].sort((a, b) => a.load - b.load);
  const barColor = (load) => {
    if (load === 0) return { color: 'rgba(90, 122, 153, 0.3)', shadowBlur: 0 };
    const stops = load >= 85
      ? [{ offset: 0, color: '#A8550C' }, { offset: 1, color: '#FFB03A' }]
      : load <= 55
        ? [{ offset: 0, color: '#8B1730' }, { offset: 1, color: SCREEN_COLORS.red }]
        : [{ offset: 0, color: '#0A4F96' }, { offset: 1, color: SCREEN_COLORS.cyan }];
    return {
      color: { type: 'linear', x: 0, y: 0, x2: 1, y2: 0, colorStops: stops },
      shadowBlur: 10,
      shadowColor: stops[1].color + '80',
    };
  };
  return {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, ...TOOLTIP, formatter: p => `${p[0].name}　负荷 ${p[0].value}%` },
    grid: { left: 56, right: 40, top: 10, bottom: 24 },
    xAxis: { type: 'value', max: 100, axisLabel: { ...AXIS_LABEL, formatter: '{value}%' }, splitLine: SPLIT_LINE },
    yAxis: {
      type: 'category',
      data: sorted.map(r => r.name),
      axisLabel: { ...AXIS_LABEL, color: SCREEN_COLORS.text },
      axisLine: AXIS_LINE,
      axisTick: { show: false },
    },
    series: [{
      type: 'bar',
      barWidth: 12,
      data: sorted.map(r => ({
        value: r.load,
        itemStyle: barColor(r.load),
      })),
      label: { show: true, position: 'right', color: SCREEN_COLORS.muted, fontSize: 11, formatter: '{c}%' },
    }],
  };
}

/* 设备状态分布：左侧发光环形图 + 右侧纵向图例（含数量） */
export function buildStatusOption(rows) {
  const palette = { 运行: SCREEN_COLORS.green, 待机: SCREEN_COLORS.blue, 故障: SCREEN_COLORS.red, 维护: SCREEN_COLORS.amber };
  const total = rows.reduce((s, r) => s + r.value, 0);
  return {
    tooltip: { ...TOOLTIP, trigger: 'item' },
    title: {
      text: String(total),
      subtext: '设备总数',
      left: '30%',
      top: '34%',
      textAlign: 'center',
      textStyle: { color: SCREEN_COLORS.text, fontSize: 30, fontWeight: 600 },
      subtextStyle: { color: SCREEN_COLORS.muted, fontSize: 12 },
    },
    legend: {
      orient: 'vertical',
      right: 10,
      top: 'center',
      icon: 'circle',
      itemWidth: 8,
      itemHeight: 8,
      itemGap: 13,
      textStyle: { color: SCREEN_COLORS.muted, fontSize: 11 },
      formatter: (name) => {
        const item = rows.find(r => r.name === name);
        return `${name}  ${item ? item.value : 0}`;
      },
    },
    series: [{
      type: 'pie',
      radius: ['54%', '74%'],
      center: ['30%', '50%'],
      padAngle: 3,
      itemStyle: {
        borderRadius: 6,
        borderColor: '#071426',
        borderWidth: 2,
        shadowBlur: 14,
        shadowColor: 'rgba(44, 232, 255, 0.35)',
      },
      emphasis: { scale: true, scaleSize: 8, itemStyle: { shadowBlur: 26, shadowColor: 'rgba(44, 232, 255, 0.6)' } },
      label: { show: false },
      data: rows.map(r => ({ ...r, itemStyle: { color: palette[r.name] || SCREEN_COLORS.blue } })),
    }],
  };
}

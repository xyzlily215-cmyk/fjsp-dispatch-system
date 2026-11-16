/* 数据大屏假数据层：全部返回 Promise，接口签名保持稳定，
 * 二期接真实接口时只需替换函数体（走 ./index.js 的 api 封装），视图零改动。 */

function delay(ms = 220) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* 每次刷新做小幅抖动，让大屏数字"活"起来 */
function jitter(value, ratio = 0.02) {
  return value * (1 + (Math.random() - 0.5) * 2 * ratio);
}

export const MACHINE_NAMES = ['M-01', 'M-02', 'M-03', 'M-04', 'M-05', 'M-06', 'M-07', 'M-08'];

const PRODUCT_LINES = ['阀体', '法兰盘', '齿轮箱盖', '传动轴', '泵壳', '支架', '涡轮壳', '轴承座'];

export async function getScreenMetrics() {
  await delay();
  return {
    ordersInProgress: Math.round(jitter(26, 0.04)),
    ordersDelta: +jitter(8.3, 0.15).toFixed(1),
    doneToday: Math.round(jitter(148, 0.05)),
    doneDelta: +jitter(5.6, 0.2).toFixed(1),
    utilization: +jitter(86.4, 0.02).toFixed(1),
    utilizationDelta: +jitter(2.1, 0.3).toFixed(1),
    onTimeRate: +jitter(94.2, 0.01).toFixed(1),
    onTimeDelta: +jitter(1.4, 0.3).toFixed(1),
  };
}

export async function getOutputTrend() {
  await delay();
  const days = [];
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400000);
    days.push(`${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }
  const planned = [128, 135, 142, 138, 150, 146, 152];
  const actual = [121, 139, 136, 145, 148, 142, Math.round(jitter(149, 0.03))];
  return days.map((day, i) => ({ day, planned: planned[i], actual: actual[i] }));
}

export async function getMachineLoad() {
  await delay();
  const base = [87, 92, 78, 0, 85, 90, 66, 81];
  return MACHINE_NAMES.map((name, i) => ({
    name,
    load: i === 3 ? 0 : Math.round(Math.min(99, jitter(base[i], 0.04))),
  }));
}

/* 与 3D 场景共用同一套设备状态：运行/待机/故障/维护 */
export async function getMachineStatus() {
  await delay();
  return [
    { name: '运行', value: 6 },
    { name: '待机', value: 1 },
    { name: '故障', value: 1 },
    { name: '维护', value: 0 },
  ];
}

export async function getOrderProgress() {
  await delay();
  const rows = [
    ['PO-1101', 0, 72, '11-15', 'normal'],
    ['PO-1102', 1, 45, '11-16', 'normal'],
    ['PO-1103', 2, 91, '11-13', 'normal'],
    ['PO-1104', 3, 58, '11-14', 'warning'],
    ['PO-1105', 4, 33, '11-18', 'normal'],
    ['PO-1106', 5, 86, '11-12', 'danger'],
    ['PO-1107', 6, 64, '11-17', 'normal'],
    ['PO-1108', 7, 19, '11-20', 'normal'],
  ];
  return rows.map(([code, p, progress, due, status]) => ({
    code,
    product: PRODUCT_LINES[p],
    progress: Math.min(99, Math.round(jitter(progress, 0.02))),
    due,
    status,
  }));
}

export async function getRecentEvents() {
  await delay();
  const pad = n => String(n).padStart(2, '0');
  const now = Date.now();
  const defs = [
    [2, '设备故障', 'M-04 主轴温度报警，已自动触发重调度', 'danger'],
    [9, '订单插单', 'PO-1109 紧急插单，优先级 P0，已排入 M-02', 'warning'],
    [16, '重调度完成', '方案 v11-3 审核通过并发布，涉及 12 道工序', 'info'],
    [27, '设备恢复', 'M-07 维护完成，恢复上线', 'success'],
    [38, '进度预警', 'PO-1106 预计延期 4.5 小时，建议加班窗口', 'warning'],
    [52, '质量异常', 'M-03 抽检不良率 2.1%，已通知质检', 'warning'],
    [64, '计划达成', '早班计划 148 件全部完工', 'success'],
    [83, '物料到位', 'PO-1105 毛坯已送达 M-05 缓存区', 'info'],
  ];
  return defs.map(([minAgo, type, text, level]) => {
    const d = new Date(now - minAgo * 60000);
    return { time: `${pad(d.getHours())}:${pad(d.getMinutes())}`, type, text, level };
  });
}

/* 3D 场景设备：position.y 对应车间纵深 0..10，状态驱动灯塔与光环颜色 */
export async function getWorkshopDevices() {
  await delay();
  const statuses = ['run', 'run', 'run', 'down', 'run', 'run', 'idle', 'run'];
  const xs = [3.4, 6.6, 9.8, 13.2, 3.4, 6.6, 9.8, 13.2];
  const ys = [2.7, 2.7, 2.7, 2.7, 7.3, 7.3, 7.3, 7.3];
  const machines = MACHINE_NAMES.map((name, i) => ({
    id: `cnc-m${String(i + 1).padStart(2, '0')}`,
    name,
    kind: 'machine',
    online: true,
    status: statuses[i],
    load: [87, 92, 78, 0, 85, 90, 66, 81][i],
    position: { x: xs[i], y: ys[i], yaw: ys[i] > 5 ? 180 : 0 },
  }));
  const t = (Date.now() / 1000) % 40 / 40;
  const progress = t <= 0.5 ? t * 2 : (1 - t) * 2;
  machines.push({
    id: 'agv-01',
    name: 'AGV-01',
    kind: 'agv',
    online: true,
    status: 'run',
    position: { x: 2 + progress * 15, y: 5, yaw: t > 0.5 ? 180 : 0 },
  });
  return machines;
}

/* 实时甘特流：以当前时刻为中心的时间窗，设备泳道 + 工序块 */
export async function getGanttLanes() {
  await delay();
  const now = Date.now();
  const windowStart = now - 4 * 3600000;
  const span = 10 * 3600000;
  let seed = 7;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  return MACHINE_NAMES.map((machine, mi) => {
    const jobs = [];
    let cursor = windowStart + rand() * 3600000;
    let n = 0;
    while (cursor < windowStart + span && n < 7) {
      const dur = (1 + rand() * 2.2) * 3600000;
      const gap = rand() * 0.5 * 3600000;
      const status = mi === 3 && cursor + dur > now ? 'exception'
        : cursor + dur < now ? 'done' : cursor < now ? 'running' : 'queued';
      jobs.push({
        order: `PO-${1101 + ((mi * 3 + n) % 8)}`,
        product: PRODUCT_LINES[(mi * 3 + n) % 8],
        start: cursor,
        end: cursor + dur,
        status,
      });
      cursor += dur + gap;
      n += 1;
    }
    return { machine, jobs };
  });
}

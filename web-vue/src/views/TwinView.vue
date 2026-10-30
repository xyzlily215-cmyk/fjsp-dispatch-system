<template>
  <div class="twin">
    <div class="twin-main">
      <div class="twin-toolbar">
        <div class="twin-status">
          <span class="hub-dot" :class="hubClass"></span>
          <span>{{ hubText }}</span>
          <span class="sep">·</span>
          <span>{{ machines.length }} 台设备</span>
          <span class="sep">·</span>
          <span :class="simRunning ? '' : 'sim-off'">虚拟车间{{ simRunning ? '运行中' : '未启动' }}</span>
          <template v-if="alarms.length">
            <span class="sep">·</span>
            <span class="alarm-count">{{ alarms.length }} 条告警</span>
          </template>
        </div>
        <div class="twin-actions">
          <button v-if="!simRunning" type="button" class="t-btn primary" @click="startSim">启动虚拟车间</button>
          <button v-else type="button" class="t-btn" @click="stopSim">停止虚拟车间</button>
          <button type="button" class="t-btn danger-outline" :disabled="!simRunning || faultSent" @click="injectFault()">
            {{ faultSent ? '故障序列已触发' : '随机故障注入' }}
          </button>
        </div>
      </div>

      <div v-if="snap.hub !== 'connected'" class="twin-banner">
        设备通道未连接：确认 AgnesHub（4180）已启动后，点右上角「启动虚拟车间」拉起全部虚拟设备（含 AGV）。
      </div>

      <div v-if="alarms.length" class="alarm-strip">
        <div v-for="a in alarms" :key="a.id" class="alarm-card" :class="a.health.level">
          <div class="alarm-info">
            <b>{{ a.name }}</b>
            <span class="alarm-reason">{{ alarmReason(a) }}</span>
          </div>
          <button type="button" class="t-btn primary small" @click="askAgent(a)">让副驾处置</button>
        </div>
      </div>

      <div class="map-card">
        <div class="map-title">一号车间 · 实时布局 <span class="map-hint">点击设备查看实时画面</span></div>
        <svg class="map" viewBox="0 0 1000 500" @click.self="selected = null">
          <image v-if="gridOk" :href="gridUrl" x="0" y="0" width="1000" height="500" opacity="0.5" preserveAspectRatio="none" />
          <polygon v-for="z in zones" :key="z.id" :points="z.svgPoints" class="zone" />
          <text v-for="z in zones" :key="z.id + '-label'" :x="z.labelX" :y="z.labelY" class="zone-label">{{ z.name }}</text>
          <g v-for="m in machines" :key="m.id" @click.stop="select(m)" class="machine" :class="{ selected: selected?.id === m.id }">
            <rect :x="sx(m.position.x) - 40" :y="sy(m.position.y) - 25" width="80" height="50" rx="6"
                  :fill="statusColor(m)" :transform="`rotate(${-m.position.yaw} ${sx(m.position.x)} ${sy(m.position.y)})`"
                  class="machine-rect" />
            <text :x="sx(m.position.x)" :y="sy(m.position.y) + 5" class="machine-label">{{ machineCode(m) }}</text>
            <circle v-if="m.health.level !== 'ok'" :cx="sx(m.position.x) + 34" :cy="sy(m.position.y) - 19" r="8"
                    :fill="m.health.level === 'bad' ? '#f56c6c' : '#e6a23c'" class="alarm-pip" />
          </g>
          <g v-for="a in agvs" :key="a.id">
            <circle :cx="sx(a.position.x)" :cy="sy(a.position.y)" r="14" fill="#409eff" opacity="0.9" />
            <line :x1="sx(a.position.x)" :y1="sy(a.position.y)"
                  :x2="sx(a.position.x) + 18 * Math.cos((a.position.yaw * Math.PI) / 180)"
                  :y2="sy(a.position.y) - 18 * Math.sin((a.position.yaw * Math.PI) / 180)"
                  stroke="#fff" stroke-width="3" stroke-linecap="round" />
            <text :x="sx(a.position.x)" :y="sy(a.position.y) - 20" class="agv-label">{{ a.id }}</text>
          </g>
        </svg>
      </div>

      <div v-if="selected" class="detail-card">
        <div class="detail-head">
          <b>{{ selected.name }}</b>
          <span class="detail-sub">{{ selected.model }} · {{ statusText(selected) }}</span>
          <span v-if="selected.currentJob" class="detail-job">任务 {{ selected.currentJob }}</span>
          <div class="detail-head-actions">
            <template v-if="selected.id.startsWith('cnc-')">
              <button type="button" class="t-btn danger-outline small" @click="injectFault(selected)">注入过热故障</button>
              <button type="button" class="t-btn small" @click="recover(selected)">恢复正常</button>
            </template>
            <button v-if="isAlarm(selected)" type="button" class="t-btn primary small" @click="askAgent(selected)">让副驾处置</button>
            <button type="button" class="t-btn small" @click="selected = null">收起</button>
          </div>
        </div>
        <div class="detail-body">
          <img v-if="selected.online" class="panel-img" :src="panelSrc" alt="设备实时画面" />
          <div class="detail-facts">
            <div class="fact"><span>主轴温度</span><b :class="tempClass(selected)">{{ fmt(selected.metrics?.temperature, '°C') }}</b></div>
            <div class="fact"><span>振动</span><b>{{ fmt(selected.metrics?.vibration, 'mm/s') }}</b></div>
            <div class="fact"><span>主轴转速</span><b>{{ selected.metrics?.spindleRpm ?? '—' }} rpm</b></div>
            <div class="fact"><span>主轴负载</span><b>{{ selected.spindleLoad ?? '—' }}%</b></div>
            <div class="fact" v-if="selected.health?.reasons?.length">
              <span>健康原因</span><b class="health-reason">{{ selected.health.reasons.join('；') }}</b>
            </div>
          </div>
        </div>
      </div>

      <div class="cards">
        <div v-for="m in machines" :key="m.id" class="dev-card" :class="[{ alarm: isAlarm(m), off: !m.online, selected: selected?.id === m.id }]" @click="select(m)">
          <div class="dev-head">
            <span class="dev-dot" :class="statusClass(m)"></span>
            <b>{{ machineCode(m) }}</b>
            <span class="dev-status">{{ statusText(m) }}</span>
          </div>
          <div class="dev-metrics">
            <div class="metric"><span>温度</span><b :class="tempClass(m)">{{ fmt(m.metrics?.temperature, '°') }}</b></div>
            <div class="metric"><span>振动</span><b>{{ fmt(m.metrics?.vibration, '') }}</b></div>
            <div class="metric"><span>转速</span><b>{{ m.metrics?.spindleRpm ?? '—' }}</b></div>
          </div>
          <div class="load-bar"><div class="load-fill" :style="{ width: Math.min(m.spindleLoad ?? 0, 100) + '%' }"></div></div>
          <div class="dev-job">{{ m.currentJob || '—' }}</div>
        </div>
      </div>
    </div>

    <aside class="twin-chat">
      <AgentChat embedded />
    </aside>
  </div>
</template>

<script setup>
/* 数字孪生车间（AI 驾驶舱）：MHS 虚拟设备实时状态 + 设备控制 + 内嵌 AI 调度副驾。
 * 数据：/twin/stream SSE 1Hz 快照；画面：/twin/device/:id/panel 轮询刷新；
 * 控制：虚拟车间启停、M-03 故障注入/恢复（agent-bff 直控仿真进程，免脚本）；
 * 告警联动：一键让副驾处置（附设备快照上下文，衔接 SKILL 的 MHS 告警处置流程）。 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  openTwinStream, twinGridUrl, twinInjectFault, twinPanelUrl, twinRecover, twinSimStart, twinSimStop,
} from '../api/twin';
import { useAgentStore } from '../stores/agent';
import AgentChat from '../components/AgentChat.vue';

const agent = useAgentStore();
const snap = ref({ hub: 'connecting', devices: [], world: null, sim: null });
const selected = ref(null);
const faultSent = ref(false);
const gridOk = ref(true);
const gridUrl = twinGridUrl();
const panelTs = ref(Date.now());

let closeStream = null;
let panelTimer = null;

const machines = computed(() => snap.value.devices.filter((d) => d.kind === 'machine' && d.position));
const agvs = computed(() => snap.value.devices.filter((d) => d.kind === 'agv' && d.position));
const alarms = computed(() => snap.value.devices.filter((d) => isAlarm(d)));
const simRunning = computed(() => !!snap.value.sim?.running);

const zones = computed(() => {
  const places = snap.value.world?.places ?? [];
  return places.map((p) => {
    const pts = (p.points ?? []).map(([x, y]) => `${sx(x)},${sy(y)}`);
    const cx = (p.points ?? []).reduce((s, [x]) => s + x, 0) / Math.max((p.points ?? []).length, 1);
    const cy = (p.points ?? []).reduce((s, [, y]) => s + y, 0) / Math.max((p.points ?? []).length, 1);
    return { ...p, svgPoints: pts.join(' '), labelX: sx(cx), labelY: sy(cy) };
  });
});

const hubClass = computed(() => (snap.value.hub === 'connected' ? 'ok' : 'bad'));
const hubText = computed(() => (snap.value.hub === 'connected' ? '设备通道已连接' : '设备通道连接中…'));
const panelSrc = computed(() => (selected.value ? twinPanelUrl(selected.value.id, panelTs.value) : ''));

/* 地图坐标：车间 20m x 10m → 1000x500 SVG（y 轴翻转，地图 y 向上） */
const sx = (x) => x * 50;
const sy = (y) => (10 - y) * 50;

function machineCode(d) {
  return d.id.startsWith('cnc-m') ? 'M-' + d.id.slice(5).toUpperCase() : String(d.id).toUpperCase();
}
function statusText(d) {
  if (!d.online) return '离线';
  return { running: '运行中', idle: '空闲', down: '停机' }[d.status] ?? d.status ?? '未知';
}
function statusClass(d) {
  if (!d.online) return 'off';
  return { running: 'run', idle: 'idle', down: 'down' }[d.status] ?? 'off';
}
function statusColor(d) {
  if (!d.online) return '#c0c4cc';
  return { running: '#67c23a', idle: '#e6a23c', down: '#f56c6c' }[d.status] ?? '#c0c4cc';
}
function tempClass(d) {
  const t = d.metrics?.temperature;
  if (t == null) return '';
  if (t >= 85) return 't-bad';
  if (t >= 75) return 't-warn';
  return '';
}
function fmt(v, unit) {
  return v == null ? '—' : `${Number(v).toFixed(1)}${unit}`;
}
function isAlarm(d) {
  return d.online && (d.health?.level === 'attention' || d.health?.level === 'bad' || d.status === 'down');
}
function alarmReason(d) {
  if (d.health?.reasons?.length) return d.health.reasons.join('；');
  if (d.status === 'down') return '设备停机';
  return '需要关注';
}

function select(m) {
  selected.value = selected.value?.id === m.id ? null : m;
}

async function injectFault(d) {
  // 不传设备时随机挑一台在线且无告警的机床——评委视角的"任意一台故障"
  const target = d
    || machines.value.filter((m) => m.online && !isAlarm(m))[Math.floor(Math.random() * machines.value.filter((m) => m.online && !isAlarm(m)).length)];
  if (!target) {
    ElMessage.warning('当前没有可注入的机床（都已故障或未在线）');
    return;
  }
  try {
    await twinInjectFault(target.id);
    faultSent.value = true;
    ElMessage.success(`已触发 ${machineCode(target)} 主轴过热序列，观察温度爬升与告警联动`);
    setTimeout(() => { faultSent.value = false; }, 60_000);
  } catch {
    ElMessage.error('故障注入失败：请确认虚拟车间已启动');
  }
}

async function recover(d) {
  try {
    const r = await twinRecover(d.id);
    if (r.error) ElMessage.warning('虚拟车间未启动，无法恢复');
    else ElMessage.success(`已下发 ${machineCode(d)} 恢复指令，温度将逐步回到基线`);
  } catch {
    ElMessage.error('恢复失败：请确认虚拟车间已启动');
  }
}

async function startSim() {
  try {
    const r = await twinSimStart();
    if (r.started) ElMessage.success(`虚拟车间已启动（${(r.machines || []).length} 台设备），稍等几秒上线`);
    else ElMessage.info('虚拟车间已在运行');
  } catch {
    ElMessage.error('启动失败：请检查 agent-bff 与 mhs-devices/.venv');
  }
}

async function stopSim() {
  try {
    await ElMessageBox.confirm('停止后全部虚拟设备将离线（不影响业务数据），确认停止？', '停止虚拟车间', { type: 'warning' });
  } catch { return; }
  try {
    await twinSimStop();
    ElMessage.success('虚拟车间已停止');
  } catch {
    ElMessage.error('停止失败');
  }
}

async function askAgent(d) {
  if (agent.busy) {
    ElMessage.warning('副驾正在处置上一轮任务，请稍候或先停止');
    return;
  }
  const temp = d.metrics?.temperature != null ? `${Number(d.metrics.temperature).toFixed(1)}°C` : '未知';
  const vib = d.metrics?.vibration != null ? `${Number(d.metrics.vibration).toFixed(1)}mm/s` : '未知';
  const msg = `设备 ${d.id}（业务机台 ${machineCode(d)}）触发告警：${alarmReason(d)}。`
    + `当前主轴温度 ${temp}、振动 ${vib}、状态 ${statusText(d)}。`
    + `请按 MHS 设备告警处置流程处理：先 read_device 复核设备真实状态，再评估是否需要报故障重调度，写操作我会人工审批。`;
  try {
    await agent.send(msg, { section: '工作台', title: '数字孪生车间', route: 'twin', query: { device: d.id } });
  } catch (e) {
    ElMessage.error(e.message || '发送失败');
  }
}

function applySnapshot(s) {
  snap.value = s;
  if (selected.value) {
    const fresh = s.devices.find((d) => d.id === selected.value.id);
    if (fresh) selected.value = fresh;
  }
}

/* 标签页隐藏时暂停 SSE 与画面轮询（1Hz 快照 × 长开页面的资源优化），回前台即恢复 */
function onVisibility() {
  if (document.hidden) {
    if (closeStream) { closeStream(); closeStream = null; }
  } else if (!closeStream) {
    closeStream = openTwinStream(applySnapshot);
  }
}

onMounted(() => {
  closeStream = openTwinStream(applySnapshot);
  panelTimer = setInterval(() => { panelTs.value = Date.now(); }, 2500);
  document.addEventListener('visibilitychange', onVisibility);
  fetch(gridUrl, { method: 'HEAD' }).then((r) => { gridOk.value = r.ok; }).catch(() => { gridOk.value = false; });
});

onBeforeUnmount(() => {
  if (closeStream) closeStream();
  if (panelTimer) clearInterval(panelTimer);
  document.removeEventListener('visibilitychange', onVisibility);
});
</script>

<style scoped>
.twin { display:flex; gap:14px; align-items:flex-start; }
.twin-main { flex:1; min-width:0; display:flex; flex-direction:column; gap:14px; }
.twin-chat { flex:none; width:400px; position:sticky; top:12px; height:calc(100vh - 130px); border:1px solid var(--line,#e4e7ed); border-radius:10px; overflow:hidden; background:#fff; }
@media (max-width: 1100px) {
  .twin { flex-direction:column; }
  .twin-chat { width:100%; position:static; height:620px; }
}

.twin-toolbar { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px; }
.twin-status { display:flex; align-items:center; gap:8px; font-size:13px; color:#606266; }
.hub-dot { width:9px; height:9px; border-radius:50%; }
.hub-dot.ok { background:#67c23a; box-shadow:0 0 0 3px rgba(103,194,58,.18); }
.hub-dot.bad { background:#f56c6c; }
.sep { color:#dcdfe6; }
.sim-off { color:#f56c6c; }
.alarm-count { color:#f56c6c; font-weight:600; }
.twin-actions { display:flex; gap:8px; flex-wrap:wrap; }
.t-btn { border:1px solid #dcdfe6; background:#fff; border-radius:6px; padding:7px 14px; font-size:13px; cursor:pointer; color:#606266; }
.t-btn:hover { border-color:var(--blue,#409eff); color:var(--blue,#409eff); }
.t-btn.primary { background:var(--blue,#409eff); border-color:var(--blue,#409eff); color:#fff; }
.t-btn.primary:hover { background:#66b1ff; }
.t-btn.small { padding:4px 10px; font-size:12px; }
.t-btn.danger-outline { border-color:#fbc4c4; color:#f56c6c; }
.t-btn.danger-outline:hover:not(:disabled) { background:#fef0f0; }
.t-btn:disabled { opacity:.55; cursor:default; }
.twin-banner { padding:10px 14px; border-radius:8px; background:#fdf6ec; border:1px solid #faecd8; color:#e6a23c; font-size:13px; }

.alarm-strip { display:flex; flex-direction:column; gap:8px; }
.alarm-card { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 14px; border-radius:8px; border:1px solid #fbc4c4; background:#fef0f0; }
.alarm-card.attention { border-color:#f5dab1; background:#fdf6ec; }
.alarm-info { display:flex; align-items:baseline; gap:10px; font-size:13px; }
.alarm-info b { color:#303133; }
.alarm-reason { color:#909399; font-size:12px; }

.map-card { background:#fff; border:1px solid var(--line,#e4e7ed); border-radius:10px; padding:14px; }
.map-title { font-size:14px; font-weight:600; color:var(--ink,#303133); margin-bottom:10px; display:flex; align-items:baseline; gap:10px; }
.map-hint { font-size:12px; font-weight:400; color:#909399; }
.map { width:100%; border-radius:8px; background:#f7f9fc; }
.zone { fill:rgba(64,158,255,.05); stroke:#c4dbf7; stroke-width:1.5; stroke-dasharray:6 4; }
.zone-label { font-size:15px; fill:#a0b8d8; text-anchor:middle; }
.machine { cursor:pointer; }
.machine-rect { stroke:#fff; stroke-width:2; transition:filter .15s; }
.machine:hover .machine-rect { filter:brightness(1.12); }
.machine.selected .machine-rect { stroke:#1b2b63; stroke-width:3; }
.machine-label { font-size:15px; font-weight:700; fill:#fff; text-anchor:middle; pointer-events:none; }
.alarm-pip { stroke:#fff; stroke-width:2; animation:pip 1.2s ease-in-out infinite; }
@keyframes pip { 50% { opacity:.35; } }
.agv-label { font-size:12px; fill:#409eff; text-anchor:middle; font-weight:600; }

.detail-card { background:#fff; border:1px solid var(--line,#e4e7ed); border-radius:10px; padding:14px; }
.detail-head { display:flex; align-items:center; gap:10px; margin-bottom:12px; flex-wrap:wrap; }
.detail-head b { font-size:15px; color:var(--ink,#303133); }
.detail-sub { font-size:12px; color:#909399; }
.detail-job { font-size:12px; color:var(--blue,#409eff); background:#ecf5ff; border-radius:4px; padding:2px 8px; }
.detail-head-actions { margin-left:auto; display:flex; gap:8px; flex-wrap:wrap; }
.detail-body { display:flex; gap:16px; align-items:flex-start; }
.panel-img { width:480px; max-width:55%; border-radius:8px; border:1px solid #e8ecf3; background:#0d1526; }
.detail-facts { display:flex; flex-direction:column; gap:10px; flex:1; }
.fact { display:flex; justify-content:space-between; font-size:13px; color:#606266; border-bottom:1px dashed #e8ecf3; padding-bottom:8px; }
.fact b { color:var(--ink,#303133); }
.fact .health-reason { color:#e6a23c; font-weight:500; max-width:70%; text-align:right; }
.t-warn { color:#e6a23c !important; }
.t-bad { color:#f56c6c !important; }

.cards { display:grid; grid-template-columns:repeat(auto-fill, minmax(200px, 1fr)); gap:10px; }
.dev-card { background:#fff; border:1px solid var(--line,#e4e7ed); border-radius:10px; padding:12px; cursor:pointer; transition:border-color .15s, box-shadow .15s; }
.dev-card:hover { border-color:#c4dbf7; box-shadow:0 2px 10px rgba(64,120,220,.12); }
.dev-card.selected { border-color:var(--blue,#409eff); box-shadow:0 0 0 3px rgba(64,158,255,.15); }
.dev-card.alarm { border-color:#fbc4c4; }
.dev-card.off { opacity:.55; }
.dev-head { display:flex; align-items:center; gap:7px; margin-bottom:8px; }
.dev-head b { font-size:14px; color:var(--ink,#303133); }
.dev-status { margin-left:auto; font-size:12px; color:#909399; }
.dev-dot { width:8px; height:8px; border-radius:50%; }
.dev-dot.run { background:#67c23a; }
.dev-dot.idle { background:#e6a23c; }
.dev-dot.down { background:#f56c6c; }
.dev-dot.off { background:#c0c4cc; }
.dev-metrics { display:flex; gap:10px; margin-bottom:8px; }
.metric { flex:1; display:flex; flex-direction:column; font-size:11px; color:#909399; }
.metric b { font-size:14px; color:var(--ink,#303133); }
.load-bar { height:5px; border-radius:3px; background:#f0f2f5; overflow:hidden; margin-bottom:6px; }
.load-fill { height:100%; background:var(--blue,#409eff); border-radius:3px; transition:width .8s ease; }
.dev-job { font-size:11px; color:#b0b6c0; }
</style>

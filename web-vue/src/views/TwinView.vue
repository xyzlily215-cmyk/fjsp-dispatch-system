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
          <button v-else type="button" class="t-btn warning" @click="stopSim">停止虚拟车间</button>
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
          <button type="button" class="t-btn primary small" @click="askAgent(a)">交给 AI 处理</button>
        </div>
      </div>

      <section class="map-card">
        <div class="scene-heading">
          <div><h2>一号车间 · 三维实时视图</h2><p>设备状态与现场位置同步，选择机床查看运行详情</p></div>
          <span class="scene-live"><span class="hub-dot" :class="hubClass"></span>{{ hubText }}</span>
        </div>
        <div class="scene-stage-wrap">
          <TwinStage
            ref="stageRef"
            initial-view="campus"
            :devices="snap.devices"
            :selected-id="selected?.id"
            :zones="snap.world?.places || []"
            :callouts="false"
            labels
            @select="select"
          />
          <div v-if="!snap.devices.length" class="scene-empty">等待设备上线 · 模型将按实时坐标显示</div>
        </div>
        <div class="scene-hint">拖动旋转 · 滚轮缩放 · 点击设备查看详情</div>
        <div class="scene-legend"><span><i class="run"></i>运行 {{ machines.filter(m => m.online && m.status === 'running').length }}</span><span><i class="idle"></i>空闲 {{ machines.filter(m => m.online && m.status === 'idle').length }}</span><span><i class="down"></i>告警 {{ alarms.length }}</span><span><i class="off"></i>离线 {{ machines.filter(m => !m.online).length }}</span><span class="legend-agv">AGV {{ agvs.length }} 台</span></div>
      </section>
      <div class="equipment-heading"><h2>设备运行监测</h2><span>点击卡片与三维模型联动</span></div>

      <div v-if="selected" class="detail-card">
        <div class="detail-head">
          <b>{{ selected.name }}</b>
          <span class="detail-sub">{{ selected.model }} · {{ statusText(selected) }}</span>
          <span v-if="selected.currentJob" class="detail-job">任务 {{ selected.currentJob }}</span>
          <div class="detail-head-actions">
            <template v-if="selected.id.startsWith('cnc-')">
              <button type="button" class="t-btn danger-outline small" @click="injectFault(selected)">注入过热故障</button>
              <button type="button" class="t-btn success small" @click="recover(selected)">恢复正常</button>
            </template>
            <button v-if="isAlarm(selected)" type="button" class="t-btn primary small" @click="askAgent(selected)">交给 AI 处理</button>
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
        <button type="button" v-for="m in machines" :key="m.id" class="dev-card" :aria-pressed="selected?.id === m.id" :class="[{ alarm: isAlarm(m), off: !m.online, selected: selected?.id === m.id }]" @click="select(m)">
          <span class="dev-head">
            <span class="dev-dot" :class="statusClass(m)"></span>
            <b>{{ machineCode(m) }}</b>
            <span class="dev-status">{{ statusText(m) }}</span>
          </span>
          <span class="dev-metrics">
            <span class="metric"><span>温度</span><b :class="tempClass(m)">{{ fmt(m.metrics?.temperature, '°') }}</b></span>
            <span class="metric"><span>振动</span><b>{{ fmt(m.metrics?.vibration, '') }}</b></span>
            <span class="metric"><span>转速</span><b>{{ m.metrics?.spindleRpm ?? '—' }}</b></span>
          </span>
          <span class="load-bar"><span class="load-fill" :style="{ width: Math.min(m.spindleLoad ?? 0, 100) + '%' }"></span></span>
          <span class="dev-job">{{ m.currentJob || '—' }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
/* 数字孪生车间：MHS 虚拟设备实时状态 + 设备控制，AI 助手由全局工作栏提供。
 * 数据：/twin/stream SSE 1Hz 快照；画面：与数据大屏共用的园区级三维场景（TwinStage）+ 设备面板图轮询；
 * 控制：虚拟车间启停、M-03 故障注入/恢复（agent-bff 直控仿真进程，免脚本）；
 * 告警联动：一键请求 AI 处理（附设备快照上下文，衔接 SKILL 的 MHS 告警处置流程）。 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  openTwinStream, twinInjectFault, twinPanelUrl, twinRecover, twinSimStart, twinSimStop,
} from '../api/twin';
import { useAgentStore } from '../stores/agent';
import TwinStage from '../components/TwinStage.vue';

const agent = useAgentStore();
const snap = ref({ hub: 'connecting', devices: [], world: null, sim: null });
const selected = ref(null);
const faultSent = ref(false);
const panelTs = ref(Date.now());
const stageRef = ref(null);

let closeStream = null;
let panelTimer = null;

const machines = computed(() => snap.value.devices.filter((d) => d.kind === 'machine' && d.position));
const agvs = computed(() => snap.value.devices.filter((d) => d.kind === 'agv' && d.position));
const alarms = computed(() => snap.value.devices.filter((d) => isAlarm(d)));
const simRunning = computed(() => !!snap.value.sim?.running);
const hubClass = computed(() => (snap.value.hub === 'connected' ? 'ok' : 'bad'));
const hubText = computed(() => (snap.value.hub === 'connected' ? '设备通道已连接' : '设备通道连接中…'));
const panelSrc = computed(() => (selected.value ? twinPanelUrl(selected.value.id, panelTs.value) : ''));

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
    ElMessage.warning('AI 调度助手正在处理上一轮任务，请稍候或先停止');
    return;
  }
  const temp = d.metrics?.temperature != null ? `${Number(d.metrics.temperature).toFixed(1)}°C` : '未知';
  const vib = d.metrics?.vibration != null ? `${Number(d.metrics.vibration).toFixed(1)}mm/s` : '未知';
  const msg = `设备 ${d.id}（业务机台 ${machineCode(d)}）触发告警：${alarmReason(d)}。`
    + `当前主轴温度 ${temp}、振动 ${vib}、状态 ${statusText(d)}。`
    + `请按 MHS 设备告警处置流程处理：先 read_device 复核设备真实状态，再评估是否需要报故障重调度，写操作我会人工审批。`;
  try {
    await agent.send(msg, { section: '工作台', title: '加工中心', route: 'twin', query: { device: d.id } });
  } catch (e) {
    ElMessage.error(e.message || '发送失败');
  }
}

function applySnapshot(s) {
  snap.value = s;
  if (selected.value) selected.value = s.devices.find((d) => d.id === selected.value.id) || null;
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
.twin-toolbar { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px; }
.twin-status { display:flex; align-items:center; gap:8px; font-size:13px; color:#606266; }
.hub-dot { width:9px; height:9px; border-radius:50%; }
.hub-dot.ok { background:#67c23a; box-shadow:0 0 0 3px rgba(103,194,58,.18); }
.hub-dot.bad { background:#f56c6c; }
.sep { color:#dcdfe6; }
.sim-off { color:#f56c6c; }
.alarm-count { color:#f56c6c; font-weight:600; }
.twin-actions { display:flex; gap:8px; flex-wrap:wrap; }
.t-btn { border:1px solid transparent; background:#e8ecf3; border-radius:6px; padding:7px 14px; font-size:13px; cursor:pointer; color:#3a3a3c; }
.t-btn:hover { background:#dde3ee; }
.t-btn.primary { background:var(--blue,#1677ff); border-color:transparent; color:#fff; }
.t-btn.primary:hover { background:#3d8bff; }
.t-btn.small { padding:4px 10px; font-size:12px; }
.t-btn.warning { background:var(--warning,#fa8c16); border-color:transparent; color:#fff; }
.t-btn.warning:hover:not(:disabled) { background:#ffa940; }
.t-btn.success { background:var(--success,#52c41a); border-color:transparent; color:#fff; }
.t-btn.success:hover:not(:disabled) { background:#69d134; }
.t-btn.danger-outline { border-color:transparent; background:var(--danger,#f5222d); color:#fff; }
.t-btn.danger-outline:hover:not(:disabled) { background:#ff4d4f; }
.t-btn:disabled { opacity:.55; cursor:default; }
.twin-banner { padding:10px 14px; border-radius:8px; background:#fdf6ec; border:1px solid #faecd8; color:#e6a23c; font-size:13px; }

.alarm-strip { display:flex; flex-direction:column; gap:8px; }
.alarm-card { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 14px; border-radius:8px; border:1px solid #fbc4c4; background:#fef0f0; }
.alarm-card.attention { border-color:#f5dab1; background:#fdf6ec; }
.alarm-info { display:flex; align-items:baseline; gap:10px; font-size:13px; }
.alarm-info b { color:#303133; }
.alarm-reason { color:#909399; font-size:12px; }

.map-card { background:var(--el-color-white); border:1px solid var(--line); border-radius:12px; overflow:hidden; }
.scene-stage-wrap { position:relative; height:clamp(420px, 46vw, 600px); }
.scene-controls { position:absolute; top:14px; right:14px; z-index:5; display:flex; gap:6px; }
.scene-controls .t-btn { background:rgba(255,255,255,.88); border:1px solid var(--line); backdrop-filter:blur(4px); }
.scene-empty { position:absolute; left:0; right:0; bottom:60px; text-align:center; color:var(--ink); font-size:12px; pointer-events:none; text-shadow:0 1px 3px rgba(255,255,255,.8); }
.scene-hint { padding:10px 20px; border-top:1px solid var(--line); color:var(--ink); opacity:.7; font-size:11px; }
.scene-heading { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:18px 20px; }
.scene-heading h2,.equipment-heading h2 { margin:0; color:var(--ink); font-size:16px; font-weight:600; }
.scene-heading p { margin:4px 0 0; color:var(--ink); opacity:.7; font-size:12px; }
.scene-live { display:flex; align-items:center; gap:7px; white-space:nowrap; font-size:12px; color:var(--ink); }
.scene-legend { display:flex; align-items:center; flex-wrap:wrap; gap:20px; padding:13px 20px; font-size:12px; color:var(--ink); }
.scene-legend span { display:flex; align-items:center; gap:7px; }
.scene-legend i { width:8px; height:8px; border-radius:50%; }
.scene-legend .run { background:var(--success); }
.scene-legend .idle { background:var(--warning); }
.scene-legend .down { background:var(--danger); }
.scene-legend .off { background:var(--muted); }
.legend-agv { margin-left:auto; }
.equipment-heading { display:flex; justify-content:space-between; align-items:center; margin-top:8px; }
.equipment-heading span { font-size:12px; color:var(--ink); opacity:.7; }
.twin { gap:20px; }
.twin-toolbar { padding:14px 16px; background:var(--el-color-white); border:1px solid var(--line); border-radius:12px; gap:14px; }
.twin-status { flex-wrap:wrap; }
.dev-card { text-align:left; font-variant-numeric:tabular-nums; }
.dev-card:focus-visible,.t-btn:focus-visible { outline:2px solid var(--blue); outline-offset:3px; }
.load-bar,.load-fill,.dev-job { display:block; }
@media (max-width:1280px) { .twin { flex-direction:column; } .twin-main { width:100%; } }
@media (prefers-reduced-motion:reduce) { .load-fill { transition:none; } }

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

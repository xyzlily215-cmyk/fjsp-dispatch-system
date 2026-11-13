<template>
  <div class="screen-viewport">
    <div class="screen-page" :style="{ transform: `translate(-50%, -50%) scale(${scale})` }">
      <!-- 顶栏：品牌 / 梯形标题牌 / 时钟与操作 -->
      <header class="screen-head">
        <div class="screen-head__brand">
          <img class="screen-head__logo" src="/brand-mark.svg" alt="智能调度中心标志" />
          <div class="screen-head__brand-txt">
            <b>智能调度中心</b>
            <span>FLEXIBLE WORKSHOP · FMS CONTROL</span>
          </div>
        </div>
        <div class="screen-head__center">
          <span class="screen-head__wing" aria-hidden="true"></span>
          <div class="screen-head__plate">
            <div class="screen-head__plate-inner">
              <h1><i class="plate-dot" aria-hidden="true"></i>柔性车间智能调度数据大屏<i class="plate-dot" aria-hidden="true"></i></h1>
              <p>FLEXIBLE WORKSHOP INTELLIGENT SCHEDULING DASHBOARD</p>
            </div>
          </div>
          <span class="screen-head__wing screen-head__wing--r" aria-hidden="true"></span>
        </div>
        <div class="screen-head__side">
          <div class="screen-head__clock">
            <b>{{ timeText }}</b>
            <span>{{ dateText }} {{ weekText }}</span>
          </div>
          <button class="ghost-btn" @click="toggleFullscreen">全屏</button>
          <button class="ghost-btn" @click="back">返回系统</button>
        </div>
      </header>

      <!-- 主区：左侧面板列 / 中央 KPI + 场景 / 右侧面板列 -->
      <div class="screen-main">
        <div class="screen-col">
          <PanelFrame title="近 7 日产出与达成率" tag="日" class="rise" style="flex:1;animation-delay:.15s">
            <EchartPanel :option="trendOption" />
          </PanelFrame>
          <PanelFrame title="设备负荷排行" tag="实时" class="rise" style="flex:1;animation-delay:.25s">
            <EchartPanel :option="loadOption" />
          </PanelFrame>
        </div>

        <div class="screen-center">
          <div class="kpi-row rise" style="animation-delay:.05s">
            <MetricCard label="在制订单" tag="WIP" :value="metrics.ordersInProgress ?? 0" unit="单" :delta="metrics.ordersDelta ?? 0" accent="#2CE8FF" />
            <MetricCard label="今日完工" tag="DONE" :value="metrics.doneToday ?? 0" unit="件" :delta="metrics.doneDelta ?? 0" accent="#3B8BFF" />
            <MetricCard label="设备综合利用率" tag="OEE" :value="metrics.utilization ?? 0" unit="%" :delta="metrics.utilizationDelta ?? 0" :decimals="1" accent="#FFC74A" />
            <MetricCard label="订单准时交付率" tag="OTD" :value="metrics.onTimeRate ?? 0" unit="%" :delta="metrics.onTimeDelta ?? 0" :decimals="1" accent="#FF9340" />
          </div>

          <div class="scene-frame rise" style="animation-delay:.2s">
            <TwinStage ref="stageRef" class="scene-stage" :devices="devices" :metrics="metrics" />
            <div class="scene-veil" aria-hidden="true"></div>
            <div class="scene-scan" aria-hidden="true"></div>
            <div class="scene-top">
              <div class="scene-title"><span class="live-dot"></span>柔性车间 · 设备实时孪生视图</div>
            </div>
            <div class="scene-bottom">
              <div class="hud-box">
                在线设备 <b>{{ onlineCount }}</b> 台 · AGV <b>{{ agvCount }}</b> 台 ·
                在制任务 <b>{{ metrics.ordersInProgress ?? 0 }}</b> 条 ·
                异常 <b class="is-danger">{{ downCount }}</b> 项
              </div>
              <div class="stage-legend">
                <span><i class="dot dot--run"></i>运行</span>
                <span><i class="dot dot--idle"></i>待机</span>
                <span><i class="dot dot--down"></i>故障</span>
              </div>
            </div>
          </div>

          <div class="scene-nav rise" style="animation-delay:.3s">
            <button
              v-for="tab in SCENE_TABS"
              :key="tab.key"
              class="nav-btn"
              :class="{ 'is-active': activeTab === tab.key }"
              @click="focusScene(tab.key)"
            >{{ tab.label }}</button>
          </div>
        </div>

        <div class="screen-col">
          <PanelFrame title="设备状态分布" tag="实时" class="rise" style="flex:0 0 208px;animation-delay:.1s">
            <EchartPanel :option="statusOption" carousel />
          </PanelFrame>
          <PanelFrame title="订单进度排行" tag="进度" class="rise" style="flex:1;animation-delay:.2s">
            <ul class="order-list">
              <li v-for="row in orders" :key="row.code" class="order-row">
                <span class="order-row__code">{{ row.code }}</span>
                <span class="order-row__product">{{ row.product }}</span>
                <span class="order-row__bar"><i :class="`is-${row.status}`" :style="{ width: row.progress + '%' }"></i></span>
                <span class="order-row__pct" :class="`is-${row.status}`">{{ row.progress }}%</span>
                <span class="order-row__due">{{ row.due }}</span>
              </li>
            </ul>
          </PanelFrame>
          <PanelFrame title="实时事件流" tag="全部" class="rise" style="flex:0 0 196px;animation-delay:.3s">
            <EventTicker :events="events" />
          </PanelFrame>
        </div>
      </div>

      <!-- 底部甘特 -->
      <div class="screen-bottom">
        <PanelFrame title="实时甘特 · 设备工序流" class="rise" style="height:100%;animation-delay:.35s">
          <template #extra>
            <div class="stage-legend">
              <span><i class="bar bar--done"></i>已完成</span>
              <span><i class="bar bar--running"></i>加工中</span>
              <span><i class="bar bar--queued"></i>待排</span>
              <span><i class="bar bar--exception"></i>异常</span>
            </div>
          </template>
          <GanttStream :lanes="lanes" />
        </PanelFrame>
      </div>

      <!-- 状态栏 -->
      <footer class="screen-foot">
        <span>◈ 数据来源：MES 制造执行系统 / WMS 仓储系统 / IoT 设备网关</span>
        <span>面板刷新 <b class="num">30s</b> · 设备刷新 <b class="num">5s</b> · 最近同步 <span class="num">{{ timeText }}</span></span>
        <span>● <b>系统运行正常</b> | 动态柔性车间生产调度与仿真决策系统</span>
      </footer>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import PanelFrame from './screen/panel-frame.vue';
import MetricCard from './screen/metric-card.vue';
import EchartPanel from './screen/echart-panel.vue';
import EventTicker from './screen/event-ticker.vue';
import GanttStream from './screen/gantt-stream.vue';
import TwinStage from './screen/twin-stage.vue';
import { buildTrendOption, buildLoadOption, buildStatusOption } from './screen/chart-options';
import {
  getScreenMetrics,
  getOutputTrend,
  getMachineLoad,
  getMachineStatus,
  getOrderProgress,
  getRecentEvents,
  getWorkshopDevices,
  getGanttLanes,
} from '../api/screen';

const router = useRouter();

/* 1920×1080 设计稿等比缩放适配任意屏幕 */
const DESIGN_W = 1920;
const DESIGN_H = 1080;
const scale = ref(1);
function fit() {
  scale.value = Math.min(window.innerWidth / DESIGN_W, window.innerHeight / DESIGN_H);
}

const dateText = ref('');
const timeText = ref('');
const weekText = ref('');
function tickClock() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  dateText.value = `${d.getFullYear()}年${pad(d.getMonth() + 1)}月${pad(d.getDate())}日`;
  timeText.value = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  weekText.value = '星期' + '日一二三四五六'[d.getDay()];
}

const metrics = ref({});
const trendRows = ref([]);
const loadRows = ref([]);
const statusRows = ref([]);
const orders = ref([]);
const events = ref([]);
const devices = ref([]);
const lanes = ref([]);

const trendOption = computed(() => buildTrendOption(trendRows.value));
const loadOption = computed(() => buildLoadOption(loadRows.value));
const statusOption = computed(() => buildStatusOption(statusRows.value));

/* 场景 HUD 统计：由实时设备与指标数据推导 */
const onlineCount = computed(() => devices.value.filter(d => d.kind === 'machine' && d.status !== 'down').length);
const downCount = computed(() => devices.value.filter(d => d.kind === 'machine' && d.status === 'down').length);
const agvCount = computed(() => devices.value.filter(d => d.kind === 'agv').length);

/* 场景视角页签 */
const SCENE_TABS = [
  { key: 'overview', label: '综合厂区' },
  { key: 'zoneA', label: '加工区 A' },
  { key: 'zoneB', label: '加工区 B' },
  { key: 'aisle', label: '物流通道' },
];
const stageRef = ref(null);
const activeTab = ref('overview');
function focusScene(key) {
  activeTab.value = key;
  stageRef.value?.focusScene(key);
}

async function loadPanels() {
  const [m, t, l, s, o, e, g] = await Promise.all([
    getScreenMetrics(), getOutputTrend(), getMachineLoad(), getMachineStatus(),
    getOrderProgress(), getRecentEvents(), getGanttLanes(),
  ]);
  metrics.value = m;
  trendRows.value = t;
  loadRows.value = l;
  statusRows.value = s;
  orders.value = o;
  events.value = e;
  lanes.value = g;
}

async function loadDevices() {
  devices.value = await getWorkshopDevices();
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen();
}

function back() {
  router.push({ name: 'board' });
}

let clockTimer, panelTimer, deviceTimer;
onMounted(() => {
  fit();
  window.addEventListener('resize', fit);
  tickClock();
  clockTimer = setInterval(tickClock, 1000);
  loadPanels();
  loadDevices();
  panelTimer = setInterval(loadPanels, 30000);
  deviceTimer = setInterval(loadDevices, 5000);
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', fit);
  clearInterval(clockTimer);
  clearInterval(panelTimer);
  clearInterval(deviceTimer);
});
</script>

<style scoped>
.screen-viewport {
  position: fixed;
  inset: 0;
  overflow: hidden;
  background: #010711;
}

.screen-page {
  --num-font: "Bahnschrift", "DIN Alternate", Consolas, "Arial Narrow", monospace;
  position: absolute;
  left: 50%;
  top: 50%;
  width: 1920px;
  height: 1080px;
  transform-origin: center;
  display: flex;
  flex-direction: column;
  color: #dcefff;
  background: radial-gradient(ellipse 80% 60% at 50% -8%, #0e3f7e 0%, #061a3b 45%, #010814 100%);
}

/* 网格纹理 */
.screen-page::before {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image:
    linear-gradient(rgba(70, 160, 255, 0.045) 1px, transparent 1px),
    linear-gradient(90deg, rgba(70, 160, 255, 0.045) 1px, transparent 1px);
  background-size: 44px 44px;
  mask-image: radial-gradient(ellipse at 50% 40%, #000 30%, transparent 100%);
}

/* ── 顶栏 ── */
.screen-head {
  flex: 0 0 88px;
  display: grid;
  grid-template-columns: 400px 1fr 400px;
  align-items: center;
  padding: 0 22px;
  position: relative;
  z-index: 2;
  background: linear-gradient(180deg, rgba(8, 40, 90, 0.9), rgba(4, 20, 48, 0.15));
  border-bottom: 1px solid rgba(64, 166, 255, 0.25);
}

.screen-head::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  bottom: -1px;
  height: 1px;
  background: linear-gradient(90deg, transparent, #39c9ff 20%, #2a7fff 50%, #39c9ff 80%, transparent);
  box-shadow: 0 0 14px #2a9bff;
}

.screen-head__brand { display: flex; align-items: center; gap: 11px; }

.screen-head__logo {
  width: 44px;
  height: 44px;
  filter: drop-shadow(0 0 8px rgba(50, 190, 255, 0.7));
}

.screen-head__brand-txt b {
  display: block;
  font-size: 19px;
  letter-spacing: 3px;
  background: linear-gradient(180deg, #ffffff, #8fd4ff);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

.screen-head__brand-txt span {
  display: block;
  font-size: 10px;
  letter-spacing: 1.6px;
  color: #6f9cc8;
  margin-top: 3px;
  font-family: var(--num-font);
}

.screen-head__center {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 18px;
  height: 100%;
}

.screen-head__wing {
  width: 170px;
  height: 26px;
  background: repeating-linear-gradient(115deg, rgba(60, 190, 255, 0.55) 0 3px, transparent 3px 9px);
  mask-image: linear-gradient(90deg, transparent, #000);
  opacity: 0.7;
}

.screen-head__wing--r { transform: scaleX(-1); }

.screen-head__plate {
  min-width: 640px;
  padding: 2px;
  background: linear-gradient(180deg, #54d9ff, #1660b8 55%, #0d3f86);
  clip-path: polygon(26px 0, calc(100% - 26px) 0, 100% 100%, 0 100%);
  filter: drop-shadow(0 0 12px rgba(30, 140, 255, 0.55));
}

.screen-head__plate-inner {
  background: linear-gradient(180deg, #0b3268 0%, #051a3e 100%);
  clip-path: polygon(25px 0, calc(100% - 25px) 0, 100% 100%, 0 100%);
  padding: 7px 54px 8px;
  text-align: center;
}

.screen-head__plate-inner h1 {
  margin: 0;
  font-size: 28px;
  font-weight: 700;
  letter-spacing: 7px;
  color: #e9f8ff;
  text-shadow: 0 0 18px rgba(90, 210, 255, 0.85), 0 0 40px rgba(30, 120, 255, 0.5);
  white-space: nowrap;
}

.plate-dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  background: #2ce8ff;
  transform: rotate(45deg);
  vertical-align: middle;
  margin: 0 12px 3px;
  box-shadow: 0 0 10px #2ce8ff;
}

.screen-head__plate-inner p {
  margin: 2px 0 0;
  font-size: 9px;
  letter-spacing: 2.4px;
  color: #62a9e0;
  font-family: var(--num-font);
}

.screen-head__side {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
}

.screen-head__clock { text-align: right; margin-right: 6px; }

.screen-head__clock b {
  display: block;
  font-family: var(--num-font);
  font-size: 24px;
  letter-spacing: 2px;
  color: #eaf8ff;
  text-shadow: 0 0 12px rgba(60, 190, 255, 0.7);
  line-height: 1.1;
}

.screen-head__clock span { font-size: 10px; color: #7fa9d2; letter-spacing: 0.5px; }

.ghost-btn {
  font-size: 12px;
  padding: 6px 12px;
  border: 1px solid rgba(70, 170, 255, 0.45);
  background: linear-gradient(180deg, rgba(20, 90, 170, 0.45), rgba(8, 35, 80, 0.5));
  color: #bfe4ff;
  clip-path: polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px);
  cursor: pointer;
  transition: 0.2s;
}

.ghost-btn:hover {
  background: linear-gradient(180deg, #1c7ede, #0b4a9c);
  color: #fff;
  box-shadow: 0 0 12px rgba(50, 170, 255, 0.5);
}

/* ── 主区三栏 ── */
.screen-main {
  flex: 0 0 700px;
  display: grid;
  grid-template-columns: 352px minmax(0, 1fr) 352px;
  gap: 14px;
  padding: 12px 22px 0;
  position: relative;
  z-index: 1;
  min-height: 0;
}

.screen-col {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 0;
}

.screen-center {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  min-height: 0;
}

.kpi-row {
  flex: 0 0 112px;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}

/* ── 中央场景面板 ── */
.scene-frame {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  border: 1px solid rgba(64, 166, 255, 0.42);
  background: #071a38;
  box-shadow: inset 0 0 60px rgba(0, 20, 70, 0.6);
}

.scene-frame::after {
  content: "";
  position: absolute;
  inset: 8px;
  pointer-events: none;
  border: 1px solid rgba(70, 190, 255, 0.16);
  z-index: 3;
}

.scene-stage { position: absolute; inset: 0; }

.scene-veil {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 2;
  background:
    linear-gradient(90deg, rgba(3, 14, 38, 0.55), transparent 20%, transparent 80%, rgba(3, 14, 38, 0.55)),
    linear-gradient(180deg, rgba(3, 14, 38, 0.5), transparent 22%, transparent 74%, rgba(3, 14, 38, 0.62));
}

.scene-scan {
  position: absolute;
  left: 0;
  right: 0;
  height: 70px;
  z-index: 2;
  pointer-events: none;
  background: linear-gradient(180deg, transparent, rgba(60, 200, 255, 0.1), transparent);
  animation: scan 7s linear infinite;
}

@keyframes scan {
  0% { top: -70px; }
  100% { top: 100%; }
}

.scene-top {
  position: absolute;
  left: 14px;
  right: 14px;
  top: 12px;
  display: flex;
  justify-content: space-between;
  z-index: 4;
  pointer-events: none;
}

.scene-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  letter-spacing: 1.5px;
  color: #dff4ff;
  background: rgba(4, 24, 58, 0.76);
  border: 1px solid rgba(70, 180, 255, 0.4);
  padding: 6px 12px;
  clip-path: polygon(0 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%);
}

.live-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #22e6a8;
  box-shadow: 0 0 10px #22e6a8;
  animation: pulse 1.6s infinite;
}

@keyframes pulse {
  50% { opacity: 0.35; transform: scale(0.75); }
}

.scene-bottom {
  position: absolute;
  left: 14px;
  right: 14px;
  bottom: 12px;
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  z-index: 4;
  pointer-events: none;
}

.hud-box {
  background: rgba(4, 22, 54, 0.75);
  border: 1px solid rgba(70, 170, 255, 0.32);
  padding: 7px 11px;
  font-size: 11px;
  color: #a7cbe8;
  letter-spacing: 0.5px;
}

.hud-box b {
  font-family: var(--num-font);
  color: #2ce8ff;
  font-size: 14px;
  font-weight: 500;
  padding: 0 2px;
}

.hud-box b.is-danger { color: #ff5470; }

/* ── 场景视角页签 ── */
.scene-nav {
  flex: 0 0 42px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 6px;
  background: linear-gradient(180deg, rgba(10, 42, 90, 0.55), rgba(4, 18, 44, 0.75));
  border: 1px solid rgba(64, 166, 255, 0.28);
}

.nav-btn {
  font-size: 12px;
  letter-spacing: 1px;
  padding: 7px 18px;
  color: #9dc4e6;
  border: 1px solid rgba(70, 160, 240, 0.3);
  background: rgba(8, 36, 80, 0.6);
  cursor: pointer;
  transition: 0.2s;
}

.nav-btn:hover, .nav-btn.is-active {
  color: #fff;
  background: linear-gradient(180deg, #1f8ae8, #0a4a9c);
  border-color: #5ec8ff;
  box-shadow: 0 0 14px rgba(40, 160, 255, 0.5);
}

/* ── 底部甘特 ── */
.screen-bottom {
  flex: 0 0 252px;
  padding: 12px 22px 0;
  position: relative;
  z-index: 1;
}

/* ── 状态栏 ── */
.screen-foot {
  flex: 0 0 40px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 26px;
  font-size: 11px;
  color: #6d93ba;
  letter-spacing: 0.5px;
  border-top: 1px solid rgba(60, 150, 230, 0.2);
  background: linear-gradient(180deg, transparent, rgba(4, 22, 52, 0.6));
  position: relative;
  z-index: 1;
}

.screen-foot b { color: #22e6a8; font-weight: 500; }
.screen-foot .num { font-family: var(--num-font); }

/* 入场动画：面板依次上浮。不加 fill-mode——隐藏标签页里 CSS 动画被暂停时，
 * both/backwards 会把面板钉在 opacity:0 的 from 帧，投屏或后台截图就只剩骨架 */
@media (prefers-reduced-motion: no-preference) {
  .rise {
    animation: rise 0.7s cubic-bezier(0.22, 1, 0.36, 1);
  }
}

@keyframes rise {
  from { opacity: 0; transform: translateY(26px); }
  to { opacity: 1; transform: translateY(0); }
}

/* ── 图例 ── */
.stage-legend {
  display: flex;
  gap: 14px;
  font-size: 12px;
  color: #8fb8d8;
  align-items: center;
}

.stage-legend span { display: flex; align-items: center; gap: 5px; white-space: nowrap; }

.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.dot--run { background: #22e6a8; box-shadow: 0 0 6px #22e6a8; }
.dot--idle { background: #2d8cff; box-shadow: 0 0 6px #2d8cff; }
.dot--down { background: #ff4d5e; box-shadow: 0 0 6px #ff4d5e; }

.bar { width: 14px; height: 8px; border-radius: 1px; display: inline-block; }
.bar--done { background: linear-gradient(90deg, #16458f, #3b7fe0); }
.bar--running { background: linear-gradient(90deg, #0b5f9e, #1cbde6); box-shadow: 0 0 6px rgba(44, 232, 255, 0.8); }
.bar--queued { background: transparent; border: 1px dashed #5f7a99; }
.bar--exception { background: linear-gradient(90deg, #8e1e36, #f2516b); box-shadow: 0 0 6px rgba(255, 84, 112, 0.8); }

/* ── 订单进度排行 ── */
.order-list {
  list-style: none;
  margin: 0;
  padding: 4px 4px 0;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  justify-content: space-around;
}

.order-row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  color: #c6d9ec;
}

.order-row__code {
  width: 74px;
  color: #2ce8ff;
  font-family: var(--num-font);
  flex-shrink: 0;
}

.order-row__product { width: 62px; flex-shrink: 0; color: #8fb8d8; }

.order-row__bar {
  flex: 1;
  height: 8px;
  background: rgba(10, 45, 90, 0.75);
  border: 1px solid rgba(60, 150, 230, 0.22);
  overflow: hidden;
}

.order-row__bar i {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, #0a4f96, #2ce8ff);
  box-shadow: 0 0 8px rgba(44, 232, 255, 0.5);
  transition: width 0.8s ease;
}

.order-row__bar i.is-warning { background: linear-gradient(90deg, #a8550c, #ffb03a); box-shadow: 0 0 8px rgba(255, 160, 60, 0.5); }
.order-row__bar i.is-danger { background: linear-gradient(90deg, #8b1730, #ff5470); box-shadow: 0 0 8px rgba(255, 84, 112, 0.5); }

.order-row__pct {
  width: 44px;
  text-align: right;
  font-family: var(--num-font);
  color: #d8e9f7;
  flex-shrink: 0;
}

.order-row__pct.is-warning { color: #ffb020; }
.order-row__pct.is-danger { color: #ff5470; }

.order-row__due {
  width: 46px;
  text-align: right;
  color: #5f7a99;
  font-size: 12px;
  font-family: var(--num-font);
  flex-shrink: 0;
}
</style>

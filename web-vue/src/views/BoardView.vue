<template>
  <div v-if="loading" class="loading-block"><div class="spin"></div><div>正在加载看板数据…</div></div>
  <div v-else-if="fatalError">
    <div class="page-header"><div><h1>调度看板</h1><p>当前发布计划的生产运行概览</p></div></div>
    <section class="card"><div class="section-pad">
      <ErrorBox :error="fatalError" title="看板数据加载失败" />
      <button class="btn primary" @click="load">重试</button>
    </div></section>
  </div>
  <div v-else class="board-page">
    <section class="bd-hero" aria-label="车间生产态势总览">
      <div class="bd-hero-grid" aria-hidden="true"></div>
      <div class="bd-hero-glow" aria-hidden="true"></div>
      <div class="bd-hero-top">
        <div>
          <div class="bd-hero-eyebrow"><span class="bd-pulse" :class="plan ? 'on' : 'idle'"></span>{{ plan ? '计划执行中' : '待排程' }} · {{ nowLabel }}</div>
          <h1 class="bd-hero-title">调度看板</h1>
          <p class="bd-hero-sub">
            <template v-if="plan">{{ filters.planVersionId ? '所选计划' : '当前发布计划' }} <b>{{ plan.versionCode }}</b> · {{ windowLabel }}<template v-if="win.from"> · {{ fmtDateTime(win.from) }} ~ {{ fmtDateTime(win.to) }}</template></template>
            <template v-else-if="pendingReview">{{ pendingReview }} 个方案待审核，发布后即可查看排程指标；下方为订单与设备基础态势。</template>
            <template v-else>尚无发布计划，下方统计基于订单与设备基础数据实时计算。</template>
          </p>
        </div>
        <div class="bd-hero-actions">
          <button class="bd-btn ghost" @click="refresh"><AppIcon name="refresh" />刷新</button>
          <button v-if="!plan" class="bd-btn primary" @click="router.push({ name: pendingReview ? 'review' : 'baseline' })"><AppIcon v-if="!pendingReview" name="plus" />{{ pendingReview ? '查看待审核方案' : '创建基线排程' }}</button>
          <button v-else class="bd-btn ghost" @click="router.push({ name: 'baseline' })"><AppIcon name="plus" />新建排程</button>
          <details v-role="['ADMIN']" class="board-more">
            <summary class="bd-btn ghost">更多</summary>
            <div class="board-more-menu"><button type="button" @click="resetDemo">重置演示数据</button></div>
          </details>
        </div>
      </div>
      <div class="bd-hero-stats">
        <div v-for="s in heroStats" :key="s.label" class="bd-hero-stat" :class="s.tone">
          <div class="bd-hero-stat-label">{{ s.label }}</div>
          <div class="bd-hero-stat-value">{{ s.value }}<small>{{ s.unit }}</small></div>
          <div class="bd-hero-stat-sub">{{ s.sub }}</div>
        </div>
      </div>
    </section>

    <div v-if="loadError" class="error-box" style="margin-bottom:14px">
      <b>看板数据刷新失败，以下为最近一次成功数据</b>{{ errMsg(loadError) }}
      <div style="margin-top:8px"><button class="btn small" @click="load">重试</button></div>
    </div>
    <div v-if="ordersError" class="error-box" style="margin-bottom:14px">
      <b>订单数据加载失败，生产态势统计暂不可用</b>{{ errMsg(ordersError) }}
    </div>

    <template v-if="plan">
      <section class="card board-controls" aria-label="看板筛选">
        <div class="board-filter-row">
          <label class="board-filter">计划版本
            <select class="field" :value="filters.planVersionId || ''" @change="onVersionChange">
              <option value="">当前发布计划（自动）</option>
              <option v-for="o in versionOptions" :key="o.id" :value="o.id">{{ o.label }}</option>
            </select>
          </label>
          <label class="board-filter">时间窗口
            <select v-model="windowSel" class="field" @change="onWindowChange">
              <option value="SHIFT">当前班次</option>
              <option value="LAST_24H">最近 24 小时</option>
              <option value="CUSTOM">自定义</option>
            </select>
          </label>
          <span class="board-summary-detail" :class="{ 'has-exceptions': exItems.length }">{{ exItems.length ? `${exItems.length} 项异常记录` : '当前窗口无异常记录' }}</span>
        </div>
        <div v-if="windowSel === 'CUSTOM'" class="board-custom-range">
          <label class="board-filter">起始时间 <input v-model="customFrom" type="datetime-local" class="field"></label>
          <label class="board-filter">结束时间 <input v-model="customTo" type="datetime-local" class="field"></label>
          <button class="btn primary" @click="applyRange">应用时间窗口</button>
        </div>
      </section>

      <section v-if="exItems.length" class="card warning-card board-attention">
        <div class="card-title">异常记录 <span class="board-attention-count">{{ exItems.length }} 项</span></div>
        <div class="warning-list">
          <button v-for="(it, idx) in exItems" :key="idx" type="button" class="alert clickable" @click="openException(it)">
            <span class="severity">!</span>
            <div>
              <div class="alert-name"><span class="tag" :class="severityOf(it)[1]">{{ severityOf(it)[0] }} · {{ exTypeText(it.type) }}</span></div>
              <div class="alert-desc">{{ exceptionDesc(it) }} · {{ fmtDateTime(it.at) }}</div>
            </div>
            <span class="tag blue">查看</span>
          </button>
        </div>
      </section>
      <div class="bd-section-title">排程指标<span>计划版本 {{ plan.versionCode }}</span></div>
      <div class="kpis">
        <article v-for="c in kpiCards" :key="c.jump" class="kpi" :class="c.active ? `needs-${c.tone}` : ''" role="button" tabindex="0" :aria-label="c.label + '，' + c.value + (c.unit || '') + '，查看详情'" title="点击查看详情" @click="kpiJump(c.jump)" @keydown.enter.space.prevent="kpiJump(c.jump)">
          <div class="kpi-label">{{ c.label }}</div>
          <div class="kpi-value">{{ c.value }}<span class="kpi-unit">{{ c.unit || '' }}</span></div>
          <div class="trend">{{ c.sub || '' }}</div>
        </article>
      </div>
    </template>

    <template v-if="stats">
      <div class="bd-section-title">生产态势<span>基于订单与设备基础数据 · 排程前理论值</span></div>
      <div class="bd-grid">
        <section class="bd-card bd-span-2">
          <header class="bd-card-head"><h2>设备理论负荷</h2><span>候选工序工时按可选设备均摊 / 计划周期 {{ fmtMinutes(stats.totals.horizonMinutes) }}</span></header>
          <EchartPanel class="bd-chart" :option="loadOption" />
        </section>
        <section class="bd-card">
          <header class="bd-card-head"><h2>交期紧迫度</h2><span>最短加工链 / 交付窗口</span></header>
          <div class="bd-donut">
            <EchartPanel class="bd-chart small" :option="urgencyChartOption" />
            <ul class="bd-legend">
              <li v-for="u in stats.urgency" :key="u.key" :class="u.key">
                <i></i><span>{{ u.label }}<small>{{ urgencyRange(u) }}</small></span><b>{{ u.orders }}</b>
              </li>
            </ul>
          </div>
        </section>

        <section class="bd-card bd-span-2">
          <header class="bd-card-head"><h2>交期分布</h2><span>按小时统计订单到期数量</span></header>
          <EchartPanel class="bd-chart" :option="dueOption" />
        </section>
        <section class="bd-card">
          <header class="bd-card-head"><h2>交期风险订单</h2><a @click="router.push({ name: 'orders' })">全部订单</a></header>
          <ol class="bd-risk-list">
            <li v-for="r in stats.riskOrders" :key="r.orderId" :class="r.level.key">
              <div class="bd-risk-main">
                <b>{{ r.orderCode }}</b>
                <span>{{ r.productFamily }} · {{ r.quantity }} 件 · P{{ r.priority }} · 交期 {{ fmtTime(r.dueAt) }}</span>
              </div>
              <div class="bd-risk-meter" :aria-label="`紧迫度 ${Math.round(r.urgency * 100)}%`">
                <div class="bd-risk-bar"><i :style="{ width: Math.min(100, r.urgency * 100) + '%' }"></i></div>
                <em>{{ r.level.label }} {{ Math.round(r.urgency * 100) }}%</em>
              </div>
            </li>
            <li v-if="!stats.riskOrders.length" class="bd-empty-line">暂无在制订单</li>
          </ol>
        </section>

        <section class="bd-card">
          <header class="bd-card-head"><h2>产品族构成</h2><span>订单数 · 件数</span></header>
          <div class="bd-stack" role="img" :aria-label="familyAria">
            <i v-for="(f, i) in stats.families" :key="f.family" :style="{ flexGrow: f.orders, background: familyColor(i) }"></i>
          </div>
          <ul class="bd-family-list">
            <li v-for="(f, i) in stats.families" :key="f.family">
              <span class="bd-swatch" :style="{ background: familyColor(i) }"></span>
              <span class="bd-family-name">{{ f.family }}</span>
              <b>{{ f.orders }} 单</b>
              <small>{{ f.quantity }} 件 · {{ pctOf(f.orders, stats.totals.orders) }}</small>
            </li>
          </ul>
        </section>
        <section class="bd-card">
          <header class="bd-card-head"><h2>订单优先级</h2><span>P5 最高 · 求解权重 8</span></header>
          <div class="bd-prio">
            <div v-for="(p, i) in stats.priorities" :key="p.level" class="bd-prio-row">
              <span>P{{ p.level }}</span>
              <div class="bd-prio-track"><i :style="{ width: barPct(p.orders, maxPriority), background: prioColor(p.level) }"></i></div>
              <b>{{ p.orders }}</b>
            </div>
          </div>
        </section>
        <section class="bd-card bd-flow-card">
          <header class="bd-card-head"><h2>订单流转</h2><span>待排程 → 已排程 → 生产中 → 已完成</span></header>
          <div class="bd-flow">
            <div v-for="s in flowSteps" :key="s.key" class="bd-flow-step" :class="{ active: s.count > 0 }">
              <b>{{ s.count }}</b><span>{{ s.label }}</span>
            </div>
          </div>
          <div class="bd-wc">
            <div v-for="w in stats.workCenters" :key="w.workCenterId" class="bd-wc-item">
              <span>{{ w.workCenterId.replace('WC-', '') }}</span>
              <b>{{ w.active }}<small>/{{ w.total }} 台在线</small></b>
            </div>
          </div>
        </section>
      </div>
    </template>

    <div class="bd-section-title">动态<span>最近事件与算法任务</span></div>
    <div class="dash-grid">
      <section class="card">
        <div class="card-title">最近事件<a @click="router.push({ name: 'insert' })">登记事件</a></div>
        <div class="card-body" style="max-height:430px;overflow:auto">
          <template v-if="dash.recentEvents.length">
            <div v-for="(ev, i) in dash.recentEvents" :key="i" class="event-row">
              <div class="event-time">{{ fmtTime(ev.occurredAt) }}</div>
              <div>
                <div class="event-name">{{ eventName(ev) }}</div>
                <div class="event-desc">{{ ev.status || '' }}</div>
              </div>
              <StatusTag :status="ev.status" />
            </div>
          </template>
          <div v-else class="empty-screen" style="padding:30px">{{ plan ? '时间窗口内暂无事件' : '暂无事件，可登记插单或设备故障' }}</div>
        </div>
      </section>
      <section class="card">
        <div class="card-title">算法任务<a @click="router.push({ name: 'tasks' })">全部任务</a></div>
        <div class="card-body" style="max-height:430px;overflow:auto">
          <template v-if="dash.recentTasks.length">
            <div v-for="t in dash.recentTasks" :key="t.taskId" class="task-row clickable" @click="openTask(t.taskId)">
              <div style="min-width:0"><b>{{ t.taskCode }}</b> <span class="muted">{{ t.mode || '' }}</span>
                <div class="task-meta">{{ fmtDateTime(t.createdAt) }} · 耗时 {{ fmtElapsedMs(t.elapsedMs) }}</div>
                <div v-if="isActiveTask(t)" style="margin-top:4px;height:4px;border-radius:2px;background:#ebeef5">
                  <div style="height:4px;border-radius:2px;background:var(--blue)" :style="{ width: Math.min(100, taskProgress(t)) + '%' }"></div>
                </div>
              </div>
              <StatusTag :status="t.status" />
              <div class="task-actions">{{ isActiveTask(t) ? taskProgress(t) + '%' : '查看详情' }}</div>
            </div>
          </template>
          <div v-else class="empty-screen" style="padding:30px">暂无任务，创建基线排程后在此跟踪求解进度</div>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { Api } from '../api';
import { toast, toastErr } from '../utils/ui';
import {
  fmtTime, fmtDateTime, fmtMinutes, fmtPct,
  localInputToIso, isoToLocalInput, errMsg, statusTagInfo, impactText,
} from '../utils/format';
import { useSharedStore } from '../stores/shared';
import StatusTag from '../components/StatusTag.vue';
import ErrorBox from '../components/ErrorBox.vue';
import AppIcon from '../components/AppIcon.vue';
import EchartPanel from './screen/echart-panel.vue';
import { buildBoardStats, URGENCY_LEVELS } from '../utils/boardStats.js';
import { BOARD_COLORS, machineLoadOption, dueDistributionOption, urgencyOption } from '../utils/boardCharts.js';

const BOARD_FILTERS_KEY = 'fjsp.board.filters';

function loadBoardFilters() {
  try {
    const f = JSON.parse(localStorage.getItem(BOARD_FILTERS_KEY)) || {};
    if (!f.window) f.window = 'SHIFT';
    // 自定义窗口缺起止时间时回退当前班次，避免后端 400
    if (f.window === 'CUSTOM' && (!f.from || !f.to)) f.window = 'SHIFT';
    return f;
  } catch (e) { return { window: 'SHIFT' }; }
}
function saveBoardFilters(f) { localStorage.setItem(BOARD_FILTERS_KEY, JSON.stringify(f)); }

function dashboardParams(f) {
  const p = {};
  if (f.planVersionId) p.planVersionId = f.planVersionId;
  if (f.window) p.window = f.window;
  if (f.window === 'CUSTOM') { p.from = f.from; p.to = f.to; }
  return p;
}

const BOARD_EX_SEVERITY = { 3: ['高', 'red'], 2: ['中', 'orange'], 1: ['低', 'gray'] };
const BOARD_EX_TYPE = {
  DELAYED_ORDER: '延期订单', BREAKDOWN: '设备故障',
  INFEASIBLE_TASK: '不可行任务', EXECUTION_DEVIATION: '执行偏差',
};

const router = useRouter();
const shared = useSharedStore();

const filters = reactive(loadBoardFilters());
const windowSel = ref(filters.window);
const customFrom = ref(isoToLocalInput(filters.from));
const customTo = ref(isoToLocalInput(filters.to));
const dash = ref(null);
const versions = ref([]);
const loading = ref(true);
const fatalError = ref(null);   // 无缓存时的致命错误（整页错误态）
const loadError = ref(null);    // 有缓存时的刷新失败（顶部提示 + 旧数据）
const orders = ref([]);
const machineList = ref([]);
const ordersError = ref(null);  // 订单/设备基础数据失败只影响生产态势区，不拖垮整页

async function load() {
  loading.value = true;
  fatalError.value = null;
  loadError.value = null;
  try {
    const basics = Promise.all([Api.orders(), Api.machines()])
      .then(([o, m]) => { orders.value = o; machineList.value = m; ordersError.value = null; })
      .catch((e) => { ordersError.value = e; });
    const [d, v] = await Promise.all([Api.dashboard(dashboardParams(filters)), Api.planVersions()]);
    await basics;
    dash.value = d;
    versions.value = v;
    // 指定版本时 Shared 保留全局"当前发布计划"语义，避免其他页面误读选中版本
    if (!filters.planVersionId) shared.dashboard = d;
    shared.boardCache = { dash: d, versions: v };
  } catch (e) {
    // 持久化选中的计划版本已被重置/删除：回退到当前发布计划并重试
    if (filters.planVersionId && e && e.code === 'E_NOT_FOUND') {
      delete filters.planVersionId;
      saveBoardFilters(filters);
      loading.value = false;
      return load();
    }
    if (shared.boardCache) {
      // 超时/失败：保留最近一次成功数据
      dash.value = shared.boardCache.dash;
      versions.value = shared.boardCache.versions;
      loadError.value = e;
    } else {
      fatalError.value = e;
    }
  } finally {
    loading.value = false;
    windowSel.value = filters.window;
    customFrom.value = isoToLocalInput(filters.from);
    customTo.value = isoToLocalInput(filters.to);
  }
}

const plan = computed(() => dash.value && dash.value.currentPlan);
const kpi = computed(() => (plan.value && plan.value.kpi) || {});
const win = computed(() => (dash.value && dash.value.timeWindow) || {});
const windowLabel = computed(() => ({ SHIFT: '当前班次', LAST_24H: '最近 24 小时', CUSTOM: '自定义' }[win.value.window] || '全部'));

const pendingReview = computed(() => versions.value.filter(v => v.status === 'REVIEW_PENDING').length);
const downMachines = computed(() => (dash.value ? dash.value.machines.filter(m => m.status !== 'ACTIVE').length : 0));
const breakdowns = computed(() => (dash.value && dash.value.exceptions && dash.value.exceptions.breakdowns) || []);
const exItems = computed(() => (dash.value && dash.value.exceptions && dash.value.exceptions.items) || []);
const avgUtil = computed(() => {
  const utils = kpi.value.utilizationByMachine ? Object.values(kpi.value.utilizationByMachine) : [];
  return utils.length ? utils.reduce((a, b) => a + b, 0) / utils.length : null;
});

// 版本下拉：展示发布过的版本（已发布/执行中/已替代/已关闭），默认当前发布计划
const SELECTABLE_STATUSES = ['PUBLISHED', 'EXECUTING', 'SUPERSEDED', 'CLOSED'];
const versionOptions = computed(() => {
  const selectable = versions.value.filter(v => SELECTABLE_STATUSES.includes(v.status));
  const opts = selectable.map(v => ({
    id: v.id,
    label: `${v.versionCode} · ${statusTagInfo(v.status)[1]} · ${fmtDateTime(v.publishedAt)}`,
  }));
  const selectedId = filters.planVersionId || '';
  // 指定的版本不在可发布列表（如历史草稿）时仍回显，避免下拉丢值
  if (selectedId && !selectable.some(v => v.id === selectedId) && plan.value) {
    opts.push({ id: plan.value.id, label: `${plan.value.versionCode} · ${statusTagInfo(plan.value.status)[1]}` });
  }
  return opts;
});

// ---- 生产态势：订单 + 设备基础数据，无排程也可出数 ----
const stats = computed(() => (orders.value.length || machineList.value.length
  ? buildBoardStats(orders.value, machineList.value) : null));
const loadOption = computed(() => machineLoadOption(stats.value ? stats.value.machineLoad : []));
const dueOption = computed(() => dueDistributionOption(stats.value ? stats.value.dueBuckets : []));
const urgencyChartOption = computed(() => {
  const s = stats.value;
  const active = s ? s.urgency.reduce((n, u) => n + u.orders, 0) : 0;
  return urgencyOption(s ? s.urgency : [], active);
});
const maxPriority = computed(() => Math.max(1, ...(stats.value ? stats.value.priorities.map(p => p.orders) : [0])));
const flowSteps = computed(() => {
  const b = stats.value ? stats.value.byStatus : {};
  return [
    { key: 'WAITING', label: '待排程', count: b.WAITING || 0 },
    { key: 'SCHEDULED', label: '已排程', count: b.SCHEDULED || 0 },
    { key: 'RUNNING', label: '生产中', count: b.RUNNING || 0 },
    { key: 'COMPLETED', label: '已完成', count: b.COMPLETED || 0 },
  ];
});
const familyAria = computed(() => (stats.value
  ? '产品族构成：' + stats.value.families.map(f => `${f.family} ${f.orders} 单`).join('，') : ''));

function familyColor(i) { return BOARD_COLORS.series[i] || '#8e8e93'; } // 第 4 个以后统一灰色（不生成新色相）
function prioColor(level) { return BOARD_COLORS.ramp[level - 1]; }
function barPct(v, max) { return `${Math.max(v ? 4 : 0, (v / max) * 100)}%`; }
function pctOf(v, total) { return total ? `${Math.round((v / total) * 100)}%` : '-'; }
function urgencyRange(u) {
  const i = URGENCY_LEVELS.findIndex(l => l.key === u.key);
  const hi = i > 0 ? URGENCY_LEVELS[i - 1].min : null;
  return hi === null ? `≥ ${Math.round(u.min * 100)}%` : `${Math.round(u.min * 100)}–${Math.round(hi * 100)}%`;
}

// 顶部总览：有计划时突出计划 KPI，无计划时用基础数据统计，保证首屏始终有数
const heroStats = computed(() => {
  const s = stats.value;
  const t = s ? s.totals : null;
  const base = [
    { label: '在制订单', value: t ? t.orders - (s.byStatus.COMPLETED || 0) : '-', unit: '单', sub: t ? `${t.quantity} 件 · ${t.operations} 道工序` : '订单数据未加载' },
    { label: '设备在线', value: t ? t.activeMachines : '-', unit: t ? `/${t.machines}` : '', sub: t ? `${s.workCenters.length} 个工作中心` : '-', tone: t && t.activeMachines < t.machines ? 'warn' : '' },
    { label: '交期高风险', value: t ? t.highRisk : '-', unit: '单', sub: '加工链占交付窗口 ≥ 50%', tone: t && t.highRisk ? 'danger' : '' },
  ];
  if (plan.value) {
    const k = kpi.value;
    return [
      ...base.slice(0, 2),
      { label: '总完工时间', value: fmtMinutes(k.cMaxMinutes), unit: '', sub: `计划 ${plan.value.versionCode}` },
      { label: '延期订单', value: k.nTardy ?? '-', unit: '单', sub: `加权拖期 ${fmtMinutes(k.weightedTardinessMinutes)}`, tone: k.nTardy > 0 ? 'danger' : '' },
      { label: '平均利用率', value: avgUtil.value === null ? '-' : fmtPct(avgUtil.value), unit: '', sub: `负荷不均衡度 ${k.loadImbalance ?? '-'}` },
    ];
  }
  return [
    ...base,
    { label: '理论最短工时', value: t ? fmtMinutes(t.minWorkMinutes) : '-', unit: '', sub: t ? `计划周期 ${fmtMinutes(t.horizonMinutes)}` : '-' },
    { label: '理论负荷率', value: t && t.theoreticalLoad !== null ? fmtPct(t.theoreticalLoad) : '-', unit: '', sub: '最短工时 ÷ 周期 × 设备' },
  ];
});

const now = ref(new Date());
const clock = setInterval(() => { now.value = new Date(); }, 30000);
onBeforeUnmount(() => clearInterval(clock));
const nowLabel = computed(() => fmtDateTime(now.value.toISOString()));

const kpiCards = computed(() => {
  const k = kpi.value;
  const d = dash.value;
  return [
    { jump: 'machinesDown', label: '故障/异常设备', value: downMachines.value, unit: '台', sub: `${breakdowns.value.length} 起窗口内故障事件`, tone: 'danger', active: downMachines.value > 0 },
    { jump: 'delayed', label: '延期订单数', value: k.nTardy ?? '-', unit: '单', sub: `共 ${d.orderStats.total} 单`, tone: 'danger', active: k.nTardy > 0 },
    { jump: 'review', label: '待审核方案', value: pendingReview.value, unit: '个', sub: '等待审核发布', tone: 'warning', active: pendingReview.value > 0 },
    { jump: 'cmax', label: '总完工时间 C_max', value: fmtMinutes(k.cMaxMinutes), unit: '', sub: `计划版本 ${plan.value.versionCode}` },
    { jump: 'tardiness', label: '加权拖期', value: fmtMinutes(k.weightedTardinessMinutes), unit: '', sub: `延期订单 ${k.nTardy ?? '-'} 单` },
    { jump: 'utilization', label: '平均设备利用率', value: avgUtil.value === null ? '-' : fmtPct(avgUtil.value), unit: '', sub: `负荷不均衡度 ${k.loadImbalance ?? '-'}` },
  ];
});

function fmtElapsedMs(ms) {
  if (ms === null || ms === undefined) return '-';
  return ms >= 60000 ? (Math.round(ms / 6000) / 10) + ' min' : (Math.round(ms / 100) / 10) + ' s';
}

function eventName(ev) {
  let s = `${ev.eventCode} ${ev.eventType === 'BREAKDOWN' ? '设备故障' : '新订单'}`;
  if (ev.machineId) s += ' · ' + ev.machineId;
  if (ev.subType) {
    s += ' · ' + (impactText(ev.subType) === ev.subType
      ? (ev.subType === 'URGENT_INSERT' ? '紧急插单' : '常规追加')
      : impactText(ev.subType));
  }
  if (ev.impactCount) s += ' · 影响 ' + ev.impactCount + ' 工序';
  return s;
}

function taskProgress(t) {
  return t.progress === null || t.progress === undefined ? 0 : t.progress;
}
function isActiveTask(t) {
  return t.status === 'RUNNING' || t.status === 'PENDING' || t.status === 'RETRY_WAIT';
}

function severityOf(it) {
  return BOARD_EX_SEVERITY[it.severity] || ['-', 'gray'];
}
function exTypeText(type) {
  return BOARD_EX_TYPE[type] || type;
}
function exceptionDesc(it) {
  switch (it.type) {
    case 'DELAYED_ORDER':
      return `${it.orderCode} · 交期 ${fmtDateTime(it.dueAt)} · 计划完工 ${fmtDateTime(it.plannedCompletionAt)}`;
    case 'BREAKDOWN':
      return `${it.machineId || '-'} 故障（${it.eventCode}）· 预计修复 ${fmtDateTime(it.repairEndAt)}`;
    case 'INFEASIBLE_TASK':
      return `${it.taskCode} ${it.mode || ''} 无可行解${it.errorMessage ? ' · ' + it.errorMessage : ''}`;
    case 'EXECUTION_DEVIATION':
      return `工序 ${it.operationId} · ${it.status === 'COMPLETED' ? '完工' : '开工'}偏差 ${it.deviationMinutes} 分钟`;
    default:
      return '';
  }
}

// KPI 卡片跳转：C_max/加权拖期 → 资源甘特；延期订单 → 订单甘特；利用率/故障设备 → 设备页；待审核 → 审核页
function kpiJump(jump) {
  if (jump === 'cmax' || jump === 'tardiness') {
    shared.ganttVersionId = plan.value.id; shared.ganttView = 'resource';
    router.push({ name: 'resource-gantt' });
  } else if (jump === 'delayed') {
    shared.ganttVersionId = plan.value.id; shared.ganttView = 'order';
    router.push({ name: 'resource-gantt' });
  } else if (jump === 'utilization' || jump === 'machinesDown') {
    router.push({ name: 'machines' });
  } else if (jump === 'review') {
    router.push({ name: 'review' });
  }
}

// 异常条目跳转到对应处理页
function openException(it) {
  if (it.type === 'DELAYED_ORDER') router.push({ name: 'orders' });
  else if (it.type === 'BREAKDOWN') router.push({ name: 'breakdown' });
  else if (it.type === 'INFEASIBLE_TASK') { shared.selectedTaskId = it.taskId; router.push({ name: 'tasks' }); }
  else if (it.type === 'EXECUTION_DEVIATION') router.push({ name: 'execution' });
}

// 算法任务跳任务详情
function openTask(taskId) {
  shared.selectedTaskId = taskId;
  router.push({ name: 'tasks' });
}

// 筛选条件：变更即持久化并刷新
function onVersionChange(ev) {
  filters.planVersionId = ev.target.value || undefined;
  saveBoardFilters(filters);
  load();
}
function onWindowChange() {
  const w = windowSel.value;
  if (w !== 'CUSTOM') {
    filters.window = w;
    saveBoardFilters(filters);
    load();
  }
}
function applyRange() {
  const from = localInputToIso(customFrom.value);
  const to = localInputToIso(customTo.value);
  if (!from || !to) { toast('请填写自定义窗口的起止时间', 'error'); return; }
  if (new Date(from) >= new Date(to)) { toast('窗口起点必须早于终点', 'error'); return; }
  filters.window = 'CUSTOM'; filters.from = from; filters.to = to;
  saveBoardFilters(filters);
  load();
}

async function refresh() {
  await load();
  if (filters.planVersionId) await shared.refreshDashboard();
  toast('看板已刷新');
}

async function resetDemo() {
  try {
    await ElMessageBox.confirm('确定重置演示数据？所有版本、任务、事件将被清空。', '重置演示数据', { type: 'warning' });
  } catch { return; }
  try {
    const r = await Api.demoReset();
    toast(`演示数据已重置：${r.seed.orders} 订单 / ${r.seed.machines} 设备`);
    await shared.refreshDashboard();
    load();
  } catch (e) { toastErr(e, '重置失败'); }
}

onMounted(load);
</script>

<style scoped>
/* ===== 顶部总览：深蓝渐变 + 网格光晕 ===== */
.bd-hero { position:relative; overflow:hidden; margin-bottom:18px; padding:22px 26px 20px; border-radius:16px; color:#fff;
  background:radial-gradient(120% 140% at 0% 0%, #1f4fa8 0%, #12306e 42%, #0b1d45 100%);
  box-shadow:0 18px 40px rgba(11,29,69,.28), inset 0 1px 0 rgba(255,255,255,.08); }
.bd-hero-grid { position:absolute; inset:0; pointer-events:none; opacity:.35;
  background-image:linear-gradient(rgba(255,255,255,.06) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.06) 1px, transparent 1px);
  background-size:28px 28px; mask-image:linear-gradient(180deg, #000 0%, transparent 85%); }
.bd-hero-glow { position:absolute; right:-80px; top:-120px; width:420px; height:420px; border-radius:50%; pointer-events:none;
  background:radial-gradient(circle, rgba(86,160,255,.45) 0%, rgba(86,160,255,0) 65%); animation:bd-float 9s ease-in-out infinite; }
@keyframes bd-float { 0%,100% { transform:translate(0,0); } 50% { transform:translate(-30px,24px); } }
.bd-hero-top { position:relative; display:flex; justify-content:space-between; align-items:flex-start; gap:24px; }
.bd-hero-eyebrow { display:flex; align-items:center; gap:8px; color:#b9cdf2; font-size:12px; letter-spacing:.04em; }
.bd-pulse { position:relative; width:8px; height:8px; border-radius:50%; background:#fab219; }
.bd-pulse.on { background:#3ddc84; }
.bd-pulse::after { content:""; position:absolute; inset:-4px; border-radius:50%; border:2px solid currentColor; color:inherit; opacity:0; animation:bd-ping 2s ease-out infinite; }
.bd-pulse.on::after { color:#3ddc84; } .bd-pulse.idle::after { color:#fab219; }
@keyframes bd-ping { 0% { transform:scale(.6); opacity:.9; } 100% { transform:scale(1.8); opacity:0; } }
.bd-hero-title { margin:6px 0 4px; font-size:26px; font-weight:700; letter-spacing:.02em; }
.bd-hero-sub { margin:0; max-width:720px; color:#c9d8f5; font-size:13px; }
.bd-hero-sub b { color:#fff; }
.bd-hero-actions { display:flex; align-items:center; gap:8px; flex:none; }
.bd-btn { display:inline-flex; align-items:center; gap:6px; height:34px; padding:0 14px; border-radius:9px; font-size:13px; cursor:pointer; list-style:none; transition:background .2s, transform .2s; }
.bd-btn.ghost { color:#e6eeff; border:1px solid rgba(255,255,255,.22); background:rgba(255,255,255,.08); }
.bd-btn.ghost:hover { background:rgba(255,255,255,.16); }
.bd-btn.primary { color:#0b1d45; border:0; background:linear-gradient(180deg,#ffffff,#dfe9ff); font-weight:600; box-shadow:0 6px 16px rgba(0,0,0,.18); }
.bd-btn.primary:hover { transform:translateY(-1px); }
.bd-btn:focus-visible { outline:2px solid #9ec5f4; outline-offset:2px; }
.board-more summary::-webkit-details-marker { display:none; }
.bd-hero-stats { position:relative; display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:12px; margin-top:20px; }
.bd-hero-stat { padding:14px 16px; border:1px solid rgba(255,255,255,.12); border-radius:12px; background:rgba(255,255,255,.06); backdrop-filter:blur(6px); }
.bd-hero-stat-label { color:#b9cdf2; font-size:12px; }
.bd-hero-stat-value { margin-top:6px; font-size:28px; font-weight:700; font-variant-numeric:tabular-nums; line-height:1.1; }
.bd-hero-stat-value small { margin-left:3px; color:#b9cdf2; font-size:13px; font-weight:500; }
.bd-hero-stat-sub { margin-top:6px; color:#9fb4dc; font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.bd-hero-stat.danger { border-color:rgba(255,120,120,.45); background:rgba(208,59,59,.18); }
.bd-hero-stat.danger .bd-hero-stat-value { color:#ffb4b4; }
.bd-hero-stat.warn .bd-hero-stat-value { color:#ffd78a; }
/* ===== 区块标题与卡片 ===== */
.bd-section-title { display:flex; align-items:baseline; gap:10px; margin:22px 0 12px; color:var(--ink); font-size:15px; font-weight:650; }
.bd-section-title::before { content:""; align-self:center; width:4px; height:14px; border-radius:2px; background:linear-gradient(180deg,#5598e7,#1c5cab); }
.bd-section-title span { color:var(--muted); font-size:12px; font-weight:400; }
.bd-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:16px; }
.bd-span-2 { grid-column:span 2; }
.bd-card { position:relative; display:flex; flex-direction:column; min-width:0; padding:16px 18px; border:1px solid #e6eaf0; border-radius:14px; background:#fff;
  box-shadow:0 1px 2px rgba(16,36,52,.04), 0 10px 28px rgba(16,36,52,.05); transition:box-shadow .25s, transform .25s; }
.bd-card:hover { box-shadow:0 2px 4px rgba(16,36,52,.05), 0 16px 36px rgba(16,36,52,.09); transform:translateY(-1px); }
.bd-card::before { content:""; position:absolute; left:18px; right:18px; top:0; height:2px; border-radius:0 0 2px 2px; background:linear-gradient(90deg,#2a78d6,rgba(42,120,214,0)); opacity:.7; }
.bd-card-head { display:flex; align-items:baseline; justify-content:space-between; gap:12px; margin-bottom:10px; }
.bd-card-head h2 { margin:0; color:var(--ink); font-size:14px; font-weight:650; white-space:nowrap; }
.bd-card-head span { overflow:hidden; color:var(--muted); font-size:11px; white-space:nowrap; text-overflow:ellipsis; }
.bd-card-head a { color:var(--blue); font-size:12px; cursor:pointer; }
.bd-chart { height:250px; flex:none; }
.bd-span-2 .bd-chart { flex:1 1 auto; min-height:250px; }
.bd-chart.small { width:170px; height:170px; }
/* 交期紧迫度：环图 + 图例 */
.bd-donut { display:flex; align-items:center; gap:14px; flex:1; }
.bd-legend { flex:1; margin:0; padding:0; list-style:none; display:grid; gap:12px; }
.bd-legend li { display:grid; grid-template-columns:10px minmax(0,1fr) auto; align-items:center; gap:8px; color:var(--ink); font-size:13px; white-space:nowrap; }
.bd-legend i { width:10px; height:10px; border-radius:3px; }
.bd-legend .critical i { background:#d03b3b; } .bd-legend .warning i { background:#fab219; } .bd-legend .good i { background:#0ca30c; }
.bd-legend small { display:block; color:var(--muted); font-size:11px; }
.bd-legend b { font-size:18px; font-variant-numeric:tabular-nums; }
/* 风险订单 */
.bd-risk-list { margin:0; padding:0; list-style:none; display:grid; gap:4px; }
.bd-risk-list li { display:grid; grid-template-columns:minmax(0,1fr) 96px; gap:10px; align-items:center; padding:7px 8px; border-radius:10px; }
.bd-risk-list li:hover { background:#f6f9fe; }
.bd-risk-main b { display:block; overflow:hidden; color:var(--ink); font-size:12.5px; font-variant-numeric:tabular-nums; white-space:nowrap; text-overflow:ellipsis; }
.bd-risk-main span { display:block; overflow:hidden; color:var(--muted); font-size:11px; white-space:nowrap; text-overflow:ellipsis; }
.bd-risk-bar { height:6px; overflow:hidden; border-radius:3px; background:#eef1f5; }
.bd-risk-bar i { display:block; height:100%; border-radius:3px; }
.bd-risk-list .critical .bd-risk-bar i { background:linear-gradient(90deg,#ec835a,#d03b3b); }
.bd-risk-list .warning .bd-risk-bar i { background:linear-gradient(90deg,#ffd166,#fab219); }
.bd-risk-list .good .bd-risk-bar i { background:#0ca30c; }
.bd-risk-meter em { display:block; margin-top:4px; color:var(--muted); font-size:11px; font-style:normal; text-align:right; }
.bd-risk-list .critical em { color:#b33434; font-weight:600; }
.bd-empty-line { color:var(--muted); font-size:12px; }
/* 产品族：分段条（段间 2px 白隙）+ 列表 */
.bd-stack { display:flex; gap:2px; height:14px; margin:6px 0 14px; overflow:hidden; border-radius:7px; }
.bd-stack i { display:block; min-width:6px; height:100%; }
.bd-family-list { margin:0; padding:0; list-style:none; display:grid; gap:10px; }
.bd-family-list li { display:grid; grid-template-columns:10px 1fr auto; grid-template-rows:auto auto; column-gap:8px; align-items:center; }
.bd-swatch { width:10px; height:10px; border-radius:3px; grid-row:span 2; }
.bd-family-name { color:var(--ink); font-size:13px; }
.bd-family-list b { color:var(--ink); font-size:14px; font-variant-numeric:tabular-nums; text-align:right; }
.bd-family-list small { grid-column:2 / 4; color:var(--muted); font-size:11px; }
/* 优先级 */
.bd-prio { display:grid; gap:12px; margin-top:4px; }
.bd-prio-row { display:grid; grid-template-columns:26px 1fr 26px; gap:10px; align-items:center; font-size:12px; }
.bd-prio-row span { color:var(--muted); font-weight:600; }
.bd-prio-row b { color:var(--ink); font-size:13px; font-variant-numeric:tabular-nums; text-align:right; }
.bd-prio-track { height:10px; overflow:hidden; border-radius:5px; background:#f1f4f8; }
.bd-prio-track i { display:block; height:100%; border-radius:0 5px 5px 0; transition:width .8s cubic-bezier(.2,.8,.2,1); }
/* 订单流转 + 工作中心 */
.bd-flow { display:grid; grid-template-columns:repeat(4,1fr); gap:6px; margin-top:4px; }
.bd-flow-step { position:relative; padding:10px 6px 8px; border-radius:10px; background:#f5f7fa; text-align:center; }
.bd-flow-step:not(:last-child)::after { content:""; position:absolute; right:-6px; top:50%; width:6px; height:2px; background:#d8dee8; }
.bd-flow-step b { display:block; color:#9aa4b2; font-size:20px; font-variant-numeric:tabular-nums; }
.bd-flow-step span { color:var(--muted); font-size:11px; }
.bd-flow-step.active { background:linear-gradient(180deg,#eef5ff,#e1edff); }
.bd-flow-step.active b { color:#1c5cab; }
.bd-wc { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; margin-top:14px; padding-top:12px; border-top:1px dashed #e6eaf0; }
.bd-wc-item span { display:block; color:var(--muted); font-size:11px; }
.bd-wc-item b { color:var(--ink); font-size:16px; font-variant-numeric:tabular-nums; }
.bd-wc-item small { margin-left:2px; color:var(--muted); font-size:11px; font-weight:400; }
/* 有计划时沿用原 KPI 行与筛选区 */
.board-controls .board-summary-detail { margin-left:auto; align-self:center; }
/* 响应式：按内容区实际宽度（AI 面板停靠会挤占）而非视口切换 */
.board-page { container-type:inline-size; }
@container (max-width:1120px) {
  /* 两列：dense 回填，紧迫度与风险订单并排、产品族与优先级并排，避免空洞 */
  .bd-grid { grid-template-columns:repeat(2,minmax(0,1fr)); grid-auto-flow:row dense; }
  .bd-span-2, .bd-flow-card { grid-column:1 / -1; }
}
@container (max-width:760px) {
  .bd-hero-stats { grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); }
}
@container (max-width:640px) {
  .bd-hero-top { flex-direction:column; }
  .bd-hero-stats, .bd-grid { grid-template-columns:minmax(0,1fr); }
  .bd-donut { flex-direction:column; }
}
@media (prefers-reduced-motion:reduce) {
  .bd-hero-glow, .bd-pulse::after { animation:none; }
  .bd-card, .bd-card:hover { transition:none; transform:none; }
}
</style>

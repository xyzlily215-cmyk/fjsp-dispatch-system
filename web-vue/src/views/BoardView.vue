<template>
  <div v-if="loading" class="loading-block"><div class="spin"></div><div>正在加载看板数据…</div></div>
  <div v-else-if="fatalError">
    <div class="page-header"><div><h1>调度看板</h1><p>当前发布计划的生产运行概览</p></div></div>
    <section class="card"><div class="section-pad">
      <ErrorBox :error="fatalError" title="看板数据加载失败" />
      <button class="btn primary" @click="load">重试</button>
    </div></section>
  </div>
  <div v-else>
    <div class="page-header">
      <div><h1>调度看板</h1><p>生产运行概览（时间窗口：{{ windowLabel }}<template v-if="win.from"> {{ fmtTime(win.from) }} ~ {{ fmtTime(win.to) }}</template>）</p></div>
      <div class="buttons">
        <select class="field" style="width:auto" title="计划版本" :value="filters.planVersionId || ''" @change="onVersionChange">
          <option value="">当前发布计划（自动）</option>
          <option v-for="o in versionOptions" :key="o.id" :value="o.id">{{ o.label }}</option>
        </select>
        <select class="field" style="width:auto" title="时间窗口" v-model="windowSel" @change="onWindowChange">
          <option value="SHIFT">当前班次</option>
          <option value="LAST_24H">最近 24 小时</option>
          <option value="CUSTOM">自定义</option>
        </select>
        <span v-show="windowSel === 'CUSTOM'" style="display:inline-flex;gap:6px;align-items:center">
          <input type="datetime-local" class="field" style="width:auto" v-model="customFrom">
          <span class="muted">至</span>
          <input type="datetime-local" class="field" style="width:auto" v-model="customTo">
          <button class="btn small" @click="applyRange">应用</button>
        </span>
        <button class="btn" @click="refresh">&#8635; 刷新</button>
        <button class="btn" v-role="['ADMIN']" @click="resetDemo">重置演示数据</button>
        <button class="btn primary" @click="router.push({ name: 'baseline' })">+ 创建基线排程</button>
      </div>
    </div>

    <div v-if="loadError" class="error-box" style="margin-bottom:14px">
      <b>看板数据刷新失败，以下为最近一次成功数据</b>{{ errMsg(loadError) }}
      <div style="margin-top:8px"><button class="btn small" @click="load">重试</button></div>
    </div>

    <section v-if="!plan" class="card">
      <EmptyScreen title="暂无当前发布计划" text="还没有已发布的计划版本。请先创建基线排程，求解成功后提交审核并发布。">
        <button class="btn primary" @click="router.push({ name: 'baseline' })">去创建基线排程</button>
      </EmptyScreen>
    </section>
    <div v-else class="kpis">
      <article v-for="c in kpiCards" :key="c.jump" class="card kpi" title="点击查看详情" @click="kpiJump(c.jump)">
        <div class="kpi-label">{{ c.label }}</div>
        <div class="kpi-value">{{ c.value }}<span class="kpi-unit">{{ c.unit || '' }}</span></div>
        <div class="trend" style="color:#909399">{{ c.sub || '' }}</div>
        <i class="kpi-bar" :class="c.bar"></i>
      </article>
    </div>

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
          <div v-else class="empty-screen" style="padding:30px">时间窗口内暂无事件</div>
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
                  <div style="height:4px;border-radius:2px;background:#409eff" :style="{ width: Math.min(100, taskProgress(t)) + '%' }"></div>
                </div>
              </div>
              <StatusTag :status="t.status" />
              <div class="task-actions">{{ isActiveTask(t) ? taskProgress(t) + '%' : '查看详情' }}</div>
            </div>
          </template>
          <div v-else class="empty-screen" style="padding:30px">暂无任务</div>
        </div>
      </section>
    </div>

    <section class="card warning-card">
      <div class="card-title">异常列表（按严重级别）</div>
      <div class="warning-list" style="max-height:430px;overflow:auto">
        <template v-if="exItems.length">
          <div v-for="(it, idx) in exItems" :key="idx" class="alert clickable" style="cursor:pointer" @click="openException(it)">
            <span class="severity">!</span>
            <div>
              <div class="alert-name"><span class="tag" :class="severityOf(it)[1]">{{ severityOf(it)[0] }} · {{ exTypeText(it.type) }}</span></div>
              <div class="alert-desc">{{ exceptionDesc(it) }} · {{ fmtDateTime(it.at) }}</div>
            </div>
            <span class="tag blue">去处理</span>
          </div>
        </template>
        <div v-else class="empty-screen" style="padding:30px">时间窗口内无异常</div>
      </div>
    </section>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
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
import EmptyScreen from '../components/EmptyScreen.vue';

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

async function load() {
  loading.value = true;
  fatalError.value = null;
  loadError.value = null;
  try {
    const [d, v] = await Promise.all([Api.dashboard(dashboardParams(filters)), Api.planVersions()]);
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

const kpiCards = computed(() => {
  const k = kpi.value;
  const d = dash.value;
  return [
    { jump: 'cmax', label: '总完工时间 C_max', value: fmtMinutes(k.cMaxMinutes), unit: '', bar: 'b-blue', sub: `计划版本 ${plan.value.versionCode}` },
    { jump: 'tardiness', label: '加权拖期', value: fmtMinutes(k.weightedTardinessMinutes), unit: '', bar: 'b-orange', sub: `延期订单 ${k.nTardy ?? '-'} 单` },
    { jump: 'delayed', label: '延期订单数', value: k.nTardy ?? '-', unit: '单', bar: 'b-red', sub: `共 ${d.orderStats.total} 单` },
    { jump: 'utilization', label: '平均设备利用率', value: avgUtil.value === null ? '-' : fmtPct(avgUtil.value), unit: '', bar: 'b-green', sub: `负荷不均衡度 ${k.loadImbalance ?? '-'}` },
    { jump: 'review', label: '待审核方案', value: pendingReview.value, unit: '个', bar: 'b-purple', sub: '等待审核发布' },
    { jump: 'machinesDown', label: '故障/异常设备', value: downMachines.value || breakdowns.value.length, unit: '台', bar: 'b-gray', sub: `${breakdowns.value.length} 起未消化故障` },
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

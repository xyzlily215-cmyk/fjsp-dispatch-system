<template>
  <div v-if="loading" class="loading-block"><div class="spin"></div><div>正在加载计划版本…</div></div>
  <ErrorBox v-else-if="error" :error="error" :title="errorTitle" />
  <div v-else-if="!versions.length">
    <div class="page-header">
      <div><h1>甘特图</h1><p>按设备或订单查看计划版本的工序排布</p></div>
    </div>
    <section class="card">
      <EmptyScreen title="暂无计划版本" text="先创建基线排程生成计划版本。">
        <button class="btn primary" @click="router.push({ name: 'baseline' })">去创建基线排程</button>
      </EmptyScreen>
    </section>
  </div>
  <div v-else>
    <div class="page-header">
      <div><h1>甘特图</h1><p>资源视图按设备行渲染，订单视图按订单工艺链渲染；点击工序条可在两视图间联动定位</p></div>
      <div class="buttons">
        <button class="btn" :class="{ primary: view === 'resource' }" @click="setView('resource')">资源视图</button>
        <button class="btn" :class="{ primary: view === 'order' }" @click="setView('order')">订单视图</button>
        <button class="btn" @click="exportImg">导出图片</button>
        <button class="btn" @click="exportCsv">导出 CSV</button>
        <button v-if="plan.status === 'DRAFT'" v-role="['DISPATCHER', 'ADMIN']" class="btn" @click="submit">提交审核</button>
        <button v-if="plan.parentId" class="btn" @click="compareWithParent">与父版本对比</button>
        <button class="btn" @click="load">&#8635; 刷新</button>
      </div>
    </div>
    <section class="card section-card">
      <div class="gantt-header">
        <div class="filters" style="display:flex;gap:10px;align-items:center">
          <span class="filter-label">计划版本</span>
          <select class="field wide" v-model="selectedId" @change="onVersionChange">
            <option v-for="v in versions" :key="v.id" :value="v.id">
              {{ v.versionCode }} · {{ v.status }}{{ v.id === currentId ? ' · 当前发布' : '' }} · {{ fmtDateTime(v.createdAt) }}
            </option>
          </select>
          <StatusTag :status="plan.status" />
        </div>
        <div v-if="ops.length" class="muted">
          C_max {{ fmtMinutes(kpi.cMaxMinutes) }} · 加权拖期 {{ fmtMinutes(kpi.weightedTardinessMinutes) }} · 延期 {{ kpi.nTardy ?? '-' }} 单 · Δ_plan {{ kpi.deltaPlan ? kpi.deltaPlan.deltaPlan.toFixed(3) : '-' }}
        </div>
      </div>
      <GanttChart v-if="ops.length" ref="chartRef" :plan="plan" :ops="ops" :machines="machines" :orders="orders"
        :dash="dash" :view="view" :focus-op="focusOp" @op-click="onOpClick" />
      <EmptyScreen v-else title="该版本没有工序明细" />
    </section>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { Api } from '../api';
import { toast, toastErr } from '../utils/ui';
import { fmtDateTime, fmtMinutes } from '../utils/format';
import { useSharedStore } from '../stores/shared';
import StatusTag from '../components/StatusTag.vue';
import ErrorBox from '../components/ErrorBox.vue';
import EmptyScreen from '../components/EmptyScreen.vue';
import GanttChart from '../components/GanttChart.vue';

const router = useRouter();
const shared = useSharedStore();

const loading = ref(true);
const error = ref(null);
const errorTitle = ref('基础数据加载失败');
const versions = ref([]);
const machines = ref([]);
const orders = ref([]);
const dash = ref(null);
const plan = ref(null);
const ops = ref([]);
const selectedId = ref(null);
const view = ref('resource');
const focusOp = ref(null);
const chartRef = ref(null);

const currentId = computed(() => (dash.value && dash.value.currentPlan && dash.value.currentPlan.id) || null);
const kpi = computed(() => (plan.value && plan.value.kpi) || {});

async function load() {
  loading.value = true;
  error.value = null;
  try {
    [versions.value, machines.value, orders.value, dash.value] = await Promise.all(
      [Api.planVersions(), Api.machines(), Api.orders(), Api.dashboard()]);
    shared.dashboard = dash.value;
  } catch (e) {
    errorTitle.value = '基础数据加载失败';
    error.value = e;
    loading.value = false;
    return;
  }
  if (!versions.value.length) { loading.value = false; return; }

  let sel = shared.ganttVersionId
    || (versions.value.find(v => v.id === currentId.value) ? currentId.value : null)
    || versions.value[0].id;
  if (!versions.value.some(v => v.id === sel)) sel = versions.value[0].id;
  selectedId.value = sel;

  try {
    const [p, opsPage] = await Promise.all([
      Api.planVersion(sel), Api.planVersionOperations(sel)]);
    plan.value = p;
    ops.value = opsPage.items || [];
  } catch (e) {
    errorTitle.value = '版本详情加载失败';
    error.value = e;
  } finally {
    loading.value = false;
  }
}

function onVersionChange() {
  shared.ganttVersionId = selectedId.value;
  load();
}

function setView(v) {
  view.value = v;
  shared.ganttView = v;
  focusOp.value = null;
}

function onOpClick(op) {
  setView(view.value === 'order' ? 'resource' : 'order');
  focusOp.value = op.operationId;
}

function exportImg() {
  if (chartRef.value) chartRef.value.exportPng();
  else toast('该版本没有工序明细，无法导出图片');
}

async function exportCsv() {
  try {
    await Api.exportPlanVersion(selectedId.value);
    toast(plan.value.versionCode + ' CSV 已开始下载');
  } catch (e) { toastErr(e, '导出失败'); }
}

async function submit() {
  try {
    await Api.submitReview(selectedId.value, plan.value.version);
    toast(plan.value.versionCode + ' 已提交审核');
    load();
  } catch (e) { toastErr(e, '提交审核失败'); }
}

function compareWithParent() {
  shared.compareBaselineId = plan.value.parentId;
  shared.compareCandidateId = plan.value.id;
  router.push({ name: 'compare' });
}

onMounted(() => {
  view.value = shared.ganttView === 'order' ? 'order' : 'resource';
  // 跨页/跨视图联动定位目标：消费一次即清除
  focusOp.value = shared.ganttFocusOp;
  shared.ganttFocusOp = null;
  load();
});
</script>

<template>
  <div v-if="loading" class="loading-block"><div class="spin"></div><div>正在加载任务列表…</div></div>
  <ErrorBox v-else-if="error" :error="error" title="任务列表加载失败" />
  <template v-else-if="emptyAll">
    <div class="page-header">
      <div><h1>调度任务</h1><p>算法求解任务的进度与结果</p></div>
    </div>
    <section class="card">
      <EmptyScreen title="暂无调度任务" text="从基线排程或事件重调度创建任务。">
        <button class="btn primary" @click="goBaseline">去创建基线排程</button>
      </EmptyScreen>
    </section>
  </template>
  <template v-else>
    <div class="page-header">
      <div><h1>调度任务</h1><p>算法求解任务的进度与结果，进行中的任务经 SSE 实时推送，断线自动回退 3 秒轮询</p></div>
      <div class="buttons">
        <button class="btn" @click="load">&#8635; 刷新</button>
        <button class="btn primary" @click="goBaseline">+ 基线排程</button>
      </div>
    </div>
    <div class="task-center">
      <section class="card task-queue">
        <div class="task-queue-head"><h2>任务队列</h2><p>共 {{ page.total }} 个任务</p></div>
        <div class="task-queue-list">
          <template v-if="tasks.length">
            <button v-for="t in tasks" :key="t.taskId" class="task-queue-item" :class="{ active: t.taskId === selectedId }"
              @click="selectTask(t)">
              <b>{{ t.taskCode }}</b><StatusTag :status="t.status" />
              <span>{{ t.mode }} · {{ fmtDateTime(t.createdAt) }}</span>
            </button>
          </template>
          <div v-else class="empty-screen" style="padding:30px">本页暂无任务</div>
        </div>
        <Pager :page="page" @change="onPage" />
      </section>
      <section class="card task-detail">
        <div v-if="detailLoading" class="loading-block"><div class="spin"></div><div>加载任务详情…</div></div>
        <ErrorBox v-else-if="detailError" :error="detailError" title="任务详情加载失败" />
        <div v-else-if="!task" class="empty-screen">暂无任务</div>
        <template v-else>
          <div class="task-detail-head">
            <div><h2>{{ task.taskCode }}</h2><p><StatusTag :status="task.mode" /> 创建于 {{ fmtDateTime(task.createdAt) }}</p></div>
            <StatusTag :status="task.status" />
          </div>
          <div class="task-progress-box">
            <div class="task-progress-main"><b>{{ task.progress ?? 0 }}%</b>
              <span>求解进度{{ isTerminal(task) ? '（已结束）' : '（SSE 实时推送）' }}</span>
              <div class="progress"><b :style="{ width: (task.progress ?? 0) + '%' }"></b></div>
            </div>
            <div class="task-progress-metric"><span>结果状态</span><b>{{ task.resultStatus || '-' }}</b></div>
            <div class="task-progress-metric"><span>算法版本</span><b>{{ task.algorithmVersion || '-' }}</b></div>
            <div class="task-progress-metric"><span>耗时</span><b>{{ elapsedText }}</b></div>
          </div>
          <div class="section-pad">
            <dl class="detail-list">
              <dt>任务 ID</dt><dd>{{ task.taskId }}</dd>
              <dt>随机种子</dt><dd>{{ task.randomSeed ?? '-' }}</dd>
              <dt>输入快照</dt><dd>{{ (task.snapshotHash || '-').slice(0, 24) }}…</dd>
              <template v-if="task.oldPlanVersionId"><dt>基于版本</dt><dd>{{ task.oldPlanVersionId }}</dd></template>
              <template v-if="task.eventId"><dt>关联事件</dt><dd>{{ task.eventId }}</dd></template>
              <dt>开始时间</dt><dd>{{ fmtDateTime(task.startedAt) }}</dd>
              <dt>结束时间</dt><dd>{{ fmtDateTime(task.finishedAt) }}</dd>
              <template v-if="task.planVersionId"><dt>产出计划版本</dt><dd>{{ task.planVersionId }}</dd></template>
            </dl>
            <div v-if="task.errorMessage" class="error-box"><b>错误信息</b>{{ task.errorMessage }}</div>
            <template v-if="task.kpi">
              <h3 style="margin:18px 0 10px;font-size:15px">结果 KPI</h3>
              <div class="task-overview-grid">
                <div class="task-overview-block"><span>总完工时间 C_max</span><b>{{ fmtMinutes(task.kpi.cMaxMinutes) }}</b></div>
                <div class="task-overview-block"><span>加权拖期</span><b>{{ fmtMinutes(task.kpi.weightedTardinessMinutes) }}</b></div>
                <div class="task-overview-block"><span>延期订单数</span><b>{{ task.kpi.nTardy ?? '-' }}</b></div>
                <div class="task-overview-block"><span>负荷不均衡度</span><b>{{ task.kpi.loadImbalance ?? '-' }}</b></div>
                <div class="task-overview-block"><span>计划扰动 Δ_plan</span><b>{{ task.kpi.deltaPlan ? task.kpi.deltaPlan.deltaPlan.toFixed(3) : '-' }}</b></div>
                <div class="task-overview-block"><span>可行解</span><b>{{ task.feasibleSolution ? '是' : '否' }}</b></div>
              </div>
            </template>
            <h3 style="margin:18px 0 10px;font-size:15px">冲突明细</h3>
            <div v-if="conflicts.length" class="table-wrap">
              <table class="data-table">
                <thead><tr><th>类型</th><th>说明</th></tr></thead>
                <tbody>
                  <tr v-for="(c, i) in conflicts" :key="i">
                    <td><span class="tag red">{{ c.type || c.code || '冲突' }}</span></td>
                    <td>{{ c.message || JSON.stringify(c) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-else class="muted">无冲突</p>
            <div class="buttons" style="margin-top:18px">
              <template v-if="task.status === 'SUCCESS' && task.planVersionId">
                <button class="btn primary" @click="goGantt">查看甘特</button>
                <button class="btn" v-role="['DISPATCHER','ADMIN']" @click="submitReview">提交审核</button>
              </template>
              <button v-if="task.status === 'SUCCESS' && task.oldPlanVersionId && task.planVersionId" class="btn" @click="goCompare">与旧版对比</button>
              <button v-if="TASK_ACTIVE.includes(task.status)" class="btn" v-role="['DISPATCHER','ADMIN']" @click="cancelTask">取消任务</button>
              <button v-if="['FAILED','CANCELLED'].includes(task.status)" class="btn" v-role="['DISPATCHER','ADMIN']" @click="retryTask">重试任务</button>
            </div>
          </div>
        </template>
      </section>
    </div>
  </template>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { Api } from '../api';
import { toast, toastErr } from '../utils/ui';
import { fmtDateTime, fmtMinutes, statusTagInfo } from '../utils/format';
import { useSharedStore } from '../stores/shared';
import StatusTag from '../components/StatusTag.vue';
import ErrorBox from '../components/ErrorBox.vue';
import EmptyScreen from '../components/EmptyScreen.vue';
import Pager from '../components/Pager.vue';

const TASK_ACTIVE = ['PENDING', 'RUNNING', 'RETRY_WAIT'];

const router = useRouter();
const shared = useSharedStore();

const loading = ref(true);
const error = ref(null);
const page = ref(null);
const selectedId = ref(null);

const detailLoading = ref(false);
const detailError = ref(null);
const task = ref(null);
/* SSE 心跳推送的耗时展示（等价旧版直接更新 #tdElapsed 文本），每次详情刷新后重置 */
const hbElapsed = ref(null);

const tasks = computed(() => (page.value && page.value.items) || []);
const emptyAll = computed(() => !tasks.value.length && (shared.tasksPageNo || 0) === 0);
const conflicts = computed(() => (task.value && task.value.conflicts) || []);
const elapsedText = computed(() => {
  if (hbElapsed.value != null) return hbElapsed.value;
  const t = task.value;
  return t && t.elapsedMs != null ? (t.elapsedMs / 1000).toFixed(1) + 's' : '-';
});

function isTerminal(t) { return !TASK_ACTIVE.includes(t.status); }

/* ---- 进度跟踪：SSE 优先，失败/断线回退 3 秒轮询（自旧版 pages-schedule.js 移植） ---- */
let pollTimer = null;
let eventSource = null;
let openTimer = null;
let watchSeq = 0;   // 每次 stopWatch 递增，使在途的 ticket 换取失效（防重复连接）
let disposed = false;

function stopWatch() {
  watchSeq += 1;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (eventSource) { eventSource.close(); eventSource = null; }
  if (openTimer) { clearTimeout(openTimer); openTimer = null; }
}

async function loadDetail() {
  if (!selectedId.value) return null;
  if (!task.value) { detailLoading.value = true; detailError.value = null; }
  let t;
  try {
    t = await Api.task(selectedId.value);
  } catch (e) {
    detailLoading.value = false;
    detailError.value = e;
    return null;
  }
  hbElapsed.value = null;
  task.value = t;
  detailError.value = null;
  detailLoading.value = false;
  return t;
}

function startWatch() {
  const seq = watchSeq;
  const finishWatch = (nt) => {
    stopWatch();
    toast(`任务 ${nt.taskCode} 求解结束：${statusTagInfo(nt.status)[1]}`,
      nt.status === 'SUCCESS' ? 'success' : 'info');
  };
  const startPolling = () => {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      if (disposed) { stopWatch(); return; }
      const nt = await loadDetail();
      if (nt && isTerminal(nt)) finishWatch(nt);
    }, 3000);
  };
  if (window.EventSource) {
    // ticket 换取是异步的；失败（含 ticket 过期/一次性被消费）统一回退轮询
    (async () => {
      let url;
      try { url = await Api.taskEventsUrl(selectedId.value); }
      catch (e) { if (!disposed && seq === watchSeq) startPolling(); return; }
      if (disposed || seq !== watchSeq || pollTimer) return; // 已卸载/已切换任务或已回退轮询
      const es = new EventSource(url);
      eventSource = es;
      let opened = false;
      es.onopen = () => { opened = true; };
      es.addEventListener('progress', async (ev) => {
        let d = null;
        try { d = JSON.parse(ev.data); } catch (e) { /* 忽略无法解析的事件 */ }
        const nt = await loadDetail();
        if ((d && d.terminal) || (nt && isTerminal(nt))) {
          es.close();
          if (nt) finishWatch(nt);
        }
      });
      es.addEventListener('heartbeat', (ev) => {
        try {
          const d = JSON.parse(ev.data);
          if (d.elapsedMs != null) hbElapsed.value = (d.elapsedMs / 1000).toFixed(1) + 's';
        } catch (e) { /* 忽略无法解析的心跳 */ }
      });
      es.onerror = () => {
        // CLOSED = 服务端拒绝或连接被终结（浏览器不再自动重连），回退轮询
        if (es.readyState === EventSource.CLOSED) { stopWatch(); startPolling(); }
      };
      // 5 秒内未建立连接（服务不可达，浏览器持续重试中）同样回退轮询
      openTimer = setTimeout(() => {
        openTimer = null;
        if (!opened && eventSource === es) { stopWatch(); startPolling(); }
      }, 5000);
    })();
  } else {
    startPolling();
  }
}

/* ---- 列表加载与选择 ---- */
async function load() {
  stopWatch();
  task.value = null;
  loading.value = true;
  error.value = null;
  const pageNo = shared.tasksPageNo || 0;
  try {
    page.value = await Api.tasksPage(pageNo, 10);
  } catch (e) {
    error.value = e;
    loading.value = false;
    return;
  }
  loading.value = false;
  const list = tasks.value;
  selectedId.value = shared.selectedTaskId && list.some(t => t.taskId === shared.selectedTaskId)
    ? shared.selectedTaskId
    : (list.length ? list[0].taskId : null);
  if (!selectedId.value) return;
  detailLoading.value = true;
  detailError.value = null;
  const t = await loadDetail();
  if (t && !isTerminal(t)) startWatch();
}

function selectTask(t) {
  shared.selectedTaskId = t.taskId;
  selectedId.value = t.taskId;
  stopWatch();
  task.value = null;
  detailLoading.value = true;
  detailError.value = null;
  (async () => {
    const d = await loadDetail();
    if (d && !isTerminal(d)) startWatch();
  })();
}

function onPage(delta) {
  shared.tasksPageNo = (shared.tasksPageNo || 0) + delta;
  load();
}

/* ---- 跳转与操作 ---- */
function goBaseline() { router.push({ name: 'baseline' }); }

function goGantt() {
  shared.ganttVersionId = task.value.planVersionId;
  router.push({ name: 'resource-gantt' });
}

async function submitReview() {
  const t = task.value;
  try {
    const pv = await Api.planVersion(t.planVersionId);
    await Api.submitReview(t.planVersionId, pv.version);
    toast('已提交审核，可在「待审核方案」中处理');
    router.push({ name: 'review' });
  } catch (e) { toastErr(e, '提交审核失败'); }
}

function goCompare() {
  shared.compareBaselineId = task.value.oldPlanVersionId;
  shared.compareCandidateId = task.value.planVersionId;
  router.push({ name: 'compare' });
}

async function cancelTask() {
  const t = task.value;
  try {
    await ElMessageBox.confirm(`确定取消任务 ${t.taskCode}？运行中的任务将丢弃求解结果。`, '取消任务', { type: 'warning' });
  } catch { return; }
  try {
    await Api.cancelTask(t.taskId);
    toast('已请求取消', 'info');
    load();
  } catch (e) { toastErr(e, '取消失败'); }
}

async function retryTask() {
  const t = task.value;
  try {
    await Api.retryTask(t.taskId);
    toast(`任务 ${t.taskCode} 已重新排队`);
    load();
  } catch (e) { toastErr(e, '重试失败'); }
}

onMounted(load);
onBeforeUnmount(() => {
  disposed = true;
  stopWatch();
});
</script>

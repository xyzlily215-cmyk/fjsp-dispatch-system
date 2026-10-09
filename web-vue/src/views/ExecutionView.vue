<template>
  <div v-if="loading" class="loading-block"><div class="spin"></div><div>正在加载当前执行计划…</div></div>
  <ErrorBox v-else-if="error" :error="error" :title="errorTitle" />
  <div v-else-if="!dashboard.currentPlan">
    <div class="page-header">
      <div><h1>实际执行反馈</h1><p>对当前发布计划的工序提交实际执行状态</p></div>
    </div>
    <section class="card">
      <EmptyScreen title="暂无执行中的计划" text="发布一个计划版本后才能反馈执行。">
        <button class="btn primary" @click="router.push({ name: 'review' })">去审核发布</button>
      </EmptyScreen>
    </section>
  </div>
  <div v-else>
    <div class="page-header">
      <div><h1>实际执行反馈</h1><p>当前执行计划 {{ plan.versionCode }} 的工序执行状态反馈</p></div>
      <div class="buttons"><button class="btn" @click="load">&#8635; 刷新</button></div>
    </div>
    <div class="stat-cards">
      <div class="card stat-card"><span>当前版本</span><b>{{ plan.versionCode }}</b></div>
      <div class="card stat-card"><span>未开始</span><b>{{ counts.NOT_STARTED || 0 }}</b></div>
      <div class="card stat-card"><span>加工中</span><b style="color:#348dd5">{{ counts.RUNNING || 0 }}</b></div>
      <div class="card stat-card"><span>暂停中</span><b style="color:#e6a23c">{{ counts.PAUSED || 0 }}</b></div>
      <div class="card stat-card"><span>已完成</span><b style="color:#67a23c">{{ counts.COMPLETED || 0 }}</b></div>
      <div class="card stat-card"><span>执行偏差</span><b style="color:#d54941">{{ deviationCount }}</b></div>
    </div>
    <section class="card table-card">
      <div class="table-wrap" style="max-height:600px">
        <table class="data-table">
          <thead><tr><th>工序</th><th>设备</th><th>计划开始</th><th>计划结束</th><th>冻结</th><th>执行状态</th><th>标记</th><th>反馈</th></tr></thead>
          <tbody>
            <tr v-for="o in ops" :key="o.operationId">
              <td>{{ o.operationId }}</td>
              <td>{{ o.machineId }}</td>
              <td>{{ fmtDateTime(o.startAt) }}</td>
              <td>{{ fmtDateTime(o.endAt) }}</td>
              <td><span v-if="o.frozen" class="tag orange">冻结</span><template v-else>-</template></td>
              <td><StatusTag :status="statusOf(o)" /></td>
              <td>
                <template v-if="o.executionDeviation || o.executionException">
                  <span v-if="o.executionDeviation" class="tag red">偏差 {{ o.deviationMinutes }} 分</span>
                  <span v-if="o.executionException" class="tag red">异常</span>
                </template>
                <template v-else>-</template>
              </td>
              <td class="table-actions">
                <a v-if="!['RUNNING','PAUSED','COMPLETED'].includes(statusOf(o))"
                   v-role="['PRODUCTION_MANAGER','ADMIN']" @click="feedback(o, 'RUNNING')">开工</a>
                <template v-if="statusOf(o) === 'RUNNING'">
                  <a v-role="['PRODUCTION_MANAGER','ADMIN']" @click="feedback(o, 'PAUSED')">暂停</a>
                  <a v-role="['PRODUCTION_MANAGER','ADMIN']" @click="feedback(o, 'COMPLETED')">完工</a>
                </template>
                <a v-if="statusOf(o) === 'PAUSED'"
                   v-role="['PRODUCTION_MANAGER','ADMIN']" @click="feedback(o, 'RESUMED')">恢复</a>
                <a v-if="statusOf(o) !== 'COMPLETED'"
                   v-role="['PRODUCTION_MANAGER','ADMIN']" @click="feedback(o, 'EXCEPTION')">异常</a>
                <a @click="showTimeline(o.operationId)">时间线</a>
                <a v-if="o.executionDeviation || o.executionException"
                   v-role="['DISPATCHER','ADMIN']" @click="goReschedule(o)">重调度</a>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
    <section v-if="timeline.visible" class="card">
      <div class="section-pad">
        <div v-if="timeline.loading" class="loading-block"><div class="spin"></div><div>正在加载执行时间线…</div></div>
        <ErrorBox v-else-if="timeline.error" :error="timeline.error" title="时间线加载失败" />
        <template v-else>
          <h3 style="margin:0 0 10px;font-size:15px">工序 {{ timeline.opId }} 执行时间线</h3>
          <div v-if="timeline.records.length" class="table-wrap">
            <table class="data-table">
              <thead><tr><th>动作</th><th>时间</th><th>原因码</th><th>偏差(分)</th><th>备注</th></tr></thead>
              <tbody>
                <tr v-for="(r, i) in timeline.records" :key="i">
                  <td><StatusTag :status="r.status" /></td>
                  <td>{{ fmtDateTime(r.occurredAt || r.actualStartAt || r.actualEndAt || r.createdAt) }}</td>
                  <td><StatusTag v-if="r.reasonCode" :status="r.reasonCode" /><template v-else>-</template></td>
                  <td>{{ r.deviationMinutes ?? '-' }}</td>
                  <td>{{ r.remark || '-' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-else class="muted">暂无执行记录。</p>
        </template>
      </div>
    </section>
  </div>
</template>

<script setup>
import { computed, h, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessageBox } from 'element-plus';
import { Api } from '../api';
import { toast, toastErr } from '../utils/ui';
import { fmtDateTime } from '../utils/format';
import { useSharedStore } from '../stores/shared';
import StatusTag from '../components/StatusTag.vue';
import ErrorBox from '../components/ErrorBox.vue';
import EmptyScreen from '../components/EmptyScreen.vue';

const router = useRouter();
const shared = useSharedStore();

const dashboard = ref(null);
const plan = ref(null);
const ops = ref([]);
const opStatus = ref({});
const loading = ref(true);
const error = ref(null);
const errorTitle = ref('加载失败');

const timeline = reactive({ visible: false, opId: '', loading: false, error: null, records: [] });

function statusOf(o) {
  return opStatus.value[o.operationId] || 'NOT_STARTED';
}

const counts = computed(() => {
  const c = { NOT_STARTED: 0, RUNNING: 0, PAUSED: 0, COMPLETED: 0 };
  ops.value.forEach(o => { const s = statusOf(o); c[s] = (c[s] || 0) + 1; });
  return c;
});
const deviationCount = computed(() => ops.value.filter(o => o.executionDeviation).length);

async function load() {
  loading.value = true; error.value = null;
  timeline.visible = false;
  let orders;
  try {
    [dashboard.value, orders] = await Promise.all([Api.dashboard(), Api.orders()]);
    shared.dashboard = dashboard.value;
  } catch (e) {
    errorTitle.value = '加载失败'; error.value = e; loading.value = false; return;
  }
  if (!dashboard.value.currentPlan) { loading.value = false; return; }
  try {
    const [p, opsPage] = await Promise.all([
      Api.planVersion(dashboard.value.currentPlan.id),
      Api.planVersionOperations(dashboard.value.currentPlan.id),
    ]);
    plan.value = p;
    const st = {};
    orders.forEach(o => (o.operations || []).forEach(op => { st[op.operationId] = op.status; }));
    opStatus.value = st;
    ops.value = (opsPage.items || []).slice().sort((a, b) => (a.startAt < b.startAt ? -1 : 1));
  } catch (e) {
    errorTitle.value = '计划详情加载失败'; error.value = e;
  } finally {
    loading.value = false;
  }
}

async function promptText(message, title) {
  try {
    const { value } = await ElMessageBox.prompt(message, title, {
      confirmButtonText: '确定', cancelButtonText: '取消',
    });
    return value;
  } catch { return null; }
}

async function feedback(o, st) {
  const now = new Date().toISOString();
  let payload;
  if (st === 'RUNNING') payload = { status: 'RUNNING', actualStartAt: now };
  else if (st === 'COMPLETED') payload = { status: 'COMPLETED', actualEndAt: now };
  else if (st === 'RESUMED') payload = { status: 'RESUMED' };
  else if (st === 'PAUSED') {
    const reason = await promptText('请输入暂停原因（必填）：', '暂停工序');
    if (reason === null) return;
    if (!reason.trim()) { toast('暂停原因不能为空', 'error'); return; }
    payload = { status: 'PAUSED', remark: reason.trim() };
  } else if (st === 'EXCEPTION') {
    const reasonCode = await promptText(
      h('div', [
        h('p', { style: 'margin:0 0 6px' }, '请选择异常原因码：'),
        h('p', { style: 'margin:0' }, 'MACHINE_BREAKDOWN 设备故障 / CALENDAR_BLOCKED 日历阻塞 / PREDECESSOR_WAIT 前工序等待 / QUALITY_ISSUE 质量问题 / MATERIAL_SHORTAGE 物料短缺'),
      ]),
      '异常反馈',
    );
    if (reasonCode === null) return;
    if (!reasonCode.trim()) { toast('异常原因码不能为空', 'error'); return; }
    const remark = await promptText('请填写异常备注（必填）：', '异常反馈');
    if (remark === null) return;
    if (!remark.trim()) { toast('异常备注不能为空', 'error'); return; }
    payload = { status: 'EXCEPTION', reasonCode: reasonCode.trim(), remark: remark.trim() };
  }
  const label = { RUNNING: '开工', PAUSED: '暂停', RESUMED: '恢复', COMPLETED: '完工', EXCEPTION: '异常' }[st];
  try {
    const r = await Api.execution(o.operationId, payload);
    toast(r.reasonCode === 'EXECUTION_DEVIATION'
      ? `工序 ${o.operationId} 已反馈${label}，偏差 ${r.deviationMinutes} 分钟，已标记执行偏差`
      : `工序 ${o.operationId} 已反馈${label}`);
    load();
  } catch (e) { toastErr(e, '执行反馈失败'); }
}

function goReschedule(o) {
  toast(`工序 ${o.operationId} 存在执行偏差/异常，请登记事件后创建重调度任务`);
  router.push({ name: 'breakdown' });
}

async function showTimeline(opId) {
  timeline.visible = true;
  timeline.opId = opId;
  timeline.loading = true;
  timeline.error = null;
  timeline.records = [];
  try {
    timeline.records = await Api.executionTimeline(opId);
  } catch (e) {
    timeline.error = e;
  } finally {
    timeline.loading = false;
  }
}

onMounted(load);
</script>

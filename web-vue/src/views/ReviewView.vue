<template>
  <AsyncPage :loading="loading" :error="error" error-title="版本列表加载失败" loading-text="正在加载审核队列…">
    <div class="page-header">
      <div><h1>待审核方案</h1><p>审核候选计划版本并发布为车间执行计划</p></div>
      <div class="buttons"><button class="btn" @click="load">&#8635; 刷新队列</button></div>
    </div>
    <div class="task-center">
      <section class="card task-queue">
        <div class="task-queue-head"><h2>审批队列</h2><p>本页 {{ queue.length }} 项待处理 · 共 {{ page.total }} 个版本</p></div>
        <div class="task-queue-list">
          <template v-if="queue.length">
            <button v-for="v in queue" :key="v.id" class="task-queue-item" :class="{ active: v.id === selectedId }" @click="select(v.id)">
              <b>{{ v.versionCode }}</b><StatusTag :status="v.status" />
              <span><StatusTag :status="v.candidateType" /> {{ fmtDateTime(v.createdAt) }}</span>
            </button>
          </template>
          <div v-else class="empty-screen" style="padding:30px">暂无待审核方案</div>
        </div>
        <Pager :page="page" @change="onPage" />
      </section>
      <section class="card task-detail">
        <div v-if="detailLoading" class="loading-block"><div class="spin"></div><div>加载版本详情…</div></div>
        <ErrorBox v-else-if="detailError" :error="detailError" title="版本详情加载失败" />
        <template v-else-if="detail">
          <div class="task-detail-head">
            <div>
              <h2>{{ detail.versionCode }}</h2>
              <p><StatusTag :status="detail.candidateType" /> 创建于 {{ fmtDateTime(detail.createdAt) }}<template v-if="parent"> · 基于 {{ parent.versionCode }}</template></p>
            </div>
            <StatusTag :status="detail.status" />
          </div>
          <div class="stage-flow">
            <div v-for="(s, i) in STATUS_FLOW" :key="s" class="stage-node" :class="{ done: i < flowPos, active: i === flowPos }">
              <b>{{ s.replace('_', ' ') }}</b>
            </div>
          </div>
          <div class="section-pad">
            <div class="task-overview-grid">
              <div class="task-overview-block"><span>总完工时间 C_max</span><b>{{ fmtMinutes(kpi.cMaxMinutes) }}</b></div>
              <div class="task-overview-block"><span>加权拖期</span><b>{{ fmtMinutes(kpi.weightedTardinessMinutes) }}</b></div>
              <div class="task-overview-block"><span>延期订单数</span><b>{{ kpi.nTardy ?? '-' }}</b></div>
              <div class="task-overview-block"><span>计划扰动 Δ_plan</span><b>{{ kpi.deltaPlan ? kpi.deltaPlan.deltaPlan.toFixed(3) : '-' }}</b></div>
              <div class="task-overview-block"><span>乐观锁版本号</span><b>{{ detail.version }}</b></div>
              <div class="task-overview-block"><span>工序数</span><b>{{ detail.operationCount ?? '-' }}</b></div>
            </div>
            <div v-if="detail.reviewComment" class="info-box"><b>审核意见</b>{{ detail.reviewComment }}</div>
            <div v-if="actionErr" class="error-box"><b>{{ actionErr.title }}<span v-if="actionErr.code" class="pill"> {{ actionErr.code }}</span></b>{{ actionErr.message }}</div>
            <div class="review-actions" style="margin-top:16px">
              <input class="field" v-model="comment" placeholder="审核意见（驳回时必填）">
              <button v-if="detail.parentId" class="btn" @click="goCompare">查看对比</button>
              <button class="btn" @click="goGantt">查看甘特</button>
              <template v-if="detail.status === 'REVIEW_PENDING'">
                <button class="btn primary" v-role="['REVIEWER','ADMIN']" @click="approve">通过</button>
                <button class="btn danger" v-role="['REVIEWER','ADMIN']" @click="reject">驳回</button>
              </template>
              <button v-if="detail.status === 'REVIEWED'" class="btn primary" v-role="['PRODUCTION_MANAGER','ADMIN']" @click="publish">发布</button>
              <button v-if="detail.status === 'REJECTED'" class="btn primary" v-role="['DISPATCHER','ADMIN']" @click="revise">修改重提</button>
            </div>
          </div>
        </template>
        <div v-else class="empty-screen">没有需要处理的方案</div>
      </section>
    </div>
  </AsyncPage>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { Api } from '../api';
import { toast } from '../utils/ui';
import { fmtDateTime, fmtMinutes, errMsg } from '../utils/format';
import { useSharedStore } from '../stores/shared';
import StatusTag from '../components/StatusTag.vue';
import ErrorBox from '../components/ErrorBox.vue';
import Pager from '../components/Pager.vue';

const router = useRouter();
const shared = useSharedStore();

const STATUS_FLOW = ['DRAFT', 'REVIEW_PENDING', 'REVIEWED', 'PUBLISHED/EXECUTING'];

const loading = ref(true);
const error = ref(null);
const page = ref({ items: [], page: 0, total: 0, totalPages: 0 });
const selectedId = ref(null);
const detail = ref(null);
const detailLoading = ref(false);
const detailError = ref(null);
const comment = ref('');
const actionErr = ref(null);

const versions = computed(() => page.value.items || []);
const queue = computed(() => versions.value.filter(v =>
  v.status === 'REVIEW_PENDING' || v.status === 'REVIEWED' || v.status === 'REJECTED'));
const byId = computed(() => Object.fromEntries(versions.value.map(v => [v.id, v])));
const parent = computed(() => (detail.value && detail.value.parentId) ? byId.value[detail.value.parentId] || null : null);
const kpi = computed(() => (detail.value && detail.value.kpi) || {});
const flowPos = computed(() => {
  const st = detail.value ? detail.value.status : '';
  return STATUS_FLOW.findIndex(s => st === s || (s === 'PUBLISHED/EXECUTING' && (st === 'PUBLISHED' || st === 'EXECUTING')));
});

async function load() {
  loading.value = true; error.value = null;
  try {
    page.value = await Api.planVersionsPage(shared.reviewPageNo || 0, 10);
  } catch (e) {
    error.value = e;
    loading.value = false;
    return;
  }
  loading.value = false;
  if (queue.value.length) {
    selectedId.value = queue.value[0].id;
    await loadDetail(queue.value[0].id);
  } else {
    selectedId.value = null;
    detail.value = null;
  }
}

function onPage(delta) {
  shared.reviewPageNo = (page.value.page || 0) + delta;
  load();
}

function select(id) {
  selectedId.value = id;
  loadDetail(id);
}

async function loadDetail(id) {
  detailLoading.value = true; detailError.value = null; actionErr.value = null; comment.value = '';
  try {
    detail.value = await Api.planVersion(id);
  } catch (e) {
    detail.value = null;
    detailError.value = e;
  } finally {
    detailLoading.value = false;
  }
}

function fail(e, title) {
  actionErr.value = { title, code: e && e.code, message: errMsg(e) };
}

function goCompare() {
  shared.compareBaselineId = detail.value.parentId;
  shared.compareCandidateId = detail.value.id;
  router.push({ name: 'compare' });
}

function goGantt() {
  shared.ganttVersionId = detail.value.id;
  router.push({ name: 'resource-gantt' });
}

async function approve() {
  const v = detail.value;
  try {
    await Api.review(v.id, { decision: 'APPROVE', comment: comment.value.trim(), version: v.version });
    toast(v.versionCode + ' 已审核通过');
    load();
  } catch (e) { fail(e, '审核失败'); }
}

async function reject() {
  const v = detail.value;
  const c = comment.value.trim();
  if (!c) { actionErr.value = { title: '', code: null, message: '驳回前必须填写审核意见' }; return; }
  try {
    await Api.review(v.id, { decision: 'REJECT', comment: c, version: v.version });
    toast(v.versionCode + ' 已驳回', 'info');
    load();
  } catch (e) { fail(e, '驳回失败'); }
}

async function publish() {
  const v = detail.value;
  try {
    const before = shared.dashboard && shared.dashboard.currentPlan ? shared.dashboard.currentPlan.versionCode : null;
    await Api.publish(v.id, v.version);
    toast(`发布成功：${before ? before + ' → ' : ''}${v.versionCode} 已成为当前执行计划`);
    await shared.refreshDashboard();
    load();
  } catch (e) { fail(e, '发布失败'); }
}

async function revise() {
  const v = detail.value;
  try {
    await Api.revise(v.id, v.version);
    toast(v.versionCode + ' 已退回草稿，可修改后重新提交审核', 'info');
    load();
  } catch (e) { fail(e, '退回修改失败'); }
}

onMounted(load);
</script>

<style scoped>
.stage-flow { display:flex; gap:14px; padding:12px 20px; border-bottom:1px solid #ebeef5; }
.stage-node { flex:1; text-align:center; padding:8px 0; border-bottom:3px solid #ebeef5; }
.stage-node b { display:block; font-size:13px; color:#909399; }
.stage-node.done { border-bottom-color:#67c23a; }
.stage-node.done b { color:#67c23a; }
.stage-node.active { border-bottom-color:#409eff; }
.stage-node.active b { color:#409eff; }
</style>

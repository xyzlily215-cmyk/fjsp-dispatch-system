<template>
  <div v-if="loading" class="loading-block"><div class="spin"></div><div>正在加载版本…</div></div>
  <ErrorBox v-else-if="error" :error="error" title="版本列表加载失败" />
  <div v-else>
    <div class="page-header">
      <div><h1>计划版本</h1><p>不可变版本账本</p></div>
      <div class="buttons"><button class="btn" @click="load">&#8635; 刷新</button></div>
    </div>
    <section class="card table-card">
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>版本</th><th>类型</th><th>父版本</th><th>状态</th><th>C_max</th><th>加权拖期</th><th>延期单数</th><th>发布时间</th><th>创建时间</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="v in versions" :key="v.id">
              <td><b>{{ v.versionCode }}</b> <span v-if="v.id === currentId" class="tag green">当前发布</span></td>
              <td><StatusTag :status="v.candidateType" /></td>
              <td>{{ v.parentId && byId[v.parentId] ? byId[v.parentId].versionCode : '-' }}</td>
              <td><StatusTag :status="v.status" /></td>
              <td>{{ fmtMinutes(v.kpi && v.kpi.cMaxMinutes) }}</td>
              <td>{{ fmtMinutes(v.kpi && v.kpi.weightedTardinessMinutes) }}</td>
              <td>{{ v.kpi ? v.kpi.nTardy : '-' }}</td>
              <td>{{ fmtDateTime(v.publishedAt) }}</td>
              <td>{{ fmtDateTime(v.createdAt) }}</td>
              <td class="table-actions">
                <a @click="goGantt(v)">甘特</a>
                <a v-if="v.parentId" @click="goCompare(v)">对比</a>
                <a @click="exportCsv(v)">导出 CSV</a>
                <a v-if="v.status === 'DRAFT'" @click="submit(v)">提交审核</a>
                <a v-if="v.status === 'SUPERSEDED'" v-role="['REVIEWER','ADMIN']" style="color:#e6a23c" @click="rollback(v)">回滚</a>
              </td>
            </tr>
            <tr v-if="!versions.length"><td colspan="10" style="text-align:center;color:#909399">暂无版本</td></tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<script setup>
import { computed, h, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessageBox } from 'element-plus';
import { Api } from '../api';
import { toast, toastErr } from '../utils/ui';
import { fmtDateTime, fmtMinutes } from '../utils/format';
import { useSharedStore } from '../stores/shared';
import StatusTag from '../components/StatusTag.vue';
import ErrorBox from '../components/ErrorBox.vue';

const router = useRouter();
const shared = useSharedStore();

const versions = ref([]);
const dashboard = ref(null);
const loading = ref(true);
const error = ref(null);

const currentId = computed(() => dashboard.value.currentPlan && dashboard.value.currentPlan.id);
const byId = computed(() => Object.fromEntries(versions.value.map(v => [v.id, v])));

async function load() {
  loading.value = true; error.value = null;
  try {
    [versions.value, dashboard.value] = await Promise.all([Api.planVersions(), Api.dashboard()]);
    shared.dashboard = dashboard.value;
  } catch (e) {
    error.value = e;
  } finally {
    loading.value = false;
  }
}

function goGantt(v) {
  shared.ganttVersionId = v.id;
  router.push({ name: 'resource-gantt' });
}

function goCompare(v) {
  shared.compareBaselineId = v.parentId;
  shared.compareCandidateId = v.id;
  router.push({ name: 'compare' });
}

async function exportCsv(v) {
  try {
    await Api.exportPlanVersion(v.id);
    toast(v.versionCode + ' CSV 已开始下载');
  } catch (e) { toastErr(e, '导出失败'); }
}

async function submit(v) {
  try {
    const pv = await Api.planVersion(v.id);
    await Api.submitReview(v.id, pv.version);
    toast(v.versionCode + ' 已提交审核');
    load();
  } catch (e) { toastErr(e, '提交审核失败'); }
}

async function rollback(v) {
  let value;
  try {
    ({ value } = await ElMessageBox.prompt(
      h('div', [
        h('p', { style: 'margin:0 0 6px' }, `回滚 ${v.versionCode}：将复制该历史版本的排程快照生成新草稿（不覆盖历史版本）。`),
        h('p', { style: 'margin:0 0 6px' }, '当前已完成/加工中/冻结窗内工序的安排以实际为准；存在冲突将被拒绝。'),
        h('p', { style: 'margin:0' }, '请填写回滚原因：'),
      ]),
      '回滚版本',
      { confirmButtonText: '确定', cancelButtonText: '取消' },
    ));
  } catch { return; }
  if (!value || !value.trim()) { toast('回滚原因不能为空', 'error'); return; }
  try {
    const r = await Api.rollback(v.id, value.trim());
    toast(`已生成回滚草稿 ${r.versionCode}，提交审核并发布后生效`);
    load();
  } catch (e) {
    if (e.code === 'E_ROLLBACK_CONFLICT') toastErr(e, '回滚冲突，未生成草稿');
    else toastErr(e, '回滚失败');
  }
}

onMounted(load);
</script>

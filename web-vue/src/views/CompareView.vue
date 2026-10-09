<template>
  <AsyncPage :loading="loading" :error="error" error-title="版本列表加载失败" loading-text="正在加载版本列表…" :empty="!versions.length">
    <template #empty>
    <div class="page-header"><div><h1>方案对比</h1><p>对比两个计划版本的逐工序差异</p></div></div>
    <section class="card"><EmptyScreen title="暂无计划版本" text="先创建基线排程。" /></section>
    </template>
    <div class="page-header">
      <div><h1>方案对比</h1><p>基准版本与候选版本的 KPI 与逐工序差异</p></div>
      <div class="buttons">
        <button class="btn" @click="runCompare">开始对比</button>
        <button class="btn" @click="exportCsv">导出候选版本 CSV</button>
      </div>
    </div>
    <section class="card section-card">
      <div class="toolbar"><div class="filters">
        <span class="filter-label">基准版本</span>
        <select class="field wide" v-model="selBaseline">
          <option v-for="v in versions" :key="v.id" :value="v.id">{{ v.versionCode }} · {{ v.status }} · {{ fmtDateTime(v.createdAt) }}</option>
        </select>
        <span class="filter-label" style="margin-left:10px">候选版本</span>
        <select class="field wide" v-model="selCandidate">
          <option v-for="v in versions" :key="v.id" :value="v.id">{{ v.versionCode }} · {{ v.status }} · {{ fmtDateTime(v.createdAt) }}</option>
        </select>
      </div></div>

      <div v-if="!canDiff" class="empty-screen" style="padding:30px">请选择两个不同的版本进行对比</div>
      <div v-else-if="diffLoading" class="loading-block"><div class="spin"></div><div>正在计算差异…</div></div>
      <ErrorBox v-else-if="diffError" :error="diffError" title="差异计算失败" />
      <template v-else-if="diff">
        <div class="compare-top">
          <div class="compare-score"><label>总完工时间 C_max</label><b>{{ fmtMinutes(kpi.cMaxMinutes) }}</b><br>
            <em :class="deltaInfo(kd.cMaxMinutes != null ? kd.cMaxMinutes / 60 : null).cls">{{ deltaInfo(kd.cMaxMinutes != null ? kd.cMaxMinutes / 60 : null).text }}</em></div>
          <div class="compare-score"><label>加权拖期</label><b>{{ fmtMinutes(kpi.weightedTardinessMinutes) }}</b><br>
            <em :class="deltaInfo(kd.weightedTardinessMinutes != null ? kd.weightedTardinessMinutes / 60 : null).cls">{{ deltaInfo(kd.weightedTardinessMinutes != null ? kd.weightedTardinessMinutes / 60 : null).text }}</em></div>
          <div class="compare-score"><label>延期订单数</label><b>{{ (kpi.nTardy ?? '-') + ' 单' }}</b><br>
            <em :class="deltaInfo(kd.nTardy).cls">{{ deltaInfo(kd.nTardy).text }}</em></div>
          <div class="compare-score"><label>计划扰动 Δ_plan</label><b>{{ deltaPlan !== null ? deltaPlan.toFixed(3) : '-' }}</b><br>
            <em>{{ summary.timeShiftedCount || 0 }} 偏移 / {{ summary.machineChangedCount || 0 }} 换机 / {{ summary.sequenceChangedCount || 0 }} 顺序</em></div>
        </div>
        <div class="section-pad" style="border-bottom:1px solid #ebeef5">
          <span class="muted">对比 {{ diff.baselineVersionCode }} → {{ diff.candidateVersionCode }}：共 {{ summary.comparedOperations ?? '-' }} 道工序，
            新增 {{ (summary.addedOperations || []).length }} 道，移除 {{ (summary.removedOperations || []).length }} 道，发生变化 {{ changedOps.length }} 道。</span>
          <div v-if="removedSet.size" class="error-box" style="margin:10px 0 0">移除工序：{{ [...removedSet].join('、') }}</div>
        </div>
        <div class="table-wrap"><table class="data-table">
          <thead><tr><th>工序</th><th>原计划（{{ diff.baselineVersionCode }}）</th><th>候选方案（{{ diff.candidateVersionCode }}）</th><th>变更类型</th><th>影响原因</th><th>状态</th></tr></thead>
          <tbody>
            <tr v-for="o in changedOps" :key="o.operationId">
              <td>
                {{ o.operationId }}
                <span v-if="addedSet.has(o.operationId)" class="tag green">新增</span>
                <span v-if="o.frozen" class="tag orange">冻结</span>
              </td>
              <td>{{ o.oldMachineId || '-' }}<br><span class="muted">{{ fmtDateTime(o.oldStartAt) }}</span></td>
              <td>{{ o.newMachineId || '-' }}<br><span class="muted">{{ fmtDateTime(o.newStartAt) }}</span></td>
              <td><span v-for="t in changeTags(o)" :key="t.text" class="tag" :class="t.color">{{ t.text }}</span></td>
              <td>
                <span v-if="o.impactType" class="tag purple">{{ impactText(o.impactType) }}</span>
                <span v-else class="muted">-</span>
                <template v-if="o.reasonCode"><br><span class="muted">{{ reasonText(o.reasonCode) }}</span></template>
              </td>
              <td>
                <span v-if="o.frozen" class="tag gray">冻结未动</span>
                <span v-else-if="o.timeShiftMinutes || o.machineChanged || o.sequenceChanged" class="tag blue">已调整</span>
                <span v-else class="tag green">保持</span>
              </td>
            </tr>
            <tr v-if="!changedOps.length"><td colspan="6" style="text-align:center;color:#909399">两个版本的工序计划完全一致</td></tr>
          </tbody>
        </table></div>

        <!-- F-08：同候选组（局部/完全重调度）并列比较，异步填充，不阻塞主差异渲染 -->
        <div v-if="groupVisible" class="section-pad" style="border-top:1px solid #ebeef5">
          <h3 style="margin:0 0 10px;font-size:15px">同候选组并列比较（{{ candVer.candidateGroupId }}）</h3>
          <div v-if="groupLoading" class="loading-block"><div class="spin"></div><div>正在计算组内差异…</div></div>
          <div v-else class="table-wrap"><table class="data-table">
            <thead><tr><th>版本</th><th>候选类型</th><th>状态</th><th>C_max</th><th>加权拖期</th><th>延期订单</th><th>Δ_plan</th><th>偏移/换机/顺序</th><th>操作</th></tr></thead>
            <tbody>
              <tr v-for="row in groupRows" :key="row.v.id">
                <td>{{ row.v.versionCode }} <span v-if="row.v.id === candVer.id" class="tag blue">当前选中</span></td>
                <td><StatusTag v-if="row.v.candidateType" :status="row.v.candidateType" /><template v-else>-</template></td>
                <td><StatusTag :status="row.v.status" /></td>
                <template v-if="row.error">
                  <td colspan="5"><ErrorBox :error="row.error" title="差异计算失败" /></td>
                </template>
                <template v-else>
                  <td>{{ fmtMinutes(kpiOf(row.v).cMaxMinutes) }}</td>
                  <td>{{ fmtMinutes(kpiOf(row.v).weightedTardinessMinutes) }}</td>
                  <td>{{ kpiOf(row.v).nTardy ?? '-' }}</td>
                  <td>{{ dPlanOf(row.v) !== null ? dPlanOf(row.v).toFixed(3) : '-' }}</td>
                  <td><span class="muted">{{ (row.d.summary || {}).timeShiftedCount || 0 }} / {{ (row.d.summary || {}).machineChangedCount || 0 }} / {{ (row.d.summary || {}).sequenceChangedCount || 0 }}</span></td>
                </template>
                <td>
                  <span v-if="row.v.id === candVer.id" class="muted">-</span>
                  <button v-else class="btn small" @click="pickCandidate(row.v.id)">设为候选</button>
                </td>
              </tr>
            </tbody>
          </table></div>
        </div>
      </template>
    </section>
  </AsyncPage>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { Api } from '../api';
import { toast, toastErr } from '../utils/ui';
import { fmtDateTime, fmtMinutes, impactText, reasonText } from '../utils/format';
import { useSharedStore } from '../stores/shared';
import StatusTag from '../components/StatusTag.vue';
import ErrorBox from '../components/ErrorBox.vue';
import EmptyScreen from '../components/EmptyScreen.vue';

const shared = useSharedStore();

const loading = ref(true);
const error = ref(null);
const versions = ref([]);
/* sel* 为下拉框当前选择；baselineId/candidateId 为已提交对比的版本（点「开始对比」或组内「设为候选」才生效） */
const selBaseline = ref(null);
const selCandidate = ref(null);
const baselineId = ref(null);
const candidateId = ref(null);

const diff = ref(null);
const candVer = ref(null);
const diffLoading = ref(false);
const diffError = ref(null);

const groupVisible = ref(false);
const groupLoading = ref(false);
const groupRows = ref([]);
/* 旧版基准版本持久在 Shared 中：仅当入口预选或点过「开始对比」时基准才算显式指定；
 * 否则组内「设为候选」会按新候选的 parentId 重推基准 */
const baselineExplicit = ref(false);

const canDiff = computed(() => baselineId.value && candidateId.value && baselineId.value !== candidateId.value);
const kpi = computed(() => (candVer.value && candVer.value.kpi) || {});
const kd = computed(() => (diff.value && diff.value.kpiDiff) || {});
const summary = computed(() => (diff.value && diff.value.summary) || {});
const deltaPlan = computed(() => (kpi.value.deltaPlan ? kpi.value.deltaPlan.deltaPlan : null));
const changedOps = computed(() => ((diff.value && diff.value.operations) || []).filter(o =>
  o.timeShiftMinutes || o.machineChanged || o.sequenceChanged || o.frozen || o.impactType));
const addedSet = computed(() => new Set(summary.value.addedOperations || []));
const removedSet = computed(() => new Set(summary.value.removedOperations || []));

function deltaInfo(v, invert = true) {
  if (v === null || v === undefined || v === 0) return { cls: 'good', text: '±0' };
  const better = invert ? v < 0 : v > 0;
  return { cls: better ? 'good' : 'bad', text: (v > 0 ? '+' : '') + (typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(3) : v) };
}

function changeTags(o) {
  const tags = [];
  if (o.machineChanged) tags.push({ text: '换机', color: 'red' });
  if (o.sequenceChanged) tags.push({ text: '顺序变化', color: 'orange' });
  if (o.timeShiftMinutes) tags.push({ text: `偏移 ${o.timeShiftMinutes > 0 ? '+' : ''}${o.timeShiftMinutes}min`, color: 'blue' });
  if (o.isAdded) tags.push({ text: '新增', color: 'green' });
  if (!tags.length) tags.push({ text: '不变', color: 'gray' });
  return tags;
}

const kpiOf = (v) => v.kpi || {};
const dPlanOf = (v) => (kpiOf(v).deltaPlan ? kpiOf(v).deltaPlan.deltaPlan : null);

async function runDiff() {
  diff.value = null; candVer.value = null; diffError.value = null;
  groupVisible.value = false; groupRows.value = [];
  if (!canDiff.value) return;
  diffLoading.value = true;
  try {
    [diff.value, candVer.value] = await Promise.all([
      Api.diff(candidateId.value, baselineId.value),
      Api.planVersion(candidateId.value),
    ]);
  } catch (e) {
    diffError.value = e;
    diffLoading.value = false;
    return;
  }
  diffLoading.value = false;
  loadGroup();
}

/* 同 candidateGroupId 的候选方案（局部/完全）并列：KPI、计划扰动与变更规模相对同一基准版本比较 */
async function loadGroup() {
  if (!candVer.value || !candVer.value.candidateGroupId) return;
  const members = versions.value.filter(v => v.candidateGroupId === candVer.value.candidateGroupId).slice(0, 4);
  if (members.length < 2) return;
  groupVisible.value = true;
  groupLoading.value = true;
  const rows = [];
  for (const v of members) {
    if (v.id === candVer.value.id) { rows.push({ v, d: diff.value }); continue; }
    try { rows.push({ v, d: await Api.diff(v.id, baselineId.value) }); }
    catch (e) { rows.push({ v, error: e }); }
  }
  groupRows.value = rows;
  groupLoading.value = false;
}

function runCompare() {
  baselineId.value = selBaseline.value;
  candidateId.value = selCandidate.value;
  baselineExplicit.value = true;
  runDiff();
}

function pickCandidate(id) {
  selCandidate.value = id;
  candidateId.value = id;
  if (!baselineExplicit.value) {
    const cand = versions.value.find(v => v.id === id);
    const b = (cand && cand.parentId && versions.value.some(v => v.id === cand.parentId))
      ? cand.parentId
      : (versions.value.find(v => v.id !== id) || {}).id;
    selBaseline.value = baselineId.value = b;
  }
  runDiff();
}

async function exportCsv() {
  try {
    await Api.exportPlanVersion(selCandidate.value);
    toast('CSV 已开始下载');
  } catch (e) { toastErr(e, '导出失败'); }
}

onMounted(async () => {
  loading.value = true; error.value = null;
  try {
    versions.value = await Api.planVersions();
  } catch (e) {
    error.value = e;
    loading.value = false;
    return;
  }
  loading.value = false;
  if (!versions.value.length) return;

  /* 跨页预选参数消费一次后清除 */
  let b = shared.compareBaselineId;
  let c = shared.compareCandidateId;
  shared.compareBaselineId = null;
  shared.compareCandidateId = null;

  baselineExplicit.value = versions.value.some(v => v.id === b);
  if (!versions.value.some(v => v.id === c)) c = versions.value[0].id;
  if (!versions.value.some(v => v.id === b)) {
    const cand = versions.value.find(v => v.id === c);
    b = (cand && cand.parentId && versions.value.some(v => v.id === cand.parentId))
      ? cand.parentId
      : (versions.value.find(v => v.id !== c) || {}).id;
  }
  selBaseline.value = baselineId.value = b;
  selCandidate.value = candidateId.value = c;
  runDiff();
});
</script>

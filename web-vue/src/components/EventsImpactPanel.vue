<template>
  <div class="success-box"><b>事件已登记：{{ data.eventCode }}</b>事件 ID {{ data.eventId }}</div>
  <div class="impact-kpis">
    <div class="impact-kpi" :class="{ warn: !!summary.total }"><span>影响工序数</span><b>{{ summary.total ?? 0 }}</b></div>
    <div class="impact-kpi"><span>硬锁定工序</span><b>{{ hardLocks }}</b></div>
  </div>
  <p v-if="byTypeText" class="muted">影响类型：{{ byTypeText }}</p>
  <p v-else class="muted">当前发布计划内无受影响工序。</p>
  <div v-if="impacts.length" class="table-wrap" style="max-height:260px;margin-top:10px">
    <table class="data-table">
      <thead><tr><th>工序</th><th>影响类型</th><th>锁定</th><th>原因</th></tr></thead>
      <tbody>
        <tr v-for="(i, idx) in impacts.slice(0, 30)" :key="idx">
          <td>{{ i.operationId }}</td>
          <td><span class="tag purple">{{ impactText(i.impactType) }}</span></td>
          <td>
            <span v-if="i.lockType === 'HARD_LOCKED' || i.lockType === 'FROZEN'" class="tag red">硬锁定</span>
            <span v-else class="tag gray">可调整</span>
          </td>
          <td><span class="muted">{{ i.impactReason || reasonText(i.reasonCode) }}</span></td>
        </tr>
      </tbody>
    </table>
  </div>
  <div class="section-pad" style="margin-top:16px;border:1px dashed #dcdfe6;border-radius:4px;padding:14px">
    <b style="font-size:13px">去重调度</b>
    <p class="muted" style="margin:6px 0 10px">进入重调度向导：选择原计划版本 → 预览影响范围（硬/软锁定、局部/完全规模）→ 选择模式并创建任务。</p>
    <button class="btn primary" v-role="['DISPATCHER', 'ADMIN']" @click="openWizard">打开重调度向导</button>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { impactText, reasonText } from '../utils/format';

const props = defineProps({
  /* 事件提交响应 {eventId,eventCode,impactSummary} */
  data: { type: Object, required: true },
  /* Api.event(eventId) 详情（可为 null） */
  detail: { type: Object, default: null },
});

const router = useRouter();

const summary = computed(() => props.data.impactSummary || { total: 0, byType: {} });
const impacts = computed(() => (props.detail && props.detail.impacts) || []);
const hardLocks = computed(() =>
  impacts.value.filter(i => i.lockType === 'HARD_LOCKED' || i.lockType === 'FROZEN').length);
const byTypeText = computed(() =>
  Object.entries(summary.value.byType || {}).map(([k, v]) => `${impactText(k)} × ${v}`).join('，'));

function openWizard() {
  router.push({ name: 'reschedule', query: { eventId: props.data.eventId } });
}
</script>

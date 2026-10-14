<template>
  <AsyncPage :loading="loading" :error="error" error-title="设备加载失败" loading-text="正在加载设备…">
    <div class="page-header">
      <div>
        <h1>{{ reviseFrom ? '修订故障事件' : '设备故障' }}</h1>
        <p>{{ reviseFrom
          ? `更正事件 ${reviseFrom.eventCode}：创建携带 revisionOf 的新事件，原事件自动关闭`
          : '登记设备故障事件，并触发重调度' }}</p>
      </div>
    </div>
    <div v-if="reviseFrom" class="success-box" style="margin-bottom:12px">
      <b>修订模式</b>原事件 {{ reviseFrom.eventCode }}（设备 {{ reviseFrom.machineId || '-' }}）；维修结束时间与影响集合将按修订后字段重算。
    </div>
    <div class="grid-2" style="grid-template-columns:1fr 1fr;align-items:start">
      <section class="card"><div class="section-pad">
        <h3 style="margin:0 0 14px;font-size:15px">{{ reviseFrom ? '修订内容' : '故障事件' }}</h3>
        <div v-if="reviseFrom" class="form-row">
          <label class="required">修订原因</label>
          <input class="field" v-model="form.reason" placeholder="必填，随新事件保存">
        </div>
        <div class="form-row">
          <label class="required">设备</label>
          <select class="field" v-model="form.machineId" :disabled="!!reviseFrom">
            <option v-for="m in machines" :key="m.machineId" :value="m.machineId">
              {{ m.machineId }} · {{ m.workCenterId }}（{{ m.status }}）
            </option>
          </select>
        </div>
        <div class="form-row">
          <label class="required">发生时间</label>
          <input type="datetime-local" class="field" v-model="form.occurredAt">
        </div>
        <div class="form-row">
          <label class="required">维修时长(分)</label>
          <input type="number" class="field" v-model="form.repairDurationMinutes" min="1">
        </div>
        <div class="form-row">
          <label>来源</label>
          <select class="field" v-model="form.source">
            <option value="manual">人工登记</option>
            <option value="iot">IoT 采集</option>
            <option value="mes">MES 推送</option>
          </select>
        </div>
        <div class="form-row">
          <label>备注</label>
          <textarea class="field" v-model="form.note" placeholder="可选"></textarea>
        </div>
        <div v-if="formErr" class="error-box">{{ formErr }}</div>
        <ErrorBox v-if="submitError" :error="submitError" :title="reviseFrom ? '修订提交失败' : '故障登记失败'" />
        <button class="btn primary" style="width:100%;height:36px" v-role="['DISPATCHER', 'ADMIN']"
          :disabled="submitting" @click="submit">
          {{ submitting ? '提交中…' : (reviseFrom ? '提交修订' : '登记故障事件') }}
        </button>
        <p class="muted" style="margin-top:10px">若事件正在被求解任务使用（E_EVENT_IN_PROCESS），或同设备存在维修区间重叠的未关闭故障（E_DUPLICATE），会以红色错误提示返回。</p>
      </div></section>
      <section class="card"><div class="section-pad">
        <h3 style="margin:0 0 10px;font-size:15px">影响集合</h3>
        <EventsImpactPanel v-if="result" :data="result.data" :detail="result.detail" />
        <p v-else class="muted">提交事件后在此展示影响集合摘要与重调度入口。</p>
      </div></section>
    </div>

    <section class="card table-card" style="margin-top:14px">
      <div class="section-pad" style="display:flex;justify-content:space-between;align-items:center;padding-bottom:8px">
        <h3 style="margin:0;font-size:15px">事件记录</h3>
        <select class="field" style="width:auto" :value="shared.eventsType" @change="onTypeChange">
          <option value="">全部类型</option>
          <option value="NEW_ORDER">新订单</option>
          <option value="BREAKDOWN">设备故障</option>
        </select>
      </div>
      <div class="table-wrap" style="max-height:360px">
        <table class="data-table">
          <thead><tr><th>事件号</th><th>类型</th><th>对象</th><th>发生时间</th><th>状态</th><th>来源</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="ev in eventsPage.items" :key="ev.eventId">
              <td>{{ ev.eventCode }} <span v-if="ev.revisionOf" class="tag purple">修订</span></td>
              <td><StatusTag :status="ev.subType || ev.eventType" /></td>
              <td>{{ ev.machineId || ev.orderId || '-' }}</td>
              <td>{{ fmtDateTime(ev.occurredAt) }}</td>
              <td><StatusTag :status="ev.status" /></td>
              <td>{{ ev.source || '-' }}</td>
              <td>
                <span v-if="ev.status === 'CLOSED'" class="muted">已关闭</span>
                <template v-else>
                  <button class="btn small" v-role="['DISPATCHER', 'ADMIN']" @click="revise(ev)">修订</button>
                  <button class="btn small" v-role="['DISPATCHER', 'ADMIN']"
                    :disabled="closingId === ev.eventId" @click="close(ev)">关闭</button>
                </template>
              </td>
            </tr>
            <tr v-if="!eventsPage.items.length">
              <td colspan="7" style="text-align:center;color:#909399">暂无事件</td>
            </tr>
          </tbody>
        </table>
      </div>
      <Pager :page="eventsPage" @change="onPage" />
    </section>
  </AsyncPage>
</template>

<script setup>
import { onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Api } from '../api';
import { toast, toastErr } from '../utils/ui';
import { fmtDateTime, isoToLocalInput, localInputToIso, errMsg } from '../utils/format';
import { useSharedStore } from '../stores/shared';
import StatusTag from '../components/StatusTag.vue';
import ErrorBox from '../components/ErrorBox.vue';
import EventsImpactPanel from '../components/EventsImpactPanel.vue';
import Pager from '../components/Pager.vue';

const route = useRoute();
const router = useRouter();
const shared = useSharedStore();

const machines = ref([]);
const eventsPage = ref({ items: [], page: 0, size: 10, total: 0, totalPages: 0 });
const loading = ref(true);
const error = ref(null);
const reviseFrom = ref(null);
const submitting = ref(false);
const closingId = ref(null);
const formErr = ref('');
const submitError = ref(null);
const result = ref(null);

const form = reactive({
  reason: '', machineId: '', occurredAt: '', repairDurationMinutes: 120, source: 'manual', note: '',
});

function resetForm() {
  const rev = reviseFrom.value;
  form.reason = '';
  form.machineId = rev
    ? (rev.machineId || (machines.value[0] || {}).machineId || '')
    : ((machines.value[0] || {}).machineId || '');
  form.occurredAt = rev
    ? isoToLocalInput(rev.occurredAt)
    : isoToLocalInput(new Date(Date.now() + 24 * 3600e3).toISOString());
  form.repairDurationMinutes = rev ? (rev.repairDurationMinutes || 120) : 120;
  form.source = rev && ['manual', 'iot', 'mes'].includes(rev.source) ? rev.source : 'manual';
  form.note = rev ? (rev.note || '') : '';
  formErr.value = '';
  submitError.value = null;
  result.value = null;
}

/* F-07 事件修订：路由 query.reviseFrom 携带原事件 id 时预填并切换为修订提交；设备不可随修订更改 */
async function resolveReviseFrom() {
  const id = route.query.reviseFrom;
  reviseFrom.value = null;
  if (!id) return;
  try {
    const ev = await Api.event(id);
    if (ev && ev.eventType === 'BREAKDOWN') reviseFrom.value = ev;
  } catch (e) { /* 忽略，按普通登记进入 */ }
}

async function init() {
  loading.value = true; error.value = null;
  try {
    [machines.value, eventsPage.value] = await Promise.all([
      Api.machines(),
      Api.eventsPage({ page: shared.eventsPageNo || 0, size: 10, eventType: shared.eventsType || undefined }),
      resolveReviseFrom(),
    ]);
    resetForm();
  } catch (e) {
    error.value = e;
  } finally {
    loading.value = false;
  }
}

async function reloadEvents() {
  try {
    eventsPage.value = await Api.eventsPage({
      page: shared.eventsPageNo || 0, size: 10, eventType: shared.eventsType || undefined,
    });
  } catch (e) {
    toastErr(e, '事件列表加载失败');
  }
}

function onTypeChange(e) {
  shared.eventsType = e.target.value;
  shared.eventsPageNo = 0;
  reloadEvents();
}

function onPage(delta) {
  shared.eventsPageNo = (shared.eventsPageNo || 0) + delta;
  reloadEvents();
}

function revise(ev) {
  router.push({
    name: ev.eventType === 'NEW_ORDER' ? 'insert' : 'breakdown',
    query: { reviseFrom: ev.eventId },
  });
}

async function close(ev) {
  try {
    await ElMessageBox.confirm(`确认关闭事件 ${ev.eventCode}？关闭后不可再触发重调度。`, '关闭事件', { type: 'warning' });
  } catch { return; }
  closingId.value = ev.eventId;
  try {
    await Api.closeEvent(ev.eventId);
    toast(`事件 ${ev.eventCode} 已关闭`);
    reloadEvents();
  } catch (e) {
    toast(errMsg(e), 'error');
  } finally {
    closingId.value = null;
  }
}

async function submit() {
  formErr.value = '';
  submitError.value = null;
  const occurred = localInputToIso(form.occurredAt);
  if (!occurred) { formErr.value = '请填写故障发生时间'; return; }
  submitting.value = true;
  try {
    let r;
    if (reviseFrom.value) {
      const reason = form.reason.trim();
      if (!reason) { formErr.value = '请填写修订原因'; return; }
      r = await Api.reviseEvent(reviseFrom.value.eventId, {
        reason,
        occurredAt: occurred,
        repairDurationMinutes: parseInt(form.repairDurationMinutes, 10),
        source: form.source,
        note: form.note.trim() || null,
      });
      toast(`修订事件 ${r.eventCode} 已创建，原事件 ${reviseFrom.value.eventCode} 已关闭`);
    } else {
      const payload = {
        machineId: form.machineId,
        occurredAt: occurred,
        repairDurationMinutes: parseInt(form.repairDurationMinutes, 10),
        source: form.source,
        note: form.note.trim() || undefined,
      };
      r = await Api.breakdownEvent(payload);
      toast(`故障事件 ${r.eventCode} 已登记`);
    }
    let detail = null;
    try { detail = await Api.event(r.eventId); } catch (e) { /* 详情加载失败仅影响明细展示 */ }
    result.value = { data: r, detail };
    reloadEvents();
  } catch (e) {
    submitError.value = e;
  } finally {
    submitting.value = false;
  }
}

watch(() => route.query.reviseFrom, init);
onMounted(init);
</script>

<template>
  <AsyncPage :loading="loading" :error="error" error-title="工艺模板加载失败" loading-text="正在加载工艺模板…">
    <div class="page-header">
      <div>
        <h1>{{ reviseFrom ? '修订插单事件' : '订单插单' }}</h1>
        <p>{{ reviseFrom
          ? `更正事件 ${reviseFrom.eventCode}：创建携带 revisionOf 的新事件，原事件自动关闭`
          : '登记新订单事件，并触发重调度' }}</p>
      </div>
    </div>
    <div v-if="reviseFrom" class="success-box" style="margin-bottom:12px">
      <b>修订模式</b>原事件 {{ reviseFrom.eventCode }}（{{ reviseFrom.orderId || '-' }}）；订单号、产品族、数量等订单字段不可随事件修订更改。
    </div>
    <AiInsightCard v-if="!reviseFrom" title="AI 插单助手" :free-input="aiFreeInput" style="margin-bottom:12px" />
    <div class="grid-2" style="grid-template-columns:1fr 1fr;align-items:start">
      <section class="card"><div class="section-pad">
        <h3 style="margin:0 0 14px;font-size:15px">{{ reviseFrom ? '修订内容' : '新订单事件' }}</h3>
        <div v-if="reviseFrom" class="form-row">
          <label class="required">修订原因</label>
          <input class="field" v-model="form.reason" placeholder="必填，随新事件保存">
        </div>
        <div class="form-row">
          <label class="required">事件子类</label>
          <select class="field" v-model="form.subType">
            <option value="URGENT_INSERT">紧急插单（URGENT_INSERT）</option>
            <option value="NORMAL_APPEND">常规追加（NORMAL_APPEND）</option>
          </select>
        </div>
        <div class="form-row">
          <label class="required">订单号</label>
          <input class="field" v-model="form.orderCode" :disabled="!!reviseFrom">
        </div>
        <div class="form-row">
          <label class="required">产品族</label>
          <select class="field" v-model="form.productFamily" :disabled="!!reviseFrom">
            <option v-for="f in families" :key="f" :value="f">{{ f }}</option>
          </select>
        </div>
        <div class="form-row">
          <label class="required">数量</label>
          <input type="number" class="field" v-model="form.quantity" min="1" :disabled="!!reviseFrom">
        </div>
        <div class="form-row">
          <label class="required">优先级</label>
          <input type="number" class="field" v-model="form.priority" min="1" max="5" :disabled="!!reviseFrom">
        </div>
        <div class="form-row">
          <label class="required">到达时间</label>
          <input type="datetime-local" class="field" v-model="form.arrivalAt" :disabled="!!reviseFrom">
        </div>
        <div class="form-row">
          <label class="required">交期</label>
          <input type="datetime-local" class="field" v-model="form.dueAt" :disabled="!!reviseFrom">
        </div>
        <div class="form-row">
          <label class="required">发生时间</label>
          <input type="datetime-local" class="field" v-model="form.occurredAt">
        </div>
        <div class="form-row">
          <label>备注</label>
          <textarea class="field" v-model="form.note" placeholder="可选"></textarea>
        </div>
        <div v-if="formErr" class="error-box">{{ formErr }}</div>
        <ErrorBox v-if="submitError" :error="submitError" :title="reviseFrom ? '修订提交失败' : '插单登记失败'" />
        <button class="btn primary" style="width:100%;height:36px" v-role="['DISPATCHER', 'ADMIN']"
          :disabled="submitting" @click="submit">
          {{ submitting ? '提交中…' : (reviseFrom ? '提交修订' : '登记插单事件') }}
        </button>
      </div></section>
      <section class="card"><div class="section-pad">
        <h3 style="margin:0 0 10px;font-size:15px">影响集合</h3>
        <EventsImpactPanel v-if="result" :data="result.data" :detail="result.detail" />
        <p v-else class="muted">提交事件后在此展示影响集合摘要与重调度入口。</p>
      </div></section>
    </div>
  </AsyncPage>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { Api } from '../api';
import { toast } from '../utils/ui';
import { isoToLocalInput, localInputToIso } from '../utils/format';
import ErrorBox from '../components/ErrorBox.vue';
import EventsImpactPanel from '../components/EventsImpactPanel.vue';
import AiInsightCard from '../components/AiInsightCard.vue';

const route = useRoute();

/* 页内 AI 卡片：自然语言插单——副驾解析描述并调 fjsp_insert_order（写操作走页内审批） */
const aiFreeInput = {
  placeholder: '用一句话描述插单，如：插一单 P-A 产品 50 件，明天 10 点到，周五 18 点交，优先级 8',
  button: 'AI 提交插单',
  wrap: (t) => `请按以下描述调用 fjsp_insert_order 完成插单（写操作我会人工审批）：${t}。缺失的参数参考现有订单的产品族命名与合理默认值；成功后告诉我事件 ID，并评估对当前发布计划的影响（可参考 fjsp_experience_query 的同类历史）。`,
};

const templates = ref([]);
const loading = ref(true);
const error = ref(null);
const reviseFrom = ref(null);
const submitting = ref(false);
const formErr = ref('');
const submitError = ref(null);
const result = ref(null);

const form = reactive({
  reason: '', subType: 'URGENT_INSERT', orderCode: '', productFamily: '',
  quantity: 20, priority: 1, arrivalAt: '', dueAt: '', occurredAt: '', note: '',
});

const families = computed(() => [...new Set(templates.value.map(t => t.productFamily))]);

function resetForm() {
  const rev = reviseFrom.value;
  form.reason = '';
  form.subType = rev && rev.subType === 'NORMAL_APPEND' ? 'NORMAL_APPEND' : 'URGENT_INSERT';
  form.orderCode = rev ? (rev.orderId || '') : 'ORD-NEW-' + Date.now() % 100000;
  form.productFamily = families.value[0] || '';
  form.quantity = 20;
  form.priority = 1;
  form.arrivalAt = isoToLocalInput(new Date(Date.now() + 24 * 3600e3).toISOString());
  form.dueAt = isoToLocalInput(new Date(Date.now() + 48 * 3600e3).toISOString());
  form.occurredAt = rev
    ? isoToLocalInput(rev.occurredAt)
    : isoToLocalInput(new Date(Date.now() + 24 * 3600e3).toISOString());
  form.note = rev ? (rev.note || '') : '';
  formErr.value = '';
  submitError.value = null;
  result.value = null;
}

/* F-07 事件修订：路由 query.reviseFrom 携带原事件 id 时预填并切换为修订提交 */
async function resolveReviseFrom() {
  const id = route.query.reviseFrom;
  reviseFrom.value = null;
  if (!id) return;
  try {
    const ev = await Api.event(id);
    if (ev && ev.eventType === 'NEW_ORDER') reviseFrom.value = ev;
  } catch (e) { /* 忽略，按普通登记进入 */ }
}

async function init() {
  loading.value = true; error.value = null;
  try {
    [templates.value] = await Promise.all([Api.templates(), resolveReviseFrom()]);
    resetForm();
  } catch (e) {
    error.value = e;
  } finally {
    loading.value = false;
  }
}

async function submit() {
  formErr.value = '';
  submitError.value = null;
  const occurredAt = localInputToIso(form.occurredAt);
  submitting.value = true;
  try {
    let r;
    if (reviseFrom.value) {
      const reason = form.reason.trim();
      if (!reason) { formErr.value = '请填写修订原因'; return; }
      r = await Api.reviseEvent(reviseFrom.value.eventId, {
        reason,
        subType: form.subType,
        occurredAt,
        note: form.note.trim() || null,
      });
      toast(`修订事件 ${r.eventCode} 已创建，原事件 ${reviseFrom.value.eventCode} 已关闭`);
    } else {
      const payload = {
        subType: form.subType,
        orderCode: form.orderCode.trim(),
        productFamily: form.productFamily,
        quantity: parseInt(form.quantity, 10),
        priority: parseInt(form.priority, 10),
        arrivalAt: localInputToIso(form.arrivalAt),
        dueAt: localInputToIso(form.dueAt),
        occurredAt,
        note: form.note.trim() || undefined,
      };
      if (!payload.orderCode || !payload.arrivalAt || !payload.dueAt || !payload.occurredAt) {
        formErr.value = '请完整填写订单号、到达时间、交期与发生时间';
        return;
      }
      r = await Api.newOrderEvent(payload);
      toast(`插单事件 ${r.eventCode} 已登记`);
    }
    let detail = null;
    try { detail = await Api.event(r.eventId); } catch (e) { /* 详情加载失败仅影响明细展示 */ }
    result.value = { data: r, detail };
  } catch (e) {
    submitError.value = e;
  } finally {
    submitting.value = false;
  }
}

watch(() => route.query.reviseFrom, init);
onMounted(init);
</script>

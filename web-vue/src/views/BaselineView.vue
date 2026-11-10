<template>
  <AsyncPage :loading="loading" :error="error" error-title="订单加载失败" loading-text="正在加载订单…">
    <div class="page-header">
      <div><h1>基线排程</h1><p>选择订单、设置求解参数并创建排程任务</p></div>
    </div>
    <AiInsightCard title="AI 排程助手" :actions="aiActions" style="margin-bottom:12px" />
    <div class="baseline-workspace">
      <section class="card table-card baseline-orders">
        <div class="toolbar baseline-toolbar">
          <div class="baseline-heading"><h2>待排订单</h2><span class="muted" aria-live="polite">已选 {{ checkedIds.length }} / {{ orders.length }} 单</span></div>
          <div class="buttons">
            <button class="btn small" :disabled="!orders.length || checkedIds.length === orders.length" @click="checkAll(true)">全选</button>
            <button class="btn small" :disabled="!checkedIds.length" @click="checkAll(false)">清空</button>
          </div>
        </div>
        <div class="table-wrap baseline-table">
          <table class="data-table">
            <thead><tr><th class="checkbox-cell"><span class="sr-only">选择</span></th><th>订单号</th><th>产品族</th><th>数量</th><th>优先级</th><th>交期</th><th>状态</th><th>工序数</th></tr></thead>
            <tbody>
              <tr v-for="o in orders" :key="o.orderId">
                <td class="checkbox-cell"><input type="checkbox" :value="o.orderId" :aria-label="`选择订单 ${o.orderCode}`" v-model="checkedIds"></td>
                <td>{{ o.orderCode }}</td>
                <td>{{ o.productFamily }}</td>
                <td>{{ o.quantity }}</td>
                <td>{{ o.priority }}</td>
                <td>{{ fmtDateTime(o.dueAt) }}</td>
                <td><StatusTag :status="o.status" /></td>
                <td>{{ (o.operations || []).length }}</td>
              </tr>
              <tr v-if="!orders.length"><td colspan="8" class="baseline-no-orders">暂无可选订单</td></tr>
            </tbody>
          </table>
        </div>
      </section>
      <section class="card baseline-settings">
        <form class="section-pad" @submit.prevent="submit">
          <h2>排程参数</h2>
          <div class="form-row baseline-start">
            <label for="baseline-start">仿真起点</label>
            <div><input id="baseline-start" type="datetime-local" class="field" v-model="form.simStart">
              <span class="muted baseline-hint">留空时使用系统默认起点</span></div>
          </div>
          <div class="baseline-group-title">优化目标 <span>权重</span></div>
          <div class="form-row"><label for="baseline-wm">完工时间</label><input id="baseline-wm" type="number" class="field" v-model="form.wm" step="0.1" min="0" required></div>
          <div class="form-row"><label for="baseline-wt">拖期</label><input id="baseline-wt" type="number" class="field" v-model="form.wt" step="0.1" min="0" required></div>
          <div class="form-row"><label for="baseline-wl">负载均衡</label><input id="baseline-wl" type="number" class="field" v-model="form.wl" step="0.1" min="0" required></div>
          <div class="baseline-group-title">求解设置</div>
          <div class="form-row"><label for="baseline-pop">种群规模</label><input id="baseline-pop" type="number" class="field" v-model="form.pop" min="2" step="1" required></div>
          <div class="form-row"><label for="baseline-gen">迭代代数</label><input id="baseline-gen" type="number" class="field" v-model="form.gen" min="1" step="1" required></div>
          <div class="form-row"><label for="baseline-seed">随机种子</label><input id="baseline-seed" type="number" class="field" v-model="form.seed" step="1" required></div>
          <div class="form-row"><label for="baseline-limit">时间上限（秒）</label><input id="baseline-limit" type="number" class="field" v-model="form.limit" min="1" max="600" step="1" required></div>
          <ErrorBox v-if="apiError" :error="apiError" title="创建任务失败" />
          <div v-else-if="errText" class="error-box">{{ errText }}</div>
          <div class="baseline-submit" v-role="['DISPATCHER','ADMIN']">
            <button type="submit" class="btn primary" :disabled="submitting || !checkedIds.length">{{ submitting ? '创建中…' : `创建排程任务（${checkedIds.length} 单）` }}</button>
            <p class="muted">创建后可在调度任务页查看进度</p>
          </div>
        </form>
      </section>
    </div>
  </AsyncPage>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { Api } from '../api';
import { toast } from '../utils/ui';
import { fmtDateTime, localInputToIso } from '../utils/format';
import { useSharedStore } from '../stores/shared';
import StatusTag from '../components/StatusTag.vue';
import ErrorBox from '../components/ErrorBox.vue';
import AiInsightCard from '../components/AiInsightCard.vue';

const router = useRouter();
const shared = useSharedStore();

/* 页内 AI 卡片：一句话发起完整基线流程（建任务→轮询→校验→提交评审，写操作走页内审批） */
const aiActions = [{
  label: 'AI 一键基线排程',
  primary: true,
  prompt: '请执行一次完整的基线排程流程：fjsp_create_baseline 创建任务 → fjsp_task_status 轮询至完成 → 校验 resultStatus 为 FEASIBLE 且 conflicts 为空 → 通过后 fjsp_submit_review 提交评审（先用 fjsp_get_plan 取最新 version）。每步写操作我会逐一人工审批，完成后汇报 KPI（makespan、加权拖期、拖期订单数、负载不均衡度）。',
}];

const orders = ref([]);
const loading = ref(true);
const error = ref(null);
const checkedIds = ref([]);

const form = reactive({ simStart: '', wm: '0.4', wt: '0.4', wl: '0.2', pop: '40', gen: '60', seed: '42', limit: '30' });
const submitting = ref(false);
const errText = ref('');
const apiError = ref(null);

async function load() {
  loading.value = true;
  error.value = null;
  try {
    orders.value = await Api.orders();
    checkedIds.value = orders.value.map(o => o.orderId);
  } catch (e) {
    error.value = e;
  } finally {
    loading.value = false;
  }
}

function checkAll(on) {
  checkedIds.value = on ? orders.value.map(o => o.orderId) : [];
}

async function submit() {
  errText.value = '';
  apiError.value = null;
  if (!checkedIds.value.length) { errText.value = '请至少勾选一个订单'; return; }
  const simStart = localInputToIso(form.simStart);
  const payload = {
    mode: 'BASELINE',
    orderIds: [...checkedIds.value],
    objectiveWeights: {
      makespan: parseFloat(form.wm) || 0,
      weightedTardiness: parseFloat(form.wt) || 0,
      loadImbalance: parseFloat(form.wl) || 0,
    },
    algorithm: {
      populationSize: parseInt(form.pop, 10),
      generations: parseInt(form.gen, 10),
      randomSeed: parseInt(form.seed, 10),
      timeLimitSeconds: parseInt(form.limit, 10),
    },
  };
  if (simStart) payload.simulationStartAt = simStart;
  submitting.value = true;
  try {
    const r = await Api.createTask(payload);
    toast(`任务 ${r.taskCode} 已创建`);
    shared.selectedTaskId = r.taskId;
    router.push({ name: 'tasks' });
  } catch (e) {
    apiError.value = e;
  } finally {
    submitting.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
.baseline-workspace { display:grid; grid-template-columns:minmax(0,1fr) clamp(360px,32%,520px); align-items:start; gap:16px; }
.baseline-orders, .baseline-settings { min-width:0; }
.baseline-toolbar { min-height:66px; }
.baseline-heading { display:flex; align-items:baseline; gap:12px; }
.baseline-heading h2, .baseline-settings h2 { margin:0; font-size:15px; font-weight:650; }
.baseline-table { max-height:clamp(420px,calc(100dvh - 300px),960px); }
.baseline-table .data-table { min-width:660px; }
.baseline-no-orders { height:120px !important; text-align:center; color:var(--muted) !important; }
.baseline-settings .section-pad { padding:16px 22px; }
.baseline-settings h2 { margin-bottom:12px; }
.baseline-settings .form-row { grid-template-columns:110px minmax(0,1fr); margin-bottom:7px; }
.baseline-settings .field { height:32px; }
.baseline-hint { display:block; margin-top:5px; line-height:1.4; }
.baseline-group-title { display:flex; align-items:baseline; gap:8px; margin:12px 0 8px; padding-top:10px; border-top:1px solid var(--line); font-size:13px; font-weight:650; }
.baseline-group-title span { color:var(--muted); font-size:12px; font-weight:400; }
.baseline-submit { margin-top:12px; padding-top:12px; border-top:1px solid var(--line); }
.baseline-submit .btn { width:100%; }
.baseline-submit p { margin:8px 0 0; text-align:center; }
@media (max-width:1380px) {
  .baseline-workspace { grid-template-columns:minmax(0,1fr); }
}
@media (max-width:560px) {
  .baseline-toolbar { align-items:flex-start; flex-wrap:wrap; }
  .baseline-heading { flex-wrap:wrap; }
  .baseline-settings .section-pad { padding:16px; }
  .baseline-settings .form-row { grid-template-columns:minmax(0,1fr); gap:4px; margin-bottom:12px; }
  .baseline-settings .form-row label { text-align:left; }
}
</style>

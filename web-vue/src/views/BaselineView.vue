<template>
  <AsyncPage :loading="loading" :error="error" error-title="订单加载失败" loading-text="正在加载订单…">
    <div class="page-header">
      <div><h1>基线排程</h1><p>选择待排订单并配置算法参数，创建 BASELINE 求解任务</p></div>
    </div>
    <div class="grid-2" style="grid-template-columns:1.5fr 1fr;align-items:start">
      <section class="card table-card">
        <div class="toolbar">
          <div class="filters"><b>待排订单</b><span class="muted">勾选参与本次排程的订单（默认全选）</span></div>
          <div class="buttons">
            <button class="btn small" @click="checkAll(true)">全选</button>
            <button class="btn small" @click="checkAll(false)">清空</button>
          </div>
        </div>
        <div class="table-wrap" style="max-height:560px">
          <table class="data-table">
            <thead><tr><th class="checkbox-cell"></th><th>订单号</th><th>产品族</th><th>数量</th><th>优先级</th><th>交期</th><th>状态</th><th>工序数</th></tr></thead>
            <tbody>
              <tr v-for="o in orders" :key="o.orderId">
                <td class="checkbox-cell"><input type="checkbox" :value="o.orderId" v-model="checkedIds"></td>
                <td>{{ o.orderCode }}</td>
                <td>{{ o.productFamily }}</td>
                <td>{{ o.quantity }}</td>
                <td>{{ o.priority }}</td>
                <td>{{ fmtDateTime(o.dueAt) }}</td>
                <td><StatusTag :status="o.status" /></td>
                <td>{{ (o.operations || []).length }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <section class="card">
        <div class="section-pad">
          <h3 style="margin:0 0 14px;font-size:15px">排程参数</h3>
          <div class="form-row">
            <label>仿真起点</label>
            <input type="datetime-local" class="field" v-model="form.simStart">
            <span class="muted" style="font-size:12px">留空 = 默认（seed 基准，RELATIVE 模式为当前时间）</span>
          </div>
          <div class="form-row"><label>C_max 权重</label><input type="number" class="field" v-model="form.wm" step="0.1" min="0"></div>
          <div class="form-row"><label>拖期权重</label><input type="number" class="field" v-model="form.wt" step="0.1" min="0"></div>
          <div class="form-row"><label>均衡权重</label><input type="number" class="field" v-model="form.wl" step="0.1" min="0"></div>
          <div class="form-row"><label>种群规模</label><input type="number" class="field" v-model="form.pop" min="2"></div>
          <div class="form-row"><label>迭代代数</label><input type="number" class="field" v-model="form.gen" min="1"></div>
          <div class="form-row"><label>随机种子</label><input type="number" class="field" v-model="form.seed"></div>
          <div class="form-row"><label>时间上限(秒)</label><input type="number" class="field" v-model="form.limit" min="1" max="600"></div>
          <ErrorBox v-if="apiError" :error="apiError" title="创建任务失败" />
          <div v-else-if="errText" class="error-box">{{ errText }}</div>
          <button class="btn primary" style="width:100%;height:36px" v-role="['DISPATCHER','ADMIN']"
            :disabled="submitting" @click="submit">{{ submitting ? '创建中…' : '创建基线排程任务' }}</button>
          <p class="muted" style="margin-top:10px">提交后将创建基线排程任务，自动跳转到调度任务页跟踪求解进度。</p>
        </div>
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

const router = useRouter();
const shared = useSharedStore();

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

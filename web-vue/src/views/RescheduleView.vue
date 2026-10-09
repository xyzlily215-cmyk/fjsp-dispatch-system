<template>
  <div v-if="loading" class="loading-block"><div class="spin"></div><div>正在加载计划版本与事件…</div></div>
  <ErrorBox v-else-if="error" :error="error" title="向导数据加载失败" />
  <div v-else>
    <div class="page-header">
      <div><h1>重调度向导</h1>
        <p>基于原计划与事件生成候选重调度方案；已完成、加工中与冻结窗口内工序硬锁定不可变更</p></div>
    </div>
    <section class="card"><div class="section-pad">
      <div style="margin-bottom:16px">
        <span v-for="(s, i) in WIZARD_STEPS" :key="s" class="tag"
          :class="i === wizard.step ? 'blue' : i < wizard.step ? 'green' : 'gray'"
          style="margin-right:4px">{{ i + 1 }}. {{ s }}</span>
      </div>

      <!-- 第 1 步：原计划版本 -->
      <div v-if="wizard.step === 0">
        <template v-if="versions.length">
          <h3 style="margin:0 0 12px;font-size:15px">选择原计划版本</h3>
          <p class="muted" style="margin:0 0 12px">重调度在该版本基础上进行；通常选择当前发布/执行中的版本。</p>
          <select class="field wide" v-model="wizard.planVersionId">
            <option v-for="v in versions" :key="v.id" :value="v.id">
              {{ v.versionCode }} · {{ statusTagInfo(v.status)[1] }}{{ v.candidateType ? ' · ' + statusTagInfo(v.candidateType)[1] : '' }} · {{ fmtDateTime(v.createdAt) }}{{ v.id === currentPlanId ? '（当前发布）' : '' }}
            </option>
          </select>
        </template>
        <div v-else class="empty-screen" style="padding:30px">暂无计划版本，请先创建基线排程。</div>
      </div>

      <!-- 第 2 步：事件 -->
      <div v-else-if="wizard.step === 1">
        <template v-if="events.length">
          <h3 style="margin:0 0 12px;font-size:15px">选择触发事件</h3>
          <p class="muted" style="margin:0 0 12px">展示最近 50 条事件；事件的影响集合在登记时已计算并保存。已关闭事件不可再触发重调度。</p>
          <select class="field wide" v-model="wizard.eventId">
            <option v-for="ev in events" :key="ev.eventId" :value="ev.eventId" :disabled="ev.status === 'CLOSED'">
              {{ ev.eventCode }} · {{ statusTagInfo(ev.subType || ev.eventType)[1] }} · {{ ev.machineId || ev.orderId || '-' }} · {{ fmtDateTime(ev.occurredAt) }} · {{ statusTagInfo(ev.status)[1] }}
            </option>
          </select>
        </template>
        <div v-else class="empty-screen" style="padding:30px">暂无事件，请先在「订单插单 / 设备故障」中登记事件。</div>
      </div>

      <!-- 第 3 步：影响范围预览 -->
      <div v-else-if="wizard.step === 2">
        <h3 style="margin:0 0 12px;font-size:15px">影响范围预览</h3>
        <div class="inline-form" style="margin-bottom:12px">
          <label class="muted">冻结窗口(分钟)</label>
          <input type="number" class="field" min="0" max="1440" style="width:120px"
            :value="wizard.freezeWindowMinutes" placeholder="默认"
            @change="wizard.freezeWindowMinutes = $event.target.value">
          <button class="btn small" @click="reloadPreview">重新预览</button>
        </div>
        <div v-if="previewLoading" class="loading-block"><div class="spin"></div><div>正在计算影响范围…</div></div>
        <ErrorBox v-else-if="previewError" :error="previewError" title="影响范围预览失败" />
        <template v-else-if="wizard.preview">
          <div class="impact-kpis">
            <div class="impact-kpi"><span>硬锁定工序</span><b>{{ wizard.preview.hardLockedCount ?? 0 }}</b></div>
            <div class="impact-kpi"><span>软锁定工序</span><b>{{ wizard.preview.softLockedCount ?? 0 }}</b></div>
            <div class="impact-kpi" :class="{ warn: !!wizard.preview.impactedOperationCount }"><span>影响工序数</span><b>{{ wizard.preview.impactedOperationCount ?? 0 }}</b></div>
            <div class="impact-kpi"><span>受影响订单</span><b>{{ wizard.preview.impactedOrderCount ?? 0 }}</b></div>
            <div class="impact-kpi"><span>局部模式规模</span><b>{{ estimate('LOCAL_RESCHEDULE') ?? '-' }} 道</b></div>
            <div class="impact-kpi"><span>完全模式规模</span><b>{{ estimate('FULL_RESCHEDULE') ?? '-' }} 道</b></div>
          </div>
          <p class="muted" style="margin:10px 0 0">原计划版本 <b>{{ wizard.preview.planVersionCode }}</b> · 冻结窗口 {{ wizard.preview.freezeWindowMinutes }} 分钟{{ previewByTypeText ? ' · 影响类型：' + previewByTypeText : '' }}</p>
          <p v-if="(wizard.preview.impactedOrders || []).length" class="muted" style="margin:6px 0 0">
            受影响订单：{{ wizard.preview.impactedOrders.join('、') }}</p>
          <div v-if="previewImpacts.length" class="table-wrap" style="max-height:240px;margin-top:10px">
            <table class="data-table">
              <thead><tr><th>工序</th><th>影响类型</th><th>锁定</th><th>原因</th></tr></thead>
              <tbody>
                <tr v-for="(i, idx) in previewImpacts.slice(0, 30)" :key="idx">
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
        </template>
      </div>

      <!-- 第 4 步：模式与参数 -->
      <div v-else-if="wizard.step === 3">
        <h3 style="margin:0 0 12px;font-size:15px">选择重调度模式</h3>
        <label v-for="c in modeCards" :key="c.value"
          :style="`display:block;border:1px solid ${wizard.mode === c.value ? '#409eff' : '#dcdfe6'};border-radius:4px;padding:12px 14px;margin-bottom:10px;cursor:pointer`">
          <input type="radio" name="wzMode" :value="c.value" v-model="wizard.mode">
          <b style="margin-left:6px">{{ c.title }}</b>
          <p class="muted" style="margin:6px 0 0">{{ c.desc }}</p>
        </label>
        <h3 style="margin:16px 0 12px;font-size:15px">求解参数</h3>
        <div class="form-row">
          <label>时间上限(秒)</label>
          <input type="number" class="field" min="1" max="600" :value="wizard.timeLimitSeconds"
            @change="wizard.timeLimitSeconds = parseInt($event.target.value, 10) || 30">
        </div>
        <div v-for="w in weightFields" :key="w.k" class="form-row">
          <label>{{ w.label }}</label>
          <input type="number" class="field" step="0.1" min="0" :value="wizard.weights[w.k]"
            @change="wizard.weights[w.k] = parseFloat($event.target.value) || 0">
        </div>
      </div>

      <!-- 第 5 步：确认提交 -->
      <div v-else>
        <h3 style="margin:0 0 12px;font-size:15px">确认并创建任务</h3>
        <dl class="detail-list">
          <dt>原计划版本</dt>
          <dd>{{ selectedVersion ? `${selectedVersion.versionCode}（${selectedVersion.status}）` : '-' }}</dd>
          <dt>关联事件</dt>
          <dd>{{ selectedEvent ? `${selectedEvent.eventCode} · ${selectedEvent.machineId || selectedEvent.orderId || ''}` : '-' }}</dd>
          <dt>重调度模式</dt><dd>{{ modeText }}</dd>
          <dt>冻结窗口</dt>
          <dd>{{ wizard.freezeWindowMinutes === '' ? '默认（系统配置）' : wizard.freezeWindowMinutes + ' 分钟' }}</dd>
          <dt>时间上限</dt><dd>{{ wizard.timeLimitSeconds }} 秒</dd>
          <template v-if="wizard.preview">
            <dt>预计求解规模</dt>
            <dd>局部 {{ estimate('LOCAL_RESCHEDULE') ?? '-' }} 道 / 完全 {{ estimate('FULL_RESCHEDULE') ?? '-' }} 道工序</dd>
          </template>
        </dl>
        <p class="muted" style="margin:10px 0">提交后将创建重调度任务，自动跳转调度任务页跟踪求解进度；求解成功后可在「方案对比」并列查看局部与完全方案。</p>
        <ErrorBox v-if="submitError" :error="submitError" :title="submitErrTitle" />
        <button class="btn primary" v-role="['DISPATCHER', 'ADMIN']" style="height:36px"
          :disabled="submitting" @click="submit">
          {{ submitting ? '创建中…' : '创建重调度任务' }}
        </button>
      </div>

      <div class="buttons" style="margin-top:18px">
        <button class="btn" :disabled="wizard.step === 0" @click="prev">&larr; 上一步</button>
        <button v-show="wizard.step < WIZARD_STEPS.length - 1" class="btn primary" @click="next">下一步 &rarr;</button>
      </div>
    </div></section>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Api } from '../api';
import { toast } from '../utils/ui';
import { fmtDateTime, statusTagInfo, impactText, reasonText } from '../utils/format';
import { useSharedStore } from '../stores/shared';
import ErrorBox from '../components/ErrorBox.vue';

const WIZARD_STEPS = ['选择原计划', '选择事件', '影响范围预览', '模式与参数', '确认提交'];

/* 模块级向导状态：跨页面访问保留步骤/模式/参数（对齐旧版 pages-events.js 的 Wizard 单例） */
const wizard = reactive({
  step: 0,
  planVersionId: null,
  eventId: null,
  preview: null,
  previewDetail: null,
  previewKey: '',
  mode: 'BOTH',
  freezeWindowMinutes: '',
  timeLimitSeconds: 30,
  weights: { weightedTardiness: 0.4, makespan: 0.3, deltaPlan: 0.2, machineChange: 0.1 },
});

const route = useRoute();
const router = useRouter();
const shared = useSharedStore();

const versions = ref([]);
const events = ref([]);
const loading = ref(true);
const error = ref(null);
const previewLoading = ref(false);
const previewError = ref(null);
const submitting = ref(false);
const submitError = ref(null);
const submitErrTitle = ref('创建重调度任务失败');

const weightFields = [
  { k: 'weightedTardiness', label: '拖期权重' },
  { k: 'makespan', label: 'C_max 权重' },
  { k: 'deltaPlan', label: '扰动权重' },
  { k: 'machineChange', label: '换机权重' },
];

const currentPlanId = computed(() =>
  shared.dashboard && shared.dashboard.currentPlan ? shared.dashboard.currentPlan.id : null);
const selectedVersion = computed(() => versions.value.find(v => v.id === wizard.planVersionId));
const selectedEvent = computed(() => events.value.find(e => e.eventId === wizard.eventId));

const modeCards = computed(() => [
  {
    value: 'LOCAL_RESCHEDULE', title: '局部重调度（LOCAL）',
    desc: `仅调整影响集合内尚未开始的工序，尽量保持其他原计划不变。预计求解规模 ${estimate('LOCAL_RESCHEDULE') ?? '-'} 道工序。`,
  },
  {
    value: 'FULL_RESCHEDULE', title: '完全重调度（FULL）',
    desc: `调整事件发生后所有未完成且不在冻结窗口内的工序。预计求解规模 ${estimate('FULL_RESCHEDULE') ?? '-'} 道工序。`,
  },
  {
    value: 'BOTH', title: '两种都算（局部 + 完全）',
    desc: '一次提交两个任务，生成同一候选组的 LOCAL 与 FULL 两个草稿方案，便于在「方案对比」中并列比较拖期、总工期、设备变更数与计划扰动。',
  },
]);

const modeText = computed(() =>
  wizard.mode === 'BOTH' ? '局部 + 完全（两个任务，同一候选组）'
    : wizard.mode === 'LOCAL_RESCHEDULE' ? '局部重调度（LOCAL）' : '完全重调度（FULL）');

const previewImpacts = computed(() =>
  (wizard.previewDetail && wizard.previewDetail.impacts) || []);
const previewByTypeText = computed(() => {
  const byType = (wizard.preview && wizard.preview.impactSummary && wizard.preview.impactSummary.byType) || {};
  return Object.entries(byType).map(([k, v]) => `${impactText(k)} × ${v}`).join('，');
});

function estimate(mode) {
  const m = wizard.preview && wizard.preview.modeEstimates && wizard.preview.modeEstimates[mode];
  return m ? m.estimatedOperationCount : null;
}

async function loadPreview() {
  const key = `${wizard.planVersionId}|${wizard.eventId}|${wizard.freezeWindowMinutes}`;
  if (wizard.preview && wizard.previewKey === key) return;
  previewLoading.value = true;
  previewError.value = null;
  try {
    const [p, detail] = await Promise.all([
      Api.reschedulePreview(wizard.eventId, {
        planVersionId: wizard.planVersionId,
        freezeWindowMinutes: wizard.freezeWindowMinutes === '' ? undefined : wizard.freezeWindowMinutes,
      }),
      Api.event(wizard.eventId),
    ]);
    wizard.preview = p;
    wizard.previewDetail = detail;
    wizard.previewKey = key;
  } catch (e) {
    wizard.preview = null;
    wizard.previewKey = '';
    previewError.value = e;
  } finally {
    previewLoading.value = false;
  }
}

function reloadPreview() {
  wizard.previewKey = '';
  loadPreview();
}

function onStepEnter() {
  submitError.value = null;
  if (wizard.step === 2) loadPreview();
}

function prev() {
  if (wizard.step > 0) { wizard.step--; onStepEnter(); }
}

function next() {
  if (wizard.step === 0 && !wizard.planVersionId) { toast('请先选择原计划版本', 'error'); return; }
  if (wizard.step === 1 && !wizard.eventId) { toast('请先选择事件', 'error'); return; }
  if (wizard.step === 2 && !wizard.preview) { toast('影响范围预览尚未加载完成', 'error'); return; }
  if (wizard.step < WIZARD_STEPS.length - 1) { wizard.step++; onStepEnter(); }
}

async function submit() {
  submitError.value = null;
  submitErrTitle.value = '创建重调度任务失败';
  const modes = wizard.mode === 'BOTH' ? ['LOCAL_RESCHEDULE', 'FULL_RESCHEDULE'] : [wizard.mode];
  submitting.value = true;
  const created = [];
  try {
    for (const mode of modes) {
      const payload = {
        mode,
        oldPlanVersionId: wizard.planVersionId,
        eventId: wizard.eventId,
        objectiveWeights: { ...wizard.weights },
        algorithm: { timeLimitSeconds: wizard.timeLimitSeconds },
      };
      if (wizard.freezeWindowMinutes !== '') {
        payload.freezeWindowMinutes = parseInt(wizard.freezeWindowMinutes, 10);
      }
      created.push(await Api.createTask(payload));
    }
    toast(`已创建重调度任务 ${created.map(c => c.taskCode).join('、')}`
      + (modes.length > 1 ? '（同一候选组，可在方案对比中并列查看）' : ''));
    shared.selectedTaskId = created[0].taskId;
    wizard.step = 0;
    router.push({ name: 'tasks' });
  } catch (e) {
    submitError.value = e;
    submitErrTitle.value = created.length
      ? `任务 ${created.map(c => c.taskCode).join('、')} 已创建，其余创建失败`
      : '创建重调度任务失败';
  } finally {
    submitting.value = false;
  }
}

async function init() {
  loading.value = true; error.value = null;
  try {
    const [vs, ep] = await Promise.all([Api.planVersions(), Api.eventsPage({ size: 50 })]);
    versions.value = vs;
    events.value = ep.items;
  } catch (e) {
    error.value = e;
    loading.value = false;
    return;
  }
  loading.value = false;

  if (route.query.eventId) wizard.eventId = route.query.eventId;
  if (!versions.value.some(v => v.id === wizard.planVersionId)) {
    const cur = shared.dashboard && shared.dashboard.currentPlan;
    wizard.planVersionId = cur && versions.value.some(v => v.id === cur.id) ? cur.id
      : ((versions.value.find(v => v.status === 'PUBLISHED' || v.status === 'EXECUTING') || versions.value[0] || {}).id || null);
  }
  const selectableEvents = events.value.filter(e => e.status !== 'CLOSED');
  if (!selectableEvents.some(e => e.eventId === wizard.eventId)) {
    wizard.eventId = (selectableEvents[0] || {}).eventId || null;
  }
  wizard.preview = null;
  wizard.previewDetail = null;
  wizard.previewKey = '';
  if (wizard.step < 0 || wizard.step >= WIZARD_STEPS.length) wizard.step = 0;
  if (wizard.step === 2) loadPreview();
}

onMounted(init);
</script>

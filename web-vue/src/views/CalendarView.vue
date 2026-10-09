<template>
  <div v-if="loading" class="loading-block"><div class="spin"></div><div>正在加载设备日历…</div></div>
  <ErrorBox v-else-if="error" :error="error" title="加载失败" />
  <div v-else>
    <div class="page-header">
      <div><h1>设备日历</h1><p>{{ withCal.length ? '班次（WORK）定义可用时间；不可用区间从可用时间中扣除；任何变更生成新版本，历史版本不改写' : '设备日历与不可用区间维护' }}</p></div>
      <div v-if="withCal.length" class="buttons">
        <button class="btn" @click="load">&#8635; 刷新</button>
        <button class="btn" @click="openVersions">版本历史</button>
        <button class="btn primary" v-role="['ADMIN']" @click="openAdd">+ 新增区间</button>
      </div>
    </div>
    <section v-if="!withCal.length" class="card">
      <div class="empty-screen"><h3>暂无绑定日历的设备</h3></div>
    </section>
    <section v-else class="card section-card">
      <div class="toolbar"><div class="filters">
        <span class="filter-label">设备 / 日历</span>
        <select class="field wide" v-model="selectedId" @change="onMachineChange">
          <option v-for="m in withCal" :key="m.machineId" :value="m.machineId">
            {{ m.machineId }} · {{ m.machineName || m.workCenterId }}（{{ m.calendarId }}）
          </option>
        </select>
        <span v-if="current" style="margin-left:10px">当前版本 <span class="tag green">{{ current.calendarCode }} v{{ current.calendarVersion }}</span></span>
      </div></div>
      <div v-if="calLoading" class="loading-block"><div class="spin"></div><div>正在加载日历区间…</div></div>
      <ErrorBox v-else-if="calError" :error="calError" title="日历区间加载失败" />
      <div v-else class="table-wrap">
        <table class="data-table">
          <thead><tr><th>类型</th><th>开始时间</th><th>结束时间</th><th>时长</th><th>备注</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="i in intervals" :key="i.intervalId">
              <td><span class="interval-type" :class="i.intervalType">{{ typeText(i.intervalType) }}</span></td>
              <td>{{ fmtDateTime(i.startAt) }}</td>
              <td>{{ fmtDateTime(i.endAt) }}</td>
              <td>{{ Math.round((Date.parse(i.endAt) - Date.parse(i.startAt)) / 60000) }} 分钟</td>
              <td><span class="muted">{{ i.note || '-' }}</span></td>
              <td class="table-actions"><a v-role="['ADMIN']" style="color:#d54941" @click="delInterval(i)">删除</a></td>
            </tr>
            <tr v-if="!intervals.length"><td colspan="6" style="text-align:center;color:#909399">暂无区间</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <el-dialog v-model="verDlg.visible" :title="`日历版本历史（${current ? current.calendarCode : (machine && machine.calendarId)}）`" width="860px">
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>版本</th><th>状态</th><th>变更说明</th><th>生成时间</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="v in versions" :key="v.calendarId">
              <td><b>v{{ v.calendarVersion }}</b> <span v-if="v.current" class="tag green">当前</span></td>
              <td><StatusTag :status="v.status" /></td>
              <td>{{ v.changeNote || '初始版本' }}</td>
              <td>{{ fmtDateTime(v.createdAt) }}</td>
              <td class="table-actions"><a @click="viewVersion(v)">查看区间</a></td>
            </tr>
            <tr v-if="!versions.length"><td colspan="5" style="text-align:center;color:#909399">暂无版本</td></tr>
          </tbody>
        </table>
      </div>
      <div style="margin-top:10px">
        <div v-if="verDlg.loading" class="loading-block"><div class="spin"></div><div>正在加载 v{{ verDlg.verNo }} 区间…</div></div>
        <ErrorBox v-else-if="verDlg.error" :error="verDlg.error" title="版本区间加载失败" />
        <template v-else-if="verDlg.verNo !== null">
          <h3 style="margin:0 0 8px;font-size:14px">v{{ verDlg.verNo }} 区间（只读）</h3>
          <div class="table-wrap">
            <table class="data-table">
              <thead><tr><th>类型</th><th>开始时间</th><th>结束时间</th><th>备注</th></tr></thead>
              <tbody>
                <tr v-for="i in verDlg.list" :key="i.intervalId">
                  <td><span class="interval-type" :class="i.intervalType">{{ typeText(i.intervalType) }}</span></td>
                  <td>{{ fmtDateTime(i.startAt) }}</td>
                  <td>{{ fmtDateTime(i.endAt) }}</td>
                  <td><span class="muted">{{ i.note || '-' }}</span></td>
                </tr>
                <tr v-if="!verDlg.list.length"><td colspan="4" style="text-align:center;color:#909399">暂无区间</td></tr>
              </tbody>
            </table>
          </div>
        </template>
      </div>
      <p class="hint">历史版本区间只读、不改写；已生成任务的输入快照内联了当时的区间，新排程任务只使用当前版本。</p>
      <template #footer>
        <button class="btn" @click="verDlg.visible = false">关闭</button>
      </template>
    </el-dialog>

    <el-dialog v-model="addDlg.visible" :title="`新增日历区间（${current ? current.calendarCode + ' v' + current.calendarVersion : (machine && machine.calendarId)}）`" width="600px">
      <div class="form-grid">
        <label class="required">类型</label>
        <select class="field" v-model="addDlg.form.intervalType">
          <option value="BREAK">休息（BREAK）</option>
          <option value="HOLIDAY">节假日（HOLIDAY）</option>
          <option value="REPAIR">维修（REPAIR）</option>
          <option value="WORK">班次可用（WORK，班次调整）</option>
        </select>
        <label class="required">开始时间</label>
        <input type="datetime-local" class="field" v-model="addDlg.form.start">
        <label class="required">结束时间</label>
        <input type="datetime-local" class="field" v-model="addDlg.form.end">
        <label>备注</label>
        <textarea class="field" v-model="addDlg.form.note" placeholder="可选"></textarea>
      </div>
      <p class="hint">不可用区间不可与已有不可用区间重叠；维修区间不得覆盖已完成的执行记录；结束时间必须晚于开始时间。保存后生成新日历版本，只对之后创建的排程任务生效。</p>
      <div v-if="addDlg.err" class="error-box" style="margin-top:10px">{{ addDlg.err }}</div>
      <template #footer>
        <button class="btn" @click="addDlg.visible = false">取消</button>
        <button class="btn primary" :disabled="addDlg.busy" @click="saveInterval">保存</button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessageBox } from 'element-plus';
import { Api } from '../api';
import { toast, toastErr } from '../utils/ui';
import { fmtDateTime, isoToLocalInput, localInputToIso, errMsg } from '../utils/format';
import { useSharedStore } from '../stores/shared';
import StatusTag from '../components/StatusTag.vue';
import ErrorBox from '../components/ErrorBox.vue';

const TYPE_TEXT = { WORK: '班次可用', BREAK: '休息', HOLIDAY: '节假日', REPAIR: '维修' };
const typeText = (t) => TYPE_TEXT[t] || t;

const shared = useSharedStore();
let preselect = shared.calendarMachineId;
shared.calendarMachineId = null;

const machines = ref([]);
const loading = ref(true);
const error = ref(null);
const selectedId = ref('');
const intervals = ref([]);
const versions = ref([]);
const calLoading = ref(false);
const calError = ref(null);

const withCal = computed(() => machines.value.filter(m => m.calendarId));
const machine = computed(() => withCal.value.find(m => m.machineId === selectedId.value) || null);
const current = computed(() => (versions.value || []).find(v => v.current) || null);

async function load() {
  loading.value = true; error.value = null;
  try {
    machines.value = await Api.machines();
    const list = withCal.value;
    if (list.length) {
      let sel = null;
      if (preselect && list.some(m => m.machineId === preselect)) sel = preselect;
      else if (list.some(m => m.machineId === selectedId.value)) sel = selectedId.value;
      else sel = list[0].machineId;
      preselect = null;
      selectedId.value = sel;
      await loadCal();
    }
  } catch (e) {
    error.value = e;
  } finally {
    loading.value = false;
  }
}

/* 手动切换设备时回写 shared，再次进入页面保持选择（对齐旧版 Shared.calendarMachineId 语义） */
function onMachineChange() {
  shared.calendarMachineId = selectedId.value;
  loadCal();
}

async function loadCal() {
  if (!machine.value) return;
  calLoading.value = true; calError.value = null;
  try {
    [intervals.value, versions.value] = await Promise.all([
      Api.calendarIntervals(machine.value.calendarId),
      Api.calendarVersions(machine.value.calendarId),
    ]);
  } catch (e) {
    calError.value = e;
  } finally {
    calLoading.value = false;
  }
}

const verDlg = reactive({ visible: false, loading: false, error: null, verNo: null, list: [] });

function openVersions() {
  verDlg.visible = true;
  verDlg.loading = false; verDlg.error = null; verDlg.verNo = null; verDlg.list = [];
}

async function viewVersion(v) {
  verDlg.loading = true; verDlg.error = null; verDlg.verNo = v.calendarVersion; verDlg.list = [];
  try {
    verDlg.list = await Api.calendarIntervals(v.calendarId);
  } catch (e) {
    verDlg.error = e;
  } finally {
    verDlg.loading = false;
  }
}

const addDlg = reactive({
  visible: false, busy: false, err: '',
  form: { intervalType: 'BREAK', start: '', end: '', note: '' },
});

function openAdd() {
  addDlg.err = '';
  addDlg.form = {
    intervalType: 'BREAK',
    start: isoToLocalInput(new Date(Date.now() + 24 * 3600e3).toISOString()),
    end: isoToLocalInput(new Date(Date.now() + 25 * 3600e3).toISOString()),
    note: '',
  };
  addDlg.visible = true;
}

async function saveInterval() {
  addDlg.err = '';
  const startAt = localInputToIso(addDlg.form.start);
  const endAt = localInputToIso(addDlg.form.end);
  if (!startAt || !endAt) { addDlg.err = '请填写完整的起止时间'; return; }
  if (Date.parse(endAt) <= Date.parse(startAt)) { addDlg.err = '结束时间必须晚于开始时间'; return; }
  addDlg.busy = true;
  try {
    const r = await Api.addCalendarInterval(machine.value.calendarId, {
      intervalType: addDlg.form.intervalType,
      startAt, endAt,
      note: addDlg.form.note.trim() || undefined,
    });
    toast(`区间已保存，日历生成新版本 v${r.calendarVersion}，仅对后续新任务生效`);
    addDlg.visible = false;
    loadCal();
  } catch (e) {
    addDlg.err = errMsg(e);
  } finally {
    addDlg.busy = false;
  }
}

async function delInterval(iv) {
  try {
    await ElMessageBox.confirm(
      `确定删除该${typeText(iv.intervalType)}区间（${fmtDateTime(iv.startAt)} ~ ${fmtDateTime(iv.endAt)}）？\n删除将生成新日历版本，历史版本保留可查。`,
      '删除区间', { type: 'warning' });
  } catch { return; }
  try {
    const r = await Api.deleteCalendarInterval(machine.value.calendarId, iv.intervalId);
    toast(`区间已删除，日历生成新版本 v${r.calendarVersion}`);
    loadCal();
  } catch (e) { toastErr(e, '删除失败'); }
}

onMounted(load);
</script>

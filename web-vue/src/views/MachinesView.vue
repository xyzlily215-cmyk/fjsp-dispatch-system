<template>
  <AsyncPage :loading="loading" :error="error" error-title="设备加载失败" loading-text="正在加载设备…">
    <div class="page-header">
      <div><h1>设备管理</h1><p>车间设备清单与能力（新增 / 编辑 / 启停，停用后不进入新任务候选集）</p></div>
      <div class="buttons">
        <button class="btn" @click="load">&#8635; 刷新</button>
        <button class="btn primary" v-role="['ADMIN']" @click="openEdit(null)">+ 新增设备</button>
      </div>
    </div>
    <section class="card table-card">
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>设备号</th><th>名称</th><th>工作中心</th><th>日历</th><th>可加工产品族</th><th>备注</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="m in machines" :key="m.machineId">
              <td class="machine-name">{{ m.machineId }}</td>
              <td>{{ m.machineName || '-' }}</td>
              <td>{{ m.workCenterId }}</td>
              <td>{{ m.calendarId || '-' }}</td>
              <td><span v-for="f in m.productFamilies || []" :key="f" class="ability">{{ f }}</span></td>
              <td><span class="muted">{{ m.remark || '-' }}</span></td>
              <td><StatusTag :status="m.status" /></td>
              <td class="table-actions">
                <a @click="openEdit(m)">编辑</a>
                <a v-if="m.status === 'ACTIVE'" style="color:#e6a23c" @click="toggleStatus(m, true)">停用</a>
                <a v-else style="color:#67c23a" @click="toggleStatus(m, false)">启用</a>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <el-dialog v-model="dlg.visible" :title="dlg.editing ? '编辑设备 ' + dlg.editing.machineId : '新增设备'" width="600px">
      <div class="form-grid">
        <label class="required">设备编码</label>
        <input class="field" v-model="dlg.form.machineCode" placeholder="如 M-09">
        <label>设备名称</label>
        <input class="field" v-model="dlg.form.machineName" placeholder="如 车削中心 3 号机">
        <label class="required">工作中心</label>
        <input class="field" v-model="dlg.form.workCenterId" placeholder="如 WC-车削" list="mfWcList">
        <datalist id="mfWcList"><option v-for="w in workCenters" :key="w" :value="w" /></datalist>
        <label>绑定日历</label>
        <select class="field" v-model="dlg.form.calendarId">
          <option value="">（不绑定）</option>
          <option v-for="c in calendarIds" :key="c" :value="c">{{ c }}</option>
        </select>
        <label class="required">能力产品族</label>
        <div class="check-group">
          <label v-for="f in families" :key="f">
            <input type="checkbox" :value="f" v-model="dlg.form.productFamilies">{{ f }}</label>
          <input class="field" v-model="dlg.form.famCustom" placeholder="自定义族，逗号分隔" style="width:170px">
        </div>
        <label>备注</label>
        <textarea class="field" v-model="dlg.form.remark"></textarea>
      </div>
      <div v-if="dlg.err" class="error-box" style="margin-top:10px">{{ dlg.err }}</div>
      <template #footer>
        <button class="btn" @click="dlg.visible = false">取消</button>
        <button class="btn primary" :disabled="dlg.busy" @click="save">{{ dlg.editing ? '保存' : '创建' }}</button>
      </template>
    </el-dialog>
  </AsyncPage>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { Api } from '../api';
import { toast, toastErr } from '../utils/ui';
import { errMsg } from '../utils/format';
import StatusTag from '../components/StatusTag.vue';
import ErrorBox from '../components/ErrorBox.vue';

const machines = ref([]);
const templates = ref([]);
const loading = ref(true);
const error = ref(null);

const families = computed(() => {
  const set = new Set();
  templates.value.forEach(t => t.productFamily && set.add(t.productFamily));
  machines.value.forEach(m => (m.productFamilies || []).forEach(f => set.add(f)));
  return [...set];
});
const calendarIds = computed(() => [...new Set(machines.value.map(m => m.calendarId).filter(Boolean))]);
const workCenters = computed(() => [...new Set(machines.value.map(m => m.workCenterId).filter(Boolean))]);

const dlg = reactive({
  visible: false, editing: null, busy: false, err: '',
  form: { machineCode: '', machineName: '', workCenterId: '', calendarId: '', productFamilies: [], famCustom: '', remark: '' },
});

async function load() {
  loading.value = true; error.value = null;
  try {
    [machines.value, templates.value] = await Promise.all([Api.machines(), Api.templates()]);
  } catch (e) {
    error.value = e;
  } finally {
    loading.value = false;
  }
}

function openEdit(m) {
  dlg.editing = m;
  dlg.err = '';
  dlg.form = {
    machineCode: m ? m.machineCode : '',
    machineName: m ? m.machineName || '' : '',
    workCenterId: m ? m.workCenterId : '',
    calendarId: m ? m.calendarId || '' : '',
    productFamilies: m ? [...(m.productFamilies || [])] : [],
    famCustom: '',
    remark: m ? m.remark || '' : '',
  };
  dlg.visible = true;
}

async function save() {
  dlg.err = '';
  const f = dlg.form;
  const custom = f.famCustom.split(/[,，]/).map(s => s.trim()).filter(Boolean);
  const productFamilies = [...new Set([...f.productFamilies, ...custom])];
  if (!f.machineCode.trim()) { dlg.err = '请填写设备编码'; return; }
  if (!f.workCenterId.trim()) { dlg.err = '请填写工作中心'; return; }
  if (!productFamilies.length) { dlg.err = '请至少选择一个能力产品族'; return; }
  const payload = {
    machineCode: f.machineCode.trim(),
    machineName: f.machineName.trim() || null,
    workCenterId: f.workCenterId.trim(),
    calendarId: f.calendarId || null,
    productFamilies,
    remark: f.remark.trim() || null,
  };
  dlg.busy = true;
  try {
    if (dlg.editing) {
      await Api.updateMachine(dlg.editing.machineId, payload);
      toast('设备 ' + dlg.editing.machineId + ' 已更新');
    } else {
      await Api.createMachine(payload);
      toast('设备 ' + payload.machineCode + ' 已创建');
    }
    dlg.visible = false;
    load();
  } catch (e) {
    dlg.err = errMsg(e);
  } finally {
    dlg.busy = false;
  }
}

async function toggleStatus(m, toInactive) {
  if (toInactive) {
    try {
      await ElMessageBox.confirm(`确定停用设备 ${m.machineId}？停用后不再进入新任务的候选设备集。`, '停用设备', { type: 'warning' });
    } catch { return; }
  }
  try {
    await Api.setMachineStatus(m.machineId, toInactive ? 'INACTIVE' : 'ACTIVE');
    toast(`设备 ${m.machineId} 已${toInactive ? '停用' : '启用'}`);
    load();
  } catch (e) { toastErr(e, '操作失败'); }
}

onMounted(load);
</script>

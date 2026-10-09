<template>
  <div v-if="loading" class="loading-block"><div class="spin"></div><div>正在加载工艺模板…</div></div>
  <ErrorBox v-else-if="error" :error="error" title="工艺模板加载失败" />
  <div v-else>
    <div class="page-header">
      <div><h1>工艺模板</h1><p>产品族工艺路线与候选设备；启用前校验工序完整性</p></div>
      <div class="buttons">
        <button class="btn" @click="load">&#8635; 刷新</button>
        <button class="btn primary" v-role="['ADMIN']" @click="openAdd">+ 新建模板</button>
      </div>
    </div>
    <section v-for="t in templates" :key="t.templateId" class="card table-card section-card">
      <div class="card-title">
        <span>{{ t.templateCode }} · {{ t.productFamily }} · v{{ t.templateVersion }} <StatusTag :status="t.status" /></span>
        <span class="buttons">
          <a class="link" @click="copyTpl(t)">复制新版本</a>
          <a v-if="t.status === 'ACTIVE'" class="link" style="color:#e6a23c" @click="setStatus(t, 'INACTIVE')">停用</a>
          <a v-else class="link" style="color:#67c23a" @click="setStatus(t, 'ACTIVE')">启用</a>
        </span>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>序号</th><th>工序编码</th><th>候选设备（设备 / 准备 / 加工 分钟）</th></tr></thead>
          <tbody>
            <tr v-for="o in t.operations || []" :key="o.sequenceNo + '-' + o.operationCode">
              <td>{{ o.sequenceNo }}</td>
              <td>{{ o.operationCode }}</td>
              <td>
                <span v-for="c in o.defaultCandidates || []" :key="c.machineId" class="machine-chip">
                  {{ c.machineId }} · {{ c.setupMinutes }}/{{ c.processMinutes }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <el-dialog v-model="dlg.visible" title="新建工艺模板" width="860px">
      <div class="form-grid" style="grid-template-columns:100px 1fr">
        <label class="required">模板编码</label>
        <input class="field" v-model="dlg.code" placeholder="如 TPL-齿轮D">
        <label class="required">产品族</label>
        <input class="field" v-model="dlg.family" placeholder="如 齿轮D" list="tfFamList">
        <datalist id="tfFamList"><option v-for="f in families" :key="f" :value="f" /></datalist>
        <label class="required">工序列表</label>
        <div>
          <div class="op-rows">
            <div v-for="(op, oi) in dlg.ops" :key="oi" class="op-row">
              <input type="number" class="field op-seq" min="1" step="10" placeholder="序号" v-model="op.sequenceNo">
              <input class="field op-code" placeholder="工序名称/编码，如 OP-10 车削" v-model="op.operationCode">
              <div class="cand-rows" @dblclick="addCand(op)">
                <div v-for="(c, ci) in op.candidates" :key="ci" class="cand-row">
                  <select class="field cand-machine" v-model="c.machineId">
                    <option v-for="id in machineIds" :key="id" :value="id">{{ id }}</option>
                  </select>
                  <input type="number" class="field cand-setup" min="1" placeholder="准备min" v-model="c.setupMinutes">
                  <input type="number" class="field cand-process" min="1" placeholder="加工min" v-model="c.processMinutes">
                  <button class="icon-btn cand-del" title="删除候选" @click="delCand(op, ci)">×</button>
                </div>
              </div>
              <button class="icon-btn op-del" title="删除工序" @click="delOp(oi)">×</button>
            </div>
          </div>
          <div class="buttons" style="margin-top:8px">
            <button class="btn small" v-role="['ADMIN']" @click="addOp">+ 添加工序</button>
            <span class="muted">每道工序至少一个候选设备，准备/加工时长均需 &gt; 0（双击候选区可追加候选设备）</span>
          </div>
        </div>
      </div>
      <div v-if="dlg.err" class="error-box" style="margin-top:10px">{{ dlg.err }}</div>
      <template #footer>
        <button class="btn" @click="dlg.visible = false">取消</button>
        <button class="btn primary" :disabled="dlg.busy" @click="save">创建并启用</button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { Api } from '../api';
import { toast, toastErr } from '../utils/ui';
import { errMsg } from '../utils/format';
import StatusTag from '../components/StatusTag.vue';
import ErrorBox from '../components/ErrorBox.vue';

const templates = ref([]);
const machines = ref([]);
const loading = ref(true);
const error = ref(null);

const machineIds = computed(() => machines.value.map(m => m.machineId));
const families = computed(() => {
  const set = new Set();
  templates.value.forEach(t => t.productFamily && set.add(t.productFamily));
  machines.value.forEach(m => (m.productFamilies || []).forEach(f => set.add(f)));
  return [...set];
});

async function load() {
  loading.value = true; error.value = null;
  try {
    [templates.value, machines.value] = await Promise.all([Api.templates(), Api.machines()]);
  } catch (e) {
    error.value = e;
  } finally {
    loading.value = false;
  }
}

const dlg = reactive({ visible: false, busy: false, err: '', code: '', family: '', ops: [] });

function newCand() {
  return { machineId: machineIds.value[0] || '', setupMinutes: 5, processMinutes: 30 };
}
function newOp(seq) {
  return { sequenceNo: seq, operationCode: '', candidates: [newCand()] };
}

function openAdd() {
  dlg.err = ''; dlg.code = ''; dlg.family = '';
  dlg.ops = [newOp(10)];
  dlg.visible = true;
}

function addOp() {
  const seqs = dlg.ops.map(o => parseInt(o.sequenceNo, 10) || 0);
  dlg.ops.push(newOp((Math.max(...seqs, 0) || 0) + 10));
}

function delOp(oi) {
  if (dlg.ops.length <= 1) { dlg.err = '至少保留一道工序'; return; }
  dlg.ops.splice(oi, 1);
}

function addCand(op) {
  op.candidates.push(newCand());
}

function delCand(op, ci) {
  if (op.candidates.length <= 1) { dlg.err = '每道工序至少保留一个候选设备'; return; }
  op.candidates.splice(ci, 1);
}

async function save() {
  dlg.err = '';
  const templateCode = dlg.code.trim();
  const productFamily = dlg.family.trim();
  if (!templateCode || !productFamily) { dlg.err = '请填写模板编码与产品族'; return; }
  const operations = [];
  for (const row of dlg.ops) {
    const sequenceNo = parseInt(row.sequenceNo, 10);
    const operationCode = (row.operationCode || '').trim();
    if (!sequenceNo || !operationCode) { dlg.err = '每道工序需填写序号与名称'; return; }
    const defaultCandidates = [];
    for (const cr of row.candidates) {
      const setupMinutes = parseInt(cr.setupMinutes, 10);
      const processMinutes = parseInt(cr.processMinutes, 10);
      if (!setupMinutes || !processMinutes || setupMinutes <= 0 || processMinutes <= 0) {
        dlg.err = `工序 ${operationCode} 的准备/加工时长必须为正整数`; return;
      }
      defaultCandidates.push({ machineId: cr.machineId, setupMinutes, processMinutes });
    }
    if (!defaultCandidates.length) { dlg.err = `工序 ${operationCode} 至少需要一个候选设备`; return; }
    operations.push({ sequenceNo, operationCode, defaultCandidates });
  }
  if (!operations.length) { dlg.err = '至少添加一道工序'; return; }
  const seqs = operations.map(o => o.sequenceNo).sort((a, b) => a - b);
  for (let i = 1; i < seqs.length; i++) {
    if (seqs[i] === seqs[i - 1]) { dlg.err = '工序序号不能重复'; return; }
  }
  dlg.busy = true;
  try {
    await Api.createTemplate({ templateCode, productFamily, operations });
    toast('模板 ' + templateCode + ' 已创建并启用');
    dlg.visible = false;
    load();
  } catch (e) {
    dlg.err = errMsg(e);
  } finally {
    dlg.busy = false;
  }
}

async function copyTpl(t) {
  try {
    const r = await Api.copyTemplate(t.templateId);
    toast(`已复制为新版本 ${r.templateCode} v${r.templateVersion}（草稿，启用前需校验）`);
    load();
  } catch (e) { toastErr(e, '操作失败'); }
}

async function setStatus(t, status) {
  try {
    await Api.setTemplateStatus(t.templateId, status);
    if (status === 'ACTIVE') toast(t.templateCode + ' 已启用');
    else toast(t.templateCode + ' 已停用', 'info');
    load();
  } catch (e) { toastErr(e, '操作失败'); }
}

onMounted(load);
</script>

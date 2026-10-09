<template>
  <div v-if="loading" class="loading-block"><div class="spin"></div><div>正在加载订单…</div></div>
  <ErrorBox v-else-if="error" :error="error" title="订单加载失败" />
  <div v-else>
    <div class="page-header">
      <div><h1>订单管理</h1><p>生产订单与工序明细；已排程订单的工艺字段需走修订流程（原因必填，需重新排程生效）</p></div>
      <div class="buttons">
        <button class="btn" @click="load">&#8635; 刷新</button>
        <button class="btn primary" v-role="['ADMIN']" @click="openAdd">+ 新增订单</button>
      </div>
    </div>
    <section class="card table-card">
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th></th><th>订单号</th><th>产品族</th><th>数量</th><th>优先级</th><th>到达时间</th><th>交期</th><th>状态</th><th>备注</th><th>工序数</th><th>操作</th></tr></thead>
          <tbody>
            <template v-for="o in orders" :key="o.orderId">
              <tr class="clickable" @click="toggleExpand(o.orderId)">
                <td>▸</td>
                <td>{{ o.orderCode }}</td>
                <td>{{ o.productFamily }}</td>
                <td>{{ o.quantity }}</td>
                <td>{{ o.priority }}</td>
                <td>{{ fmtDateTime(o.arrivalAt) }}</td>
                <td>{{ fmtDateTime(o.dueAt) }}</td>
                <td>
                  <StatusTag :status="o.status" />
                  <span v-if="o.revisionNo" class="tag orange">修订×{{ o.revisionNo }}</span>
                </td>
                <td><span class="muted">{{ o.remark || '-' }}</span></td>
                <td>{{ (o.operations || []).length }}</td>
                <td class="table-actions">
                  <a v-if="o.scheduled" @click.stop="openRevise(o)">修订</a>
                  <a v-else @click.stop="openEdit(o)">编辑</a>
                  <a @click.stop="openRevs(o)">修订记录</a>
                </td>
              </tr>
              <tr v-if="expanded.has(o.orderId)" class="ops-expand">
                <td colspan="11">
                  <table class="data-table">
                    <thead><tr><th>工序</th><th>序号</th><th>状态</th><th>候选设备（准备/加工 分钟）</th></tr></thead>
                    <tbody>
                      <tr v-for="op in o.operations || []" :key="op.operationId">
                        <td>{{ op.operationId }}</td>
                        <td>{{ op.seqNo }}</td>
                        <td><StatusTag :status="op.status" /></td>
                        <td>
                          <span v-for="c in op.candidates || []" :key="c.machineId" class="machine-chip">{{ c.machineId }} {{ c.setupMinutes }}/{{ c.processMinutes }}</span>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </section>

    <!-- 新增订单 -->
    <el-dialog v-model="addDlg.visible" title="新增订单" width="600px">
      <div class="form-grid">
        <label class="required">订单号</label>
        <input class="field" v-model="addDlg.form.orderCode">
        <label class="required">产品族</label>
        <select class="field" v-model="addDlg.form.productFamily" @change="onAddFamilyChange">
          <option v-for="f in families" :key="f" :value="f">{{ f }}</option>
        </select>
        <label class="required">工艺模板</label>
        <select class="field" v-model="addDlg.form.templateId">
          <option v-for="t in templatesOfFamily(addDlg.form.productFamily)" :key="t.templateId" :value="t.templateId">{{ t.templateCode }} v{{ t.templateVersion }}</option>
        </select>
        <label class="required">数量</label>
        <input type="number" class="field" v-model="addDlg.form.quantity" min="1">
        <label class="required">优先级</label>
        <input type="number" class="field" v-model="addDlg.form.priority" min="1" max="5">
        <label class="required">到达时间</label>
        <input type="datetime-local" class="field" v-model="addDlg.form.arrivalAt">
        <label class="required">交期</label>
        <input type="datetime-local" class="field" v-model="addDlg.form.dueAt">
        <label>备注</label>
        <textarea class="field" v-model="addDlg.form.remark" placeholder="可选"></textarea>
      </div>
      <p class="hint">创建后按所选模板实例化工序，订单进入待排程（WAITING）状态，可在基线排程中勾选参与。</p>
      <div v-if="addDlg.err" class="error-box" style="margin-top:10px">{{ addDlg.err }}</div>
      <template #footer>
        <button class="btn" @click="addDlg.visible = false">取消</button>
        <button class="btn primary" :disabled="addDlg.busy" @click="createOrder">创建</button>
      </template>
    </el-dialog>

    <!-- 编辑订单（未排程） -->
    <el-dialog v-model="editDlg.visible" :title="'编辑订单 ' + (editDlg.order ? editDlg.order.orderCode : '')" width="600px">
      <div class="form-grid" v-if="editDlg.order">
        <label>订单号</label>
        <input class="field" :value="editDlg.order.orderCode" disabled>
        <label>产品族</label>
        <input class="field" :value="editDlg.order.productFamily" disabled>
        <label class="required">数量</label>
        <input type="number" class="field" v-model="editDlg.form.quantity" min="1">
        <label class="required">优先级</label>
        <input type="number" class="field" v-model="editDlg.form.priority" min="1" max="5">
        <label class="required">到达时间</label>
        <input type="datetime-local" class="field" v-model="editDlg.form.arrivalAt">
        <label class="required">交期</label>
        <input type="datetime-local" class="field" v-model="editDlg.form.dueAt">
        <label>备注</label>
        <textarea class="field" v-model="editDlg.form.remark"></textarea>
      </div>
      <p class="hint">仅未排程订单可直接编辑工艺字段；产品族与工艺路线不可变更（会影响已实例化工序）。备注任何状态下可改。</p>
      <div v-if="editDlg.err" class="error-box" style="margin-top:10px">{{ editDlg.err }}</div>
      <template #footer>
        <button class="btn" @click="editDlg.visible = false">取消</button>
        <button class="btn primary" :disabled="editDlg.busy" @click="saveEdit">保存</button>
      </template>
    </el-dialog>

    <!-- 修订订单（已排程） -->
    <el-dialog v-model="reviseDlg.visible" :title="'修订订单 ' + (reviseDlg.order ? reviseDlg.order.orderCode : '')" width="600px">
      <div class="form-grid" v-if="reviseDlg.order">
        <label>订单号</label>
        <input class="field" :value="reviseDlg.order.orderCode" disabled>
        <label>产品族</label>
        <input class="field" :value="reviseDlg.order.productFamily" disabled>
        <label>工艺模板</label>
        <select class="field" v-model="reviseDlg.form.templateId">
          <option v-if="reviseCurrentTplMissing" :value="reviseDlg.order.templateId">（当前模板，已停用/归档）</option>
          <option v-for="t in templatesOfFamily(reviseDlg.order.productFamily)" :key="t.templateId" :value="t.templateId">{{ t.templateCode }} v{{ t.templateVersion }}</option>
        </select>
        <label class="required">数量</label>
        <input type="number" class="field" v-model="reviseDlg.form.quantity" min="1">
        <label class="required">优先级</label>
        <input type="number" class="field" v-model="reviseDlg.form.priority" min="1" max="5">
        <label class="required">到达时间</label>
        <input type="datetime-local" class="field" v-model="reviseDlg.form.arrivalAt">
        <label class="required">交期</label>
        <input type="datetime-local" class="field" v-model="reviseDlg.form.dueAt">
        <label class="required">修订原因</label>
        <textarea class="field" v-model="reviseDlg.form.reason" placeholder="必填，如：客户加单 / 工艺升级"></textarea>
      </div>
      <p class="hint">订单已排程：修订会记录前后值差异并更新订单；模板变更时未开始的工序按新模板重建、已开始的保持不变；修订后需重新排程才会反映到计划（不自动触发）。</p>
      <div v-if="reviseDlg.err" class="error-box" style="margin-top:10px">{{ reviseDlg.err }}</div>
      <template #footer>
        <button class="btn" @click="reviseDlg.visible = false">取消</button>
        <button class="btn primary" :disabled="reviseDlg.busy" @click="submitRevision">提交修订</button>
      </template>
    </el-dialog>

    <!-- 修订记录 -->
    <el-dialog v-model="revsDlg.visible" :title="'订单 ' + revsDlg.orderCode + ' 修订记录'" width="780px">
      <div v-if="revsDlg.revisions.length" class="table-wrap">
        <table class="data-table">
          <thead><tr><th>#</th><th>时间</th><th>操作人</th><th>原因</th><th>前后差异</th></tr></thead>
          <tbody>
            <tr v-for="r in revsDlg.revisions" :key="r.revisionNo">
              <td>{{ r.revisionNo }}</td>
              <td>{{ fmtDateTime(r.createdAt) }}</td>
              <td>{{ r.operator || '-' }}</td>
              <td>{{ r.reason }}</td>
              <td>
                <div v-for="(c, i) in r.changedFields || []" :key="i">
                  {{ FIELD_LABEL[c.field] || c.field }}: {{ fmtVal(c.field, c.oldValue) }} → {{ fmtVal(c.field, c.newValue) }}
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="muted">暂无修订记录。</p>
      <template #footer>
        <button class="btn" @click="revsDlg.visible = false">取消</button>
        <button class="btn primary" @click="revsDlg.visible = false">关闭</button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessageBox } from 'element-plus';
import { Api } from '../api';
import { toast, toastErr } from '../utils/ui';
import { errMsg, fmtDateTime, isoToLocalInput, localInputToIso } from '../utils/format';
import StatusTag from '../components/StatusTag.vue';
import ErrorBox from '../components/ErrorBox.vue';

const FIELD_LABEL = { productFamily: '产品族', templateId: '工艺模板', quantity: '数量', priority: '优先级', arrivalAt: '到达时间', dueAt: '交期' };

const orders = ref([]);
const templates = ref([]);
const loading = ref(true);
const error = ref(null);
const expanded = ref(new Set());

const activeTemplates = computed(() => templates.value.filter(t => t.status === 'ACTIVE'));
const families = computed(() => [...new Set(activeTemplates.value.map(t => t.productFamily))]);

function templatesOfFamily(family) {
  return activeTemplates.value.filter(t => t.productFamily === family);
}

function fmtVal(field, v) {
  return (field === 'arrivalAt' || field === 'dueAt') ? fmtDateTime(v) : (v ?? '-');
}

async function load() {
  loading.value = true; error.value = null;
  try {
    [orders.value, templates.value] = await Promise.all([Api.orders(), Api.templates()]);
  } catch (e) {
    error.value = e;
  } finally {
    loading.value = false;
  }
}

function toggleExpand(orderId) {
  const s = new Set(expanded.value);
  if (s.has(orderId)) s.delete(orderId); else s.add(orderId);
  expanded.value = s;
}

/* 数量/优先级/到达/交期 公共校验（对应旧版 collectProcessFields） */
function collectProcessFields(form) {
  const quantity = parseInt(form.quantity, 10);
  const priority = parseInt(form.priority, 10);
  const arrivalAt = localInputToIso(form.arrivalAt);
  const dueAt = localInputToIso(form.dueAt);
  if (!quantity || quantity <= 0) return { err: '数量必须是正整数' };
  if (!priority || priority < 1 || priority > 5) return { err: '优先级必须在 1-5 之间' };
  if (!arrivalAt || !dueAt) return { err: '请填写到达时间与交期' };
  if (Date.parse(dueAt) < Date.parse(arrivalAt)) return { err: '交期不能早于到达时间' };
  return { quantity, priority, arrivalAt, dueAt };
}

/* ---------------- 新增订单 ---------------- */
const addDlg = reactive({
  visible: false, busy: false, err: '',
  form: { orderCode: '', productFamily: '', templateId: '', quantity: 20, priority: 3, arrivalAt: '', dueAt: '', remark: '' },
});

function openAdd() {
  if (!families.value.length) { toast('当前没有启用中的工艺模板，请先在「工艺模板」创建', 'error'); return; }
  const family = families.value[0];
  const tpls = templatesOfFamily(family);
  addDlg.err = '';
  addDlg.form = {
    orderCode: 'ORD-' + (Date.now() % 1000000),
    productFamily: family,
    templateId: tpls.length ? tpls[0].templateId : '',
    quantity: 20,
    priority: 3,
    arrivalAt: isoToLocalInput(new Date().toISOString()),
    dueAt: isoToLocalInput(new Date(Date.now() + 48 * 3600e3).toISOString()),
    remark: '',
  };
  addDlg.visible = true;
}

function onAddFamilyChange() {
  const tpls = templatesOfFamily(addDlg.form.productFamily);
  addDlg.form.templateId = tpls.length ? tpls[0].templateId : '';
}

async function createOrder() {
  addDlg.err = '';
  const f = addDlg.form;
  const orderCode = f.orderCode.trim();
  if (!orderCode) { addDlg.err = '请填写订单号'; return; }
  const p = collectProcessFields(f);
  if (p.err) { addDlg.err = p.err; return; }
  addDlg.busy = true;
  try {
    const r = await Api.createOrder({
      orderCode,
      productFamily: f.productFamily,
      quantity: p.quantity,
      priority: p.priority,
      arrivalAt: p.arrivalAt,
      dueAt: p.dueAt,
      templateId: f.templateId,
      remark: f.remark.trim() || undefined,
    });
    toast(`订单 ${r.orderCode} 已创建，实例化 ${r.operationIds.length} 道工序`);
    addDlg.visible = false;
    load();
  } catch (e) {
    addDlg.err = errMsg(e);
  } finally {
    addDlg.busy = false;
  }
}

/* ---------------- 编辑订单（未排程） ---------------- */
const editDlg = reactive({
  visible: false, busy: false, err: '', order: null,
  form: { quantity: 1, priority: 3, arrivalAt: '', dueAt: '', remark: '' },
});

function openEdit(o) {
  editDlg.order = o;
  editDlg.err = '';
  editDlg.form = {
    quantity: o.quantity,
    priority: o.priority,
    arrivalAt: isoToLocalInput(o.arrivalAt),
    dueAt: isoToLocalInput(o.dueAt),
    remark: o.remark || '',
  };
  editDlg.visible = true;
}

async function saveEdit() {
  editDlg.err = '';
  const p = collectProcessFields(editDlg.form);
  if (p.err) { editDlg.err = p.err; return; }
  editDlg.busy = true;
  try {
    await Api.updateOrder(editDlg.order.orderId, {
      quantity: p.quantity,
      priority: p.priority,
      arrivalAt: p.arrivalAt,
      dueAt: p.dueAt,
      remark: editDlg.form.remark.trim(),
    });
    toast('订单 ' + editDlg.order.orderCode + ' 已更新');
    editDlg.visible = false;
    load();
  } catch (e) {
    editDlg.err = errMsg(e);
  } finally {
    editDlg.busy = false;
  }
}

/* ---------------- 修订订单（已排程，F-04） ---------------- */
const reviseDlg = reactive({
  visible: false, busy: false, err: '', order: null,
  form: { templateId: '', quantity: 1, priority: 3, arrivalAt: '', dueAt: '', reason: '' },
});

const reviseCurrentTplMissing = computed(() => {
  const o = reviseDlg.order;
  return !!(o && o.templateId && !activeTemplates.value.some(t => t.templateId === o.templateId));
});

function openRevise(o) {
  reviseDlg.order = o;
  reviseDlg.err = '';
  reviseDlg.form = {
    templateId: o.templateId || '',
    quantity: o.quantity,
    priority: o.priority,
    arrivalAt: isoToLocalInput(o.arrivalAt),
    dueAt: isoToLocalInput(o.dueAt),
    reason: '',
  };
  reviseDlg.visible = true;
}

async function submitRevision() {
  reviseDlg.err = '';
  const o = reviseDlg.order;
  const p = collectProcessFields(reviseDlg.form);
  if (p.err) { reviseDlg.err = p.err; return; }
  const reason = reviseDlg.form.reason.trim();
  if (!reason) { reviseDlg.err = '请填写修订原因'; return; }
  const templateId = reviseDlg.form.templateId || null;
  const payload = { reason };
  const diffs = [];
  if (p.quantity !== o.quantity) { payload.quantity = p.quantity; diffs.push(`数量: ${o.quantity} → ${p.quantity}`); }
  if (p.priority !== o.priority) { payload.priority = p.priority; diffs.push(`优先级: ${o.priority} → ${p.priority}`); }
  if (Date.parse(p.arrivalAt) !== Date.parse(o.arrivalAt)) { payload.arrivalAt = p.arrivalAt; diffs.push(`到达时间: ${fmtDateTime(o.arrivalAt)} → ${fmtDateTime(p.arrivalAt)}`); }
  if (Date.parse(p.dueAt) !== Date.parse(o.dueAt)) { payload.dueAt = p.dueAt; diffs.push(`交期: ${fmtDateTime(o.dueAt)} → ${fmtDateTime(p.dueAt)}`); }
  if (templateId !== (o.templateId || null)) {
    payload.templateId = templateId;
    const t = activeTemplates.value.find(x => x.templateId === templateId);
    diffs.push(`工艺模板: → ${t ? t.templateCode + ' v' + t.templateVersion : templateId}`);
  }
  if (!diffs.length) { reviseDlg.err = '未修改任何工艺字段'; return; }
  try {
    await ElMessageBox.confirm(
      `确认提交修订？\n\n${diffs.join('\n')}\n\n修订原因：${reason}\n\n提交后需重新排程才会生效。`,
      '提交修订',
      { type: 'warning', customStyle: { 'white-space': 'pre-line' } },
    );
  } catch { return; }
  reviseDlg.busy = true;
  try {
    const r = await Api.createOrderRevision(o.orderId, payload);
    toast(`订单 ${o.orderCode} 已生成修订记录 #${r.revisionNo}，需重新排程后生效`);
    reviseDlg.visible = false;
    load();
  } catch (e) {
    reviseDlg.err = errMsg(e);
  } finally {
    reviseDlg.busy = false;
  }
}

/* ---------------- 修订记录 ---------------- */
const revsDlg = reactive({ visible: false, orderCode: '', revisions: [] });

async function openRevs(o) {
  let revisions;
  try {
    revisions = await Api.orderRevisions(o.orderId);
  } catch (e) {
    toastErr(e, '修订记录加载失败');
    return;
  }
  revsDlg.orderCode = o.orderCode;
  revsDlg.revisions = revisions;
  revsDlg.visible = true;
}

onMounted(load);
</script>

<style scoped>
.machine-chip { margin-right: 5px; }
</style>

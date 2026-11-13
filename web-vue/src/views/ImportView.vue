<template>
  <div>
    <div class="page-header">
      <div><h1>批量导入</h1>
        <p>按模板批量导入订单 / 设备（CSV，UTF-8，≤2MB，≤1000 行）；先预览校验，仅无错误批次可整批入库，失败不产生半批数据</p></div>
      <div class="buttons"><button class="btn" @click="reset">&#8635; 重置</button></div>
    </div>
    <section class="card import-form" style="margin-bottom:14px"><div class="form-grid">
      <label class="required">导入类型</label>
      <select class="field" v-model="type" @change="onTypeChange">
        <option v-for="(t, v) in IMPORT_TYPES" :key="v" :value="v">{{ t }}</option>
      </select>
      <label>CSV 模板</label>
      <div><button class="btn" @click="downloadTemplate">&#11015; 下载模板</button>
        <span class="muted" style="margin-left:8px">含表头与示例行，表头不可修改</span></div>
      <label class="required">数据文件</label>
      <div class="file-row">
        <input type="file" ref="fileInput" accept=".csv" style="display:none" @change="onFileChange">
        <button class="btn" @click="fileInput.click()">选择文件</button>
        <span class="file-name" :class="{ muted: !fileName }">{{ fileName || '未选择任何文件' }}</span>
        <button class="btn primary" style="margin-left:auto;flex:none" :disabled="previewing" @click="uploadPreview">上传预览</button>
      </div>
    </div></section>

    <section v-if="previewing" class="loading-block"><div class="spin"></div><div>正在预检与逐行校验…</div></section>
    <ErrorBox v-else-if="previewError" :error="previewError" title="预检未通过" />
    <section v-else-if="preview" class="card">
      <div style="display:flex;gap:18px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
        <span>批次号 <b>{{ preview.batchCode }}</b></span>
        <span class="muted">文件 {{ preview.fileName || '-' }}</span>
        <span class="muted">SHA-256 {{ String(preview.fileSha256 || '').slice(0, 16) }}…</span>
        <span>总行数 <b>{{ preview.totalRows }}</b></span>
        <span style="color:#52c41a">成功 <b>{{ preview.successRows }}</b></span>
        <span :style="{ color: preview.errorRows ? '#f5222d' : 'inherit' }">错误 <b>{{ preview.errorRows }}</b></span>
      </div>
      <template v-if="errors.length">
        <div class="table-wrap"><table class="data-table">
          <thead><tr><th>行号</th><th>错误码</th><th>字段</th><th>原值</th><th>修正建议</th></tr></thead>
          <tbody>
            <tr v-for="err in shownErrors" :key="err.row + ':' + err.code">
              <td>{{ err.row }}</td><td><span class="tag red">{{ err.code }}</span></td><td>{{ err.field }}</td>
              <td>{{ err.value }}</td><td>{{ err.suggestion }}</td>
            </tr>
          </tbody>
        </table></div>
        <p v-if="errors.length > shownErrors.length" class="muted">仅展示前 {{ shownErrors.length }} 条错误，共 {{ errors.length }} 条</p>
        <p class="muted">存在错误行，禁止入库；请修正后重新上传预览。</p>
      </template>
      <template v-else>
        <p style="color:#52c41a">全部 {{ preview.totalRows }} 行校验通过，可整批入库。</p>
        <button class="btn primary" :disabled="committing" @click="commit">确认入库 {{ preview.totalRows }} 行</button>
      </template>
    </section>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue';
import { Api } from '../api';
import { toast, toastErr } from '../utils/ui';
import ErrorBox from '../components/ErrorBox.vue';

const IMPORT_TYPES = { orders: '生产订单', machines: '设备' };

const type = ref('orders');
const fileInput = ref(null);
const fileName = ref('');
const preview = ref(null);
const previewing = ref(false);
const previewError = ref(null);
const committing = ref(false);

const errors = computed(() => (preview.value && preview.value.errors) || []);
const shownErrors = computed(() => errors.value.slice(0, 200));

function clearResult() {
  preview.value = null;
  previewError.value = null;
  previewing.value = false;
  committing.value = false;
}

function clearFile() {
  if (fileInput.value) fileInput.value.value = '';
  fileName.value = '';
}

function onFileChange() {
  const f = fileInput.value && fileInput.value.files[0];
  fileName.value = f ? f.name : '';
}

function onTypeChange() {
  clearResult();
  clearFile();
}

function reset() {
  type.value = 'orders';
  clearResult();
  clearFile();
}

async function downloadTemplate() {
  try { await Api.importTemplate(type.value); } catch (e) { toastErr(e, '模板下载失败'); }
}

async function uploadPreview() {
  const file = fileInput.value && fileInput.value.files[0];
  if (!file) { toast('请先选择 CSV 文件', 'error'); return; }
  preview.value = null;
  previewError.value = null;
  previewing.value = true;
  try {
    preview.value = await Api.importPreview(type.value, file);
  } catch (e) {
    previewError.value = e;
  } finally {
    previewing.value = false;
  }
}

async function commit() {
  const d = preview.value;
  if (!d) return;
  committing.value = true;
  try {
    const r = await Api.importCommit(type.value, d.batchCode);
    if (r.status === 'COMMITTED') {
      toast(`批次 ${r.batchCode} 已整批入库 ${r.committedRows} 行`);
      reset();
    } else {
      preview.value = { ...d, errorRows: (r.errors || []).length, errors: r.errors || [] };
      toast('提交复检未通过，批次已标记失败，请修正后重新导入', 'error');
    }
  } catch (e) {
    toastErr(e, '入库失败');
  } finally {
    committing.value = false;
  }
}
</script>

<style scoped>
.import-form { padding:28px 32px; }
.import-form .form-grid { grid-template-columns:110px 1fr; gap:24px 14px; }
.import-form .field { height:40px; }
.import-form .btn { height:40px; padding:0 20px; }
.import-form select.field { width:320px; max-width:100%; padding-right:32px; appearance:none; -webkit-appearance:none; background:#fff url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M2.5 4.5 6 8l3.5-3.5' fill='none' stroke='%236e6e73' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") no-repeat right 13px center; }
section.card:not(.import-form) { padding:20px 24px; }
.file-row { display:flex; align-items:center; gap:12px; }
.file-name { min-width:0; overflow:hidden; color:#3a3a3c; font-size:13px; text-overflow:ellipsis; white-space:nowrap; }
</style>

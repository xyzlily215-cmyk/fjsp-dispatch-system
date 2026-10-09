<template>
  <AsyncPage :loading="loading" :error="error" error-title="配置加载失败" loading-text="正在加载配置…">
    <div class="page-header">
      <div><h1>基础字典维护</h1><p>键值型系统配置；每次修改生成新配置版本并即时生效，全程留审计</p></div>
      <div class="buttons"><button class="btn" @click="load">&#8635; 刷新</button></div>
    </div>
    <section class="card table-card">
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>配置键</th><th>配置值</th><th>说明</th><th>版本</th><th>生效时间</th><th>更新人</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="c in configs" :key="c.configKey">
              <td class="machine-name">{{ c.configKey }}</td>
              <td style="max-width:320px;word-break:break-all">{{ c.configValue }}</td>
              <td><span class="muted">{{ c.description || '-' }}</span></td>
              <td>v{{ c.version }}</td>
              <td>{{ fmtDateTime(c.effectiveAt) }}</td>
              <td>{{ c.updatedBy || '-' }}</td>
              <td class="table-actions"><a @click="openEdit(c)">编辑</a></td>
            </tr>
            <tr v-if="!configs.length"><td colspan="7" style="text-align:center;color:#909399">暂无配置项</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <el-dialog v-model="dlg.visible" :title="'编辑配置 ' + (dlg.config ? dlg.config.configKey : '')" width="600px">
      <div class="form-grid">
        <label>配置键</label>
        <input class="field" :value="dlg.config ? dlg.config.configKey : ''" disabled>
        <label>说明</label>
        <input class="field" :value="dlg.config ? (dlg.config.description || '') : ''" disabled>
        <label class="required">配置值</label>
        <textarea class="field" v-model="dlg.form.configValue" style="min-height:64px"></textarea>
      </div>
      <p v-if="dlg.config" class="hint">保存后配置版本 v{{ dlg.config.version }} → v{{ dlg.config.version + 1 }}，新的生效时间即时生效并写入审计。</p>
      <div v-if="dlg.err" class="error-box" style="margin-top:10px">{{ dlg.err }}</div>
      <template #footer>
        <button class="btn" @click="dlg.visible = false">取消</button>
        <button class="btn primary" :disabled="dlg.busy" @click="save">保存</button>
      </template>
    </el-dialog>
  </AsyncPage>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
import { Api } from '../api';
import { toast } from '../utils/ui';
import { errMsg, fmtDateTime } from '../utils/format';
import ErrorBox from '../components/ErrorBox.vue';

const configs = ref([]);
const loading = ref(true);
const error = ref(null);

const dlg = reactive({
  visible: false, config: null, busy: false, err: '',
  form: { configValue: '' },
});

async function load() {
  loading.value = true; error.value = null;
  try {
    configs.value = await Api.adminConfigs();
  } catch (e) {
    error.value = e;
  } finally {
    loading.value = false;
  }
}

function openEdit(c) {
  dlg.config = c;
  dlg.err = '';
  dlg.form = { configValue: c.configValue || '' };
  dlg.visible = true;
}

async function save() {
  dlg.err = '';
  const c = dlg.config;
  const configValue = dlg.form.configValue.trim();
  if (!configValue) { dlg.err = '配置值不能为空'; return; }
  dlg.busy = true;
  try {
    const r = await Api.adminUpdateConfig(c.configKey, configValue);
    toast(`配置 ${c.configKey} 已更新为 v${r.version}`);
    dlg.visible = false;
    load();
  } catch (e) {
    dlg.err = errMsg(e);
  } finally {
    dlg.busy = false;
  }
}

onMounted(load);
</script>

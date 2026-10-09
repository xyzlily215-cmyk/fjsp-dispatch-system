<template>
  <AsyncPage :loading="loading" :error="error" error-title="用户列表加载失败" loading-text="正在加载用户…">
    <div class="page-header">
      <div><h1>用户管理</h1><p>账号新增 / 编辑 / 启停 / 重置密码；停用后账号无法再登录</p></div>
      <div class="buttons">
        <button class="btn" @click="load">&#8635; 刷新</button>
        <button class="btn primary" @click="openAdd">+ 新增用户</button>
      </div>
    </div>
    <section class="card table-card">
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>用户名</th><th>显示名</th><th>角色</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="u in users" :key="u.id">
              <td class="machine-name">{{ u.username }}</td>
              <td>{{ u.displayName || '-' }}</td>
              <td>{{ roleText(u.role) }}</td>
              <td><span class="tag" :class="u.enabled ? 'green' : 'gray'">{{ u.enabled ? '启用' : '停用' }}</span></td>
              <td>{{ fmtDateTime(u.createdAt) }}</td>
              <td class="table-actions">
                <a @click="openEdit(u)">编辑</a>
                <a v-if="u.enabled" style="color:#e6a23c" @click="toggleStatus(u, true)">停用</a>
                <a v-else style="color:#67c23a" @click="toggleStatus(u, false)">启用</a>
                <a style="color:#d54941" @click="openReset(u)">重置密码</a>
              </td>
            </tr>
            <tr v-if="!users.length"><td colspan="6" style="text-align:center;color:#909399">暂无用户</td></tr>
          </tbody>
        </table>
      </div>
      <Pager v-if="page" :page="page" @change="onPage" />
    </section>

    <el-dialog v-model="addDlg.visible" title="新增用户" width="600px">
      <div class="form-grid">
        <label class="required">用户名</label>
        <input class="field" v-model="addDlg.form.username" placeholder="2-32 位字母、数字或 _ . -">
        <label class="required">显示名</label>
        <input class="field" v-model="addDlg.form.displayName" placeholder="如 调度员乙">
        <label class="required">角色</label>
        <select class="field" v-model="addDlg.form.role">
          <option v-for="r in ROLES" :key="r" :value="r">{{ roleText(r) }}（{{ r }}）</option>
        </select>
        <label class="required">初始密码</label>
        <input class="field" v-model="addDlg.form.password" type="password" autocomplete="new-password" placeholder="至少 8 位，含字母与数字">
      </div>
      <p class="hint">创建后请将初始密码告知使用人；密码至少 8 位且须同时包含字母与数字。</p>
      <div v-if="addDlg.err" class="error-box" style="margin-top:10px">{{ addDlg.err }}</div>
      <template #footer>
        <button class="btn" @click="addDlg.visible = false">取消</button>
        <button class="btn primary" :disabled="addDlg.busy" @click="createUser">创建</button>
      </template>
    </el-dialog>

    <el-dialog v-model="editDlg.visible" :title="'编辑用户 ' + (editDlg.user ? editDlg.user.username : '')" width="600px">
      <div class="form-grid">
        <label>用户名</label>
        <input class="field" :value="editDlg.user ? editDlg.user.username : ''" disabled>
        <label class="required">显示名</label>
        <input class="field" v-model="editDlg.form.displayName">
        <label class="required">角色</label>
        <select class="field" v-model="editDlg.form.role">
          <option v-for="r in ROLES" :key="r" :value="r">{{ roleText(r) }}（{{ r }}）</option>
        </select>
      </div>
      <p class="hint">至少需保留一个启用中的管理员账号；最后一个管理员的降级/停用会被拒绝。</p>
      <div v-if="editDlg.err" class="error-box" style="margin-top:10px">{{ editDlg.err }}</div>
      <template #footer>
        <button class="btn" @click="editDlg.visible = false">取消</button>
        <button class="btn primary" :disabled="editDlg.busy" @click="saveUser">保存</button>
      </template>
    </el-dialog>

    <el-dialog v-model="resetDlg.visible" :title="'重置密码 · ' + (resetDlg.user ? resetDlg.user.username : '')" width="600px">
      <div class="form-grid">
        <label class="required">新密码</label>
        <input class="field" v-model="resetDlg.form.password" type="password" autocomplete="new-password" placeholder="至少 8 位，含字母与数字">
      </div>
      <p class="hint">重置后旧密码立即失效；已签发的登录令牌在到期前仍可使用。</p>
      <div v-if="resetDlg.err" class="error-box" style="margin-top:10px">{{ resetDlg.err }}</div>
      <template #footer>
        <button class="btn" @click="resetDlg.visible = false">取消</button>
        <button class="btn primary" :disabled="resetDlg.busy" @click="resetPassword">重置</button>
      </template>
    </el-dialog>
  </AsyncPage>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { Api } from '../api';
import { toast, toastErr } from '../utils/ui';
import { errMsg, fmtDateTime } from '../utils/format';
import { roleText } from '../stores/auth';
import ErrorBox from '../components/ErrorBox.vue';
import Pager from '../components/Pager.vue';

const ROLES = ['DISPATCHER', 'REVIEWER', 'PRODUCTION_MANAGER', 'ADMIN'];

const page = ref(null);
const loading = ref(true);
const error = ref(null);
const pageNo = ref(0);

const users = computed(() => (page.value && page.value.items) || []);

async function load() {
  loading.value = true; error.value = null;
  try {
    page.value = await Api.adminUsersPage(pageNo.value, 20);
  } catch (e) {
    error.value = e;
  } finally {
    loading.value = false;
  }
}

function onPage(delta) {
  pageNo.value = Math.max(0, pageNo.value + delta);
  load();
}

const addDlg = reactive({
  visible: false, busy: false, err: '',
  form: { username: '', displayName: '', role: 'DISPATCHER', password: '' },
});

function openAdd() {
  addDlg.err = '';
  addDlg.form = { username: '', displayName: '', role: 'DISPATCHER', password: '' };
  addDlg.visible = true;
}

async function createUser() {
  addDlg.err = '';
  const f = addDlg.form;
  const username = f.username.trim();
  const displayName = f.displayName.trim();
  if (!username) { addDlg.err = '请填写用户名'; return; }
  if (!f.password) { addDlg.err = '请填写初始密码'; return; }
  addDlg.busy = true;
  try {
    await Api.adminCreateUser({ username, displayName: displayName || undefined, password: f.password, role: f.role });
    toast('用户 ' + username + ' 已创建');
    addDlg.visible = false;
    load();
  } catch (e) {
    addDlg.err = errMsg(e);
  } finally {
    addDlg.busy = false;
  }
}

const editDlg = reactive({
  visible: false, user: null, busy: false, err: '',
  form: { displayName: '', role: 'DISPATCHER' },
});

function openEdit(u) {
  editDlg.user = u;
  editDlg.err = '';
  editDlg.form = { displayName: u.displayName || '', role: u.role };
  editDlg.visible = true;
}

async function saveUser() {
  editDlg.err = '';
  const u = editDlg.user;
  editDlg.busy = true;
  try {
    await Api.adminUpdateUser(u.id, {
      role: editDlg.form.role,
      displayName: editDlg.form.displayName.trim() || undefined,
    });
    toast('用户 ' + u.username + ' 已更新');
    editDlg.visible = false;
    load();
  } catch (e) {
    editDlg.err = errMsg(e);
  } finally {
    editDlg.busy = false;
  }
}

const resetDlg = reactive({
  visible: false, user: null, busy: false, err: '',
  form: { password: '' },
});

function openReset(u) {
  resetDlg.user = u;
  resetDlg.err = '';
  resetDlg.form = { password: '' };
  resetDlg.visible = true;
}

async function resetPassword() {
  resetDlg.err = '';
  const u = resetDlg.user;
  if (!resetDlg.form.password) { resetDlg.err = '请填写新密码'; return; }
  resetDlg.busy = true;
  try {
    await Api.adminResetUserPassword(u.id, resetDlg.form.password);
    toast('用户 ' + u.username + ' 的密码已重置');
    resetDlg.visible = false;
  } catch (e) {
    resetDlg.err = errMsg(e);
  } finally {
    resetDlg.busy = false;
  }
}

async function toggleStatus(u, toDisable) {
  if (toDisable) {
    try {
      await ElMessageBox.confirm(`确定停用用户 ${u.username}？停用后该账号无法再登录。`, '停用用户', { type: 'warning' });
    } catch { return; }
  }
  try {
    await Api.adminSetUserStatus(u.id, !toDisable);
    toast(`用户 ${u.username} 已${toDisable ? '停用' : '启用'}`);
    load();
  } catch (e) { toastErr(e, '操作失败'); }
}

onMounted(load);
</script>

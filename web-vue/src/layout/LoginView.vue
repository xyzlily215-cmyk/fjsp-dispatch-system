<template>
  <div class="login-view">
    <div class="login-panel">
      <aside class="login-brand">
        <div class="brand-title">
          <span class="login-mark">▣</span>
          <span>动态柔性车间生产调度与仿真决策系统</span>
        </div>
        <p class="brand-sub">FJSP · 基线排程 · 动态重调度 · 方案对比 · 审核发布 · 执行反馈</p>
        <ul class="brand-points">
          <li>甘特图双视图联动，方案差异一目了然</li>
          <li>插单 / 故障事件驱动的局部与完全重调度</li>
          <li>提交、审核、发布、回滚全程可追溯</li>
        </ul>
      </aside>

      <form class="login-card" @submit.prevent="submit">
        <h2 class="card-title">欢迎登录</h2>
        <p class="card-sub">请使用演示账号登录系统</p>

        <label class="login-label" for="loginUsername">用户名</label>
        <input id="loginUsername" class="login-input" v-model="username" autocomplete="username" required autofocus
               placeholder="请输入用户名">

        <label class="login-label" for="loginPassword">密码</label>
        <input id="loginPassword" class="login-input" v-model="password" type="password"
               autocomplete="current-password" required placeholder="请输入密码">

        <div class="login-error">{{ error }}</div>

        <button class="login-btn" type="submit" :disabled="busy">
          {{ busy ? '登录中…' : '登 录' }}
        </button>

        <div class="quick-accounts">
          <span class="quick-label">演示账号</span>
          <button v-for="acc in demoAccounts" :key="acc.user" type="button" class="quick-chip"
                  @click="fill(acc)">{{ acc.label }}</button>
        </div>
      </form>
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { errMsg } from '../utils/format';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

const username = ref('');
const password = ref('');
const error = ref('');
const busy = ref(false);

const DEMO_PASSWORD = 'Fj@123456';
const demoAccounts = [
  { user: 'dispatcher', label: '调度员' },
  { user: 'reviewer', label: '审核员' },
  { user: 'manager', label: '生产主管' },
  { user: 'admin', label: '管理员' },
];

function fill(acc) {
  username.value = acc.user;
  password.value = DEMO_PASSWORD;
  error.value = '';
}

onMounted(() => {
  if (route.query.expired) error.value = '登录已过期，请重新登录';
});

async function submit() {
  error.value = '';
  busy.value = true;
  try {
    await auth.login(username.value.trim(), password.value);
    router.replace({ name: 'board' });
  } catch (e) {
    error.value = errMsg(e) + (e && e.code ? '（' + e.code + '）' : '');
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.login-view {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  background: radial-gradient(1200px 600px at 15% 20%, #1d3a6e 0%, transparent 60%),
              radial-gradient(900px 500px at 85% 80%, #14504a 0%, transparent 55%),
              linear-gradient(135deg, #0f1f3d 0%, #12294a 55%, #0d1b33 100%);
}

.login-panel {
  display: flex;
  width: 860px;
  max-width: 92vw;
  min-height: 480px;
  border-radius: 16px;
  overflow: hidden;
  box-shadow: 0 24px 64px rgba(0, 0, 0, .45);
}

.login-brand {
  flex: 1.2;
  padding: 56px 44px;
  color: #e8eefc;
  background: linear-gradient(160deg, rgba(64, 158, 255, .18), rgba(20, 80, 74, .10));
  border-right: 1px solid rgba(255, 255, 255, .08);
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.brand-title {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 22px;
  font-weight: 600;
  line-height: 1.5;
}

.login-mark {
  font-size: 28px;
  color: #6fb3ff;
}

.brand-sub {
  margin: 18px 0 28px;
  font-size: 13px;
  letter-spacing: .5px;
  color: #9db4d8;
}

.brand-points {
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 14px;
  color: #c4d4ef;
}

.brand-points li {
  position: relative;
  padding-left: 20px;
  margin-bottom: 14px;
  line-height: 1.6;
}

.brand-points li::before {
  content: '';
  position: absolute;
  left: 0;
  top: 9px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #6fb3ff;
}

.login-card {
  flex: 1;
  padding: 48px 40px 32px;
  background: #fff;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.card-title {
  margin: 0 0 6px;
  font-size: 22px;
  color: #1f2d3d;
}

.card-sub {
  margin: 0 0 22px;
  font-size: 13px;
  color: #909399;
}

.login-label {
  display: block;
  margin: 12px 0 6px;
  font-size: 13px;
  color: #606266;
}

.login-input {
  width: 100%;
  height: 40px;
  padding: 0 12px;
  border: 1px solid #dcdfe6;
  border-radius: 6px;
  box-sizing: border-box;
  font-size: 14px;
  transition: border-color .15s, box-shadow .15s;
}

.login-input:focus {
  outline: none;
  border-color: #409eff;
  box-shadow: 0 0 0 3px rgba(64, 158, 255, .15);
}

.login-error {
  min-height: 20px;
  margin-top: 10px;
  color: #f56c6c;
  font-size: 13px;
}

.login-btn {
  width: 100%;
  height: 42px;
  margin-top: 6px;
  border: none;
  border-radius: 6px;
  background: linear-gradient(90deg, #2f7cf6, #409eff);
  color: #fff;
  font-size: 15px;
  letter-spacing: 2px;
  cursor: pointer;
  transition: opacity .15s, transform .1s;
}

.login-btn:hover:not(:disabled) { opacity: .92; }
.login-btn:active:not(:disabled) { transform: translateY(1px); }
.login-btn:disabled { opacity: .6; cursor: not-allowed; }

.quick-accounts {
  margin-top: 22px;
  padding-top: 16px;
  border-top: 1px dashed #e4e7ed;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.quick-label {
  font-size: 12px;
  color: #909399;
  margin-right: 2px;
}

.quick-chip {
  padding: 4px 12px;
  border: 1px solid #d3e2f8;
  border-radius: 999px;
  background: #f2f7ff;
  color: #2f7cf6;
  font-size: 12px;
  cursor: pointer;
  transition: background .15s, border-color .15s;
}

.quick-chip:hover {
  background: #e1eeff;
  border-color: #a9c8f5;
}

@media (max-width: 720px) {
  .login-brand { display: none; }
  .login-panel { width: 400px; }
}
</style>

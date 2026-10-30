<template>
  <div class="login-view">
    <div class="login-panel">
      <aside class="login-brand">
        <div class="login-eyebrow">FJSP OPS / 智能制造</div>
        <div class="brand-title">
          <span class="login-mark">▣</span>
          <span>动态柔性车间生产调度与仿真决策系统</span>
        </div>
        <p class="brand-sub">FJSP · 基线排程 · 动态重调度 · 方案对比 · 审核发布 · 执行反馈</p>
        <img class="login-factory" src="/images/factory-control.webp" alt="柔性制造车间主题插画" width="1536" height="1024">
        <ul class="brand-points">
          <li>甘特图双视图联动，方案差异一目了然</li>
          <li>插单 / 故障事件驱动的局部与完全重调度</li>
          <li>提交、审核、发布、回滚全程可追溯</li>
        </ul>
      </aside>

      <form class="login-card" @submit.prevent="submit">
        <span class="login-kicker">生产调度工作空间</span>
        <h2 class="card-title">欢迎回来</h2>
        <p class="card-sub">登录控制台，开启高效有序的生产协作</p>

        <label class="login-label" for="loginUsername">用户名</label>
        <input id="loginUsername" class="login-input" v-model="username" autocomplete="username" required autofocus
               placeholder="请输入用户名">

        <label class="login-label" for="loginPassword">密码</label>
        <input id="loginPassword" class="login-input" v-model="password" type="password"
               autocomplete="current-password" required placeholder="请输入密码">

        <div class="login-error" role="status" aria-live="polite">{{ error }}</div>

        <button class="login-btn" type="submit" :disabled="busy">
          {{ busy ? '登录中…' : '进入控制台 →' }}
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

<style scoped>
.login-view {
  background:#0e1d2d;
  overflow:auto;
  padding:32px;
}

.login-view::before {
  content:'';
  position:absolute;
  inset:0;
  opacity:.32;
  background-image:linear-gradient(rgba(143,183,211,.12) 1px, transparent 1px), linear-gradient(90deg, rgba(143,183,211,.12) 1px, transparent 1px);
  background-size:48px 48px;
  mask-image:linear-gradient(to bottom right, #000, transparent 72%);
}

.login-panel {
  position:relative;
  width:min(100%, 980px);
  min-height:560px;
  border:1px solid rgba(255,255,255,.13);
  border-radius:14px;
  background:#172d40;
  box-shadow:0 28px 80px rgba(0,0,0,.34);
}

.login-brand {
  flex:1.12;
  padding:58px 52px;
  background:#172d40;
  border-right:1px solid rgba(255,255,255,.10);
}

.brand-title { align-items:flex-start; font-size:23px; letter-spacing:-.01em; }
.login-mark { display:grid; place-items:center; flex:none; width:38px; height:38px; border-radius:10px; color:#fff; background:#1683ff; font-size:22px; box-shadow:0 8px 18px rgba(22,131,255,.25); }
.brand-sub { margin:18px 0 34px; color:#9eb5c6; letter-spacing:.03em; }
.brand-points { color:#d4e2eb; }
.brand-points li { margin-bottom:17px; }
.brand-points li::before { width:6px; height:6px; top:10px; background:#46c59b; box-shadow:0 0 0 4px rgba(70,197,155,.12); }

.login-card { flex:1; padding:58px 52px 44px; background:#fbfcfd; }
.card-title { margin-bottom:8px; color:#152334; font-size:25px; letter-spacing:-.02em; }
.card-sub { margin-bottom:28px; color:#728393; }
.login-label { margin:15px 0 7px; color:#496071; font-weight:600; }
.login-input { height:44px; border-color:#cfd9e1; border-radius:7px; color:#152334; background:#fff; transition:border-color .18s, box-shadow .18s; }
.login-input:focus { border-color:#1683ff; box-shadow:0 0 0 4px rgba(22,131,255,.12); }
.login-error { min-height:24px; margin-top:11px; color:#c65353; }
.login-btn { height:45px; margin-top:7px; border-radius:7px; background:#1683ff; box-shadow:0 8px 18px rgba(22,131,255,.20); letter-spacing:.16em; transition:transform .18s, background .18s, box-shadow .18s; }
.login-btn:hover:not(:disabled) { opacity:1; background:#0a6bd8; box-shadow:0 10px 22px rgba(22,131,255,.25); transform:translateY(-1px); }
.quick-accounts { margin-top:26px; padding-top:18px; border-top:1px solid #e5ebef; gap:8px; }
.quick-label { color:#81919e; }
.quick-chip { padding:5px 12px; border-color:#cbdce9; border-radius:999px; background:#f1f7fb; color:#246b9e; transition:all .18s; }
.quick-chip:hover { border-color:#80b5db; background:#e5f2fb; color:#0b5e9b; transform:translateY(-1px); }

@media (max-width: 720px) {
  .login-view { align-items:flex-start; padding:18px; }
  .login-panel { width:100%; min-height:0; margin:auto 0; border-radius:12px; }
  .login-brand { display:block; padding:28px 24px 24px; border-right:0; border-bottom:1px solid rgba(255,255,255,.10); }
  .brand-title { font-size:18px; }
  .login-mark { width:32px; height:32px; font-size:18px; }
  .brand-sub { margin:12px 0 0; font-size:12px; }
  .brand-points { display:none; }
  .login-card { padding:28px 24px 26px; }
  .card-title { font-size:22px; }
}
.login-view .login-panel { width:min(100%,1060px); border-radius:18px; background:#102d39; }
.login-view .login-brand { position:relative; padding:42px 42px 30px; justify-content:flex-start; background:#102d39; overflow:hidden; }
.login-eyebrow { margin-bottom:26px; color:#83c7c4; font-size:11px; letter-spacing:.16em; }
.login-view .brand-title { position:relative; z-index:1; font-size:24px; line-height:1.65; }
.login-view .login-mark { background:#13878a; flex:none; box-shadow:none; }
.login-view .brand-sub { position:relative; z-index:1; margin:16px 0 0; font-size:11px; line-height:1.8; color:#9dbcc5; }
.login-factory { display:block; width:calc(100% + 84px); max-width:none; height:265px; margin:0 -42px -30px; object-fit:cover; object-position:60% 60%; mask-image:linear-gradient(transparent,#000 20%,#000 85%,transparent); }
.login-view .brand-points { position:relative; margin-top:auto; padding-top:24px; font-size:11px; color:#b2ccd1; }
.login-view .brand-points li { margin-bottom:10px; }
.login-view .login-card { padding:54px 48px 44px; background:#fff; }
.login-kicker { color:#0a8183; font-size:11px; letter-spacing:.12em; margin-bottom:12px; }
.login-view .card-title { height:auto; padding:0; border:0; margin:0 0 10px; font-size:29px; }
.login-view .card-sub { font-size:12px; line-height:1.8; }
.login-view .login-input { height:46px; background:#f9fbfb; border-color:#d9e4e5; }
.login-view .login-input:focus { background:#fff; border-color:#168d89; box-shadow:0 0 0 3px #087f8118; }
.login-view .login-btn { height:46px; background:#087f81; box-shadow:0 5px 12px #087f811a; letter-spacing:.04em; }
.login-view .login-btn:hover:not(:disabled) { background:#066467; box-shadow:0 7px 16px #087f8126; }
.login-view .quick-chip { color:#287d7c; background:#f1f8f6; border-color:#d5e7e3; }
.login-view .quick-chip:hover { color:#066467; background:#e3f2ee; border-color:#9ac9bf; }
@media (max-width:720px) {
  .login-view .login-panel { flex-direction:column; }
  .login-view .login-brand { padding:26px; }.login-eyebrow { margin-bottom:12px; }
  .login-view .brand-title { font-size:18px; }.login-view .brand-sub { font-size:10px; margin-top:10px; }
  .login-factory { display:none; }.login-view .login-card { padding:30px 26px; }
  .login-view .card-title { font-size:25px; }
}
@media (min-width:721px) and (max-width:1000px) {
  .login-view .login-brand { padding:32px; }
  .login-view .login-card { padding:40px 32px; }
  .login-factory { width:calc(100% + 64px); margin-left:-32px; margin-right:-32px; }
}
</style>

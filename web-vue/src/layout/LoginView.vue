<template>
  <div class="login-view">
    <div class="login-bg" aria-hidden="true"></div>
    <div class="login-shade" aria-hidden="true"></div>

    <header class="login-top">
      <span class="login-mark" aria-hidden="true"><img src="/brand-mark.svg" alt="" width="22" height="22"></span>
      <span class="login-top-name">柔性作业车间调度平台</span>
      <span class="login-top-tag">FJSP OPS / 智能制造</span>
    </header>

    <main class="login-center">
      <form class="login-card" @submit.prevent="submit">
        <span class="login-kicker">生产调度工作空间</span>
        <h1 class="card-title">欢迎回来</h1>
        <p class="card-sub">登录控制台，开启高效有序的生产协作</p>

        <label class="login-label" for="loginUsername">用户名</label>
        <input id="loginUsername" class="login-input" v-model="username" autocomplete="username" required autofocus :disabled="busy"
               placeholder="请输入用户名">

        <label class="login-label" for="loginPassword">密码</label>
        <div class="password-field">
          <input id="loginPassword" class="login-input" v-model="password" :type="showPassword ? 'text' : 'password'"
                 autocomplete="current-password" required placeholder="请输入密码" :disabled="busy">
          <button class="password-toggle" type="button" :aria-label="showPassword ? '隐藏密码' : '显示密码'"
                  :aria-pressed="showPassword" aria-controls="loginPassword" @click="showPassword = !showPassword">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
              <circle cx="12" cy="12" r="3" />
              <path v-if="!showPassword" d="m3 3 18 18" />
            </svg>
          </button>
        </div>

        <label class="login-label" for="loginCaptcha">图形验证码</label>
        <div class="captcha-row">
          <input id="loginCaptcha" class="login-input" v-model="captchaCode" autocomplete="off" autocapitalize="characters"
                 spellcheck="false" maxlength="4" required placeholder="请输入验证码" aria-describedby="captchaHint"
                 :disabled="busy || captchaLoading">
          <button class="captcha-image" type="button" :disabled="busy || captchaLoading" @click="refreshCaptcha()"
                  aria-label="刷新图形验证码" :aria-busy="captchaLoading">
            <img v-if="captchaImage && !captchaLoading" :src="captchaImage" alt="图形验证码" width="136" height="46">
            <span v-else>{{ captchaLoading ? '加载中…' : '点击重试' }}</span>
          </button>
        </div>
        <p id="captchaHint" class="captcha-hint">不区分大小写，点击图片可换一张</p>

        <div class="login-error" role="status" aria-live="polite">{{ error }}</div>

        <button class="login-btn" type="submit" :disabled="busy || captchaLoading || !captchaId">
          {{ busy ? '登录中…' : '进入控制台 →' }}
        </button>
      </form>
    </main>

    <footer class="login-foot">FJSP · 基线排程 · 动态重调度 · 方案对比 · 审核发布 · 执行反馈</footer>
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
const showPassword = ref(false);
const captchaId = ref('');
const captchaCode = ref('');
const captchaImage = ref('');
const captchaLoading = ref(false);

async function refreshCaptcha(preserveError = false) {
  if (captchaLoading.value) return;
  if (!preserveError) error.value = '';
  captchaLoading.value = true;
  captchaId.value = '';
  captchaCode.value = '';
  captchaImage.value = '';
  try {
    const challenge = await auth.loadCaptcha();
    captchaId.value = challenge.captchaId;
    captchaImage.value = challenge.image;
  } catch (e) {
    error.value = [error.value, errMsg(e)].filter(Boolean).join('；');
  } finally {
    captchaLoading.value = false;
  }
}

onMounted(() => {
  if (route.query.expired) error.value = '登录已过期，请重新登录';
  refreshCaptcha(true);
});

async function submit() {
  if (busy.value || captchaLoading.value || !captchaId.value) return;
  error.value = '';
  busy.value = true;
  try {
    await auth.login(username.value.trim(), password.value, captchaId.value, captchaCode.value.trim());
    showPassword.value = false;
    router.replace({ name: 'board' });
  } catch (e) {
    error.value = errMsg(e) + (e && e.code ? '（' + e.code + '）' : '');
    await refreshCaptcha(true);
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
/* 全屏背景图 + 居中玻璃质感登录卡 */
.login-view { position:fixed; inset:0; z-index:1000; display:flex; flex-direction:column; overflow:auto; background:#0b1a24; color:#e8f1f3; }
.login-bg { position:absolute; inset:-24px; background:url('/images/factory-control.webp') center 58% / cover no-repeat;
  filter:saturate(1.05); animation:login-drift 28s ease-in-out infinite alternate; }
.login-shade { position:absolute; inset:0;
  background:radial-gradient(ellipse 60% 70% at 50% 50%, rgba(8,22,32,.35), rgba(8,22,32,.82) 70%),
             linear-gradient(180deg, rgba(8,22,32,.55), rgba(8,22,32,.15) 30%, rgba(8,22,32,.25) 70%, rgba(8,22,32,.85)); }
@keyframes login-drift { from { transform:scale(1.02) translate(0,0); } to { transform:scale(1.08) translate(-1%,-1%); } }

.login-top { position:relative; z-index:1; display:flex; align-items:center; gap:12px; padding:24px 36px; }
.login-mark { display:grid; place-items:center; width:36px; height:36px; border-radius:10px; background:#13878a; box-shadow:0 6px 16px rgba(19,135,138,.35); }
.login-top-name { font-size:17px; font-weight:600; letter-spacing:.02em; }
.login-top-tag { margin-left:6px; padding-left:12px; border-left:1px solid rgba(255,255,255,.22); color:#9ec9cb; font-size:11px; letter-spacing:.14em; }

.login-center { position:relative; z-index:1; flex:1; display:grid; place-items:center; padding:12px 20px 24px; }
.login-card { display:flex; flex-direction:column; width:min(100%, 420px); padding:38px 36px 32px; border:1px solid rgba(255,255,255,.55); border-radius:18px;
  background:rgba(255,255,255,.9); color:#152334; backdrop-filter:blur(18px) saturate(1.3); -webkit-backdrop-filter:blur(18px) saturate(1.3);
  box-shadow:0 30px 80px rgba(0,0,0,.45), 0 0 0 1px rgba(19,135,138,.08); animation:login-rise .6s cubic-bezier(.2,.8,.2,1) both; }
@keyframes login-rise { from { opacity:0; transform:translateY(16px) scale(.985); } to { opacity:1; transform:none; } }

.login-kicker { margin-bottom:10px; color:#0a8183; font-size:11px; letter-spacing:.12em; }
.card-title { margin:0 0 8px; font-size:28px; font-weight:700; letter-spacing:-.01em; }
.card-sub { margin:0 0 18px; color:#5f7280; font-size:12.5px; line-height:1.8; }
.login-label { display:block; margin:14px 0 7px; color:#405766; font-size:13px; font-weight:600; }
.login-input { width:100%; height:46px; padding:0 14px; box-sizing:border-box; border:1px solid #d5e1e3; border-radius:9px; background:#f7fafa;
  color:#152334; font-size:14px; transition:border-color .18s, box-shadow .18s, background .18s; }
.login-input:focus { outline:none; background:#fff; border-color:#168d89; box-shadow:0 0 0 3px rgba(8,127,129,.14); }
.login-input:disabled { opacity:.7; cursor:wait; }

.password-field { position:relative; }
.password-field .login-input { padding-right:48px; }
.password-toggle { position:absolute; top:1px; right:1px; display:grid; place-items:center; width:44px; height:calc(100% - 2px);
  border:0; border-radius:9px; background:transparent; color:#496071; cursor:pointer; }
.password-toggle svg { width:20px; height:20px; }
.password-toggle:hover { color:#066467; background:#eef6f5; }

.captcha-row { display:flex; align-items:center; gap:12px; }
.captcha-row .login-input { flex:1; min-width:0; }
.captcha-image { flex:0 0 136px; height:46px; padding:0; overflow:hidden; border:1px solid #d5e1e3; border-radius:9px; background:#eff7f6; color:#496071; cursor:pointer; }
.captcha-image img { display:block; width:100%; height:100%; }
.captcha-image:hover:not(:disabled) { border-color:#168d89; }
.captcha-image:disabled { cursor:wait; }
.captcha-hint { margin:8px 0 0; color:#5f7280; font-size:12px; }

.login-error { min-height:22px; margin-top:10px; color:#c24646; font-size:13px; }
.login-btn { height:46px; margin-top:6px; border:0; border-radius:9px; background:linear-gradient(90deg,#087f81,#11979a); color:#fff;
  font-size:15px; letter-spacing:.06em; cursor:pointer; box-shadow:0 8px 20px rgba(8,127,129,.3); transition:transform .18s, box-shadow .18s, filter .18s; }
.login-btn:hover:not(:disabled) { filter:brightness(1.06); transform:translateY(-1px); box-shadow:0 12px 26px rgba(8,127,129,.36); }
.login-btn:active:not(:disabled) { transform:translateY(0); }
.login-btn:disabled { opacity:.6; cursor:not-allowed; }
.password-toggle:focus-visible, .captcha-image:focus-visible, .login-btn:focus-visible { outline:2px solid #087f81; outline-offset:3px; }

.login-foot { position:relative; z-index:1; padding:0 20px 22px; color:rgba(220,236,238,.7); font-size:11.5px; letter-spacing:.06em; text-align:center; }

@media (max-width:640px) {
  .login-top { padding:18px 20px; }
  .login-top-tag { display:none; }
  .login-card { padding:30px 22px 26px; border-radius:14px; }
  .card-title { font-size:24px; }
}
@media (prefers-reduced-motion:reduce) {
  .login-bg, .login-card { animation:none; }
  .login-btn, .login-input { transition:none; }
}
</style>

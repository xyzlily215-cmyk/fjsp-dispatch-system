import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPinia, setActivePinia } from 'pinia';

globalThis.location = { origin: 'http://127.0.0.1:5175', hostname: '127.0.0.1', search: '' };
const saved = new Map();
globalThis.localStorage = {
  getItem: key => saved.get(key) ?? null,
  setItem: (key, value) => saved.set(key, value),
  removeItem: key => saved.delete(key),
};
// Node ESM 需要显式文件路径；应用继续由 Vite 解析现有目录导入。
const source = readFileSync(new URL('../src/stores/auth.js', import.meta.url), 'utf8')
  .replace("'pinia'", JSON.stringify(import.meta.resolve('pinia')))
  .replace("'../api'", JSON.stringify(new URL('../src/api/index.js', import.meta.url).href));
const { useAuthStore } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

test('验证码不缓存，登录提交完整凭据并保留 ADMIN 全权限', async () => {
  setActivePinia(createPinia());
  const auth = useAuthStore();
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({ code: 'OK', data: url.endsWith('/captcha')
      ? { captchaId: 'challenge-1', image: 'data:image/png;base64,image' }
      : { token: 'token', username: 'admin', role: 'ADMIN', displayName: '管理员' } }) };
  };
  assert.equal((await auth.loadCaptcha()).captchaId, 'challenge-1');
  assert.equal(requests[0].options.cache, 'no-store');
  await auth.login('admin', 'password', 'challenge-1', 'ABCD');
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    username: 'admin', password: 'password', captchaId: 'challenge-1', captchaCode: 'ABCD',
  });
  assert.equal(auth.hasAnyRole('DISPATCHER'), true);
  assert.equal(auth.hasAnyRole('REVIEWER'), true);
  assert.equal(auth.hasAnyRole('PRODUCTION_MANAGER'), true);
  assert.equal(saved.get('fjsp.token'), 'token');
  auth.logout();
  assert.equal(saved.has('fjsp.token'), false);
});

test('验证码校验失败不创建登录会话，普通角色不能继承权限', async () => {
  setActivePinia(createPinia());
  const auth = useAuthStore();
  globalThis.fetch = async () => ({ ok: false, status: 400,
    json: async () => ({ code: 'E_CAPTCHA_INVALID', message: '验证码错误或已过期' }) });
  await assert.rejects(auth.login('admin', 'password', 'old-id', 'wrong'),
    e => e.code === 'E_CAPTCHA_INVALID');
  assert.equal(auth.isLoggedIn, false);
  auth.user = { role: 'DISPATCHER' };
  assert.equal(auth.hasAnyRole('DISPATCHER'), true);
  assert.equal(auth.hasAnyRole('ADMIN', 'REVIEWER'), false);
});

test('验证码网络失败提供可重试的错误', async () => {
  setActivePinia(createPinia());
  globalThis.fetch = async () => { throw new Error('offline'); };
  await assert.rejects(useAuthStore().loadCaptcha(), e => e.code === 'E_NETWORK');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

let caseNumber = 0;

async function requestFrom(page, api, storedBase) {
  const pageUrl = new URL(page);
  globalThis.location = {
    origin: pageUrl.origin, hostname: pageUrl.hostname,
    search: api ? '?api=' + encodeURIComponent(api) : '',
  };
  globalThis.localStorage = {
    getItem: (key) => key === 'fjsp.token' ? 'test-token'
      : key === 'fjsp.apiBase' ? storedBase : null,
  };
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, authorization: options.headers.Authorization };
    return { status: 200, json: async () => ({ code: 'OK', data: {} }) };
  };
  const { API_BASE, Api } = await import(`../src/api/index.js?case=${++caseNumber}`);
  await Api.dashboard();
  return { base: API_BASE, ...request };
}

test('external link cannot redirect authenticated requests', async () => {
  const request = await requestFrom('http://127.0.0.1:8082/index.html',
    'https://attacker.invalid/api/v1');
  assert.equal(request.url, 'http://localhost:8081/api/v1/dashboard');
  assert.equal(request.authorization, 'Bearer test-token');
});

test('local static deployment can access loopback API', async () => {
  const request = await requestFrom('http://127.0.0.1:8082/index.html',
    'http://localhost:8081/api/v1');
  assert.equal(request.url, 'http://localhost:8081/api/v1/dashboard');
});

test('vite proxy and same-origin production API remain available', async () => {
  for (const page of ['http://127.0.0.1:5174/', 'https://app.example.test/']) {
    const base = new URL('/api/v1', page).href;
    const request = await requestFrom(page, base);
    assert.equal(request.url, base + '/dashboard');
  }
});

test('invalid links fall back to explicitly configured base', async () => {
  for (const api of ['https://attacker.invalid/api/v1',
    'http://localhost.attacker.invalid/api/v1', 'javascript:alert(1)',
    'http://localhost:8081/api/v1?extra=1', 'http://localhost:8081/api/v1#frag',
    'http://user:pass@localhost:8081/api/v1']) {
    const request = await requestFrom('http://127.0.0.1:8082/', api,
      'https://trusted.example.test/api/v1');
    assert.equal(request.url, 'https://trusted.example.test/api/v1/dashboard');
  }
});

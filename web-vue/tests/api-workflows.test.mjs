import assert from 'node:assert/strict';
import { test } from 'node:test';

const tokenStore = new Map([['fjsp.token', 'test-token']]);
globalThis.location = { origin: 'http://127.0.0.1:8082', hostname: '127.0.0.1', search: '' };
globalThis.localStorage = { getItem: (key) => tokenStore.get(key) ?? null };

const { Api, setUnauthorizedHandler } = await import('../src/api/index.js');
const { agentPermission, openAgentStream } = await import('../src/api/agent.ts');

test('expired login calls unauthorized handler and rejects the request', async () => {
  let called = 0;
  setUnauthorizedHandler(() => { called += 1; });
  globalThis.fetch = async () => ({ status: 401, json: async () => ({ code: 'E_UNAUTHORIZED' }) });

  await assert.rejects(Api.task('t1'), { code: 'E_UNAUTHORIZED' });
  assert.equal(called, 1);
  setUnauthorizedHandler(null);
});

test('approval sends actor token and one-time verdict without changing its meaning', async () => {
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return { status: 200, ok: true, json: async () => ({ ok: true, verdict: 'allowed-once' }) };
  };
  const result = await agentPermission({ conversationId: 'c1', requestId: 'r1', verdict: 'allowed-once' });

  assert.equal(result.verdict, 'allowed-once');
  assert.equal(request.url, 'http://127.0.0.1:4178/agent-api/permission');
  assert.equal(request.options.headers.Authorization, 'Bearer test-token');
  assert.deepEqual(JSON.parse(request.options.body), {
    conversationId: 'c1', requestId: 'r1', verdict: 'allowed-once',
  });
});

test('task status is returned intact and SSE ticket stays scoped to the task', async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return { status: 200, json: async () => ({ code: 'OK', data: calls.length === 1
      ? { taskId: 't1', status: 'FAILED', errorMessage: '任务执行队列已满，请稍后人工重试' }
      : { ticket: 'ticket/with spaces' } }) };
  };
  assert.equal((await Api.task('t1')).status, 'FAILED');
  assert.equal(await Api.taskEventsUrl('t1'),
    'http://localhost:8081/api/v1/schedule-tasks/t1/events?ticket=ticket%2Fwith%20spaces');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer test-token');
  assert.ok(calls[1].options.headers['Idempotency-Key']);
});

test('closed SSE stream fetches a fresh ticket and reports expired login', async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = [];
  const sources = [];
  let tickets = 0;
  let authErrors = 0;
  globalThis.setTimeout = (callback) => { timers.push(callback); return timers.length; };
  globalThis.clearTimeout = () => {};
  globalThis.fetch = async () => ({ status: 200, ok: true,
    json: async () => ({ ticket: `ticket-${++tickets}` }) });
  globalThis.EventSource = class {
    static CLOSED = 2;
    readyState = 1;
    constructor(url) { this.url = url; sources.push(this); }
    addEventListener(type, handler) { this.listeners ??= {}; this.listeners[type] = handler; }
    close() { this.readyState = 2; }
  };
  let close;
  try {
    close = openAgentStream('c1', { onAuthError: () => { authErrors += 1; } }, { sinceId: 42 });
    await new Promise((resolve) => originalSetTimeout(resolve, 0));
    assert.match(sources[0].url, /ticket=ticket-1&sinceId=42$/);
    sources[0].listeners.assistant_delta({ data: '{"delta":"hello"}', lastEventId: '43' });
    sources[0].readyState = EventSource.CLOSED;
    sources[0].onerror();
    timers.shift()();
    await new Promise((resolve) => originalSetTimeout(resolve, 0));
    assert.match(sources[1].url, /ticket=ticket-2&sinceId=43$/);
    tokenStore.delete('fjsp.token');
    sources[1].readyState = EventSource.CLOSED;
    sources[1].onerror();
    timers.shift()();
    assert.equal(authErrors, 1);
    assert.equal(sources.length, 2);
  } finally {
    close?.();
    tokenStore.set('fjsp.token', 'test-token');
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

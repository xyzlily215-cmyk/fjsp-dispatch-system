/* API 访问层：统一响应包 {requestId,timestamp,code,message,data} */
const API_BASE = (new URLSearchParams(location.search).get('api'))
  || localStorage.getItem('fjsp.apiBase')
  || 'http://localhost:8081/api/v1';

class ApiError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

async function api(path, options = {}) {
  const opts = { method: options.method || 'GET', headers: {}, ...options };
  opts.headers['X-Source'] = 'web';
  const token = Auth.token();
  if (token) opts.headers['Authorization'] = 'Bearer ' + token;
  if (opts.body && typeof opts.body !== 'string') {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  if (opts.method !== 'GET' && !opts.headers['Idempotency-Key']) {
    opts.headers['Idempotency-Key'] = crypto.randomUUID();
  }
  let resp;
  try {
    resp = await fetch(API_BASE + path, opts);
  } catch (e) {
    throw new ApiError('E_NETWORK', '无法连接业务服务 ' + API_BASE + '：' + e.message);
  }
  let body = null;
  try { body = await resp.json(); } catch (e) { /* 非 JSON */ }
  if (!body) throw new ApiError('E_HTTP_' + resp.status, 'HTTP ' + resp.status);
  if (resp.status === 401 || body.code === 'E_UNAUTHORIZED') {
    Auth.handleUnauthorized();
    throw new ApiError('E_UNAUTHORIZED', body.message || '未认证或凭证已失效');
  }
  if (body.code !== 'OK') throw new ApiError(body.code, body.message || body.code);
  return body.data;
}

const Api = {
  dashboard: () => api('/dashboard'),
  machines: () => api('/machines'),
  orders: () => api('/orders'),
  templates: () => api('/process-templates'),
  /* 列表端点统一 Page 包络 {items,page,size,total,totalPages}；xxx() 取 items 数组，xxxPage() 取完整分页包络 */
  tasks: async () => (await api('/schedule-tasks')).items,
  tasksPage: (page = 0, size = 20) => api(`/schedule-tasks?page=${page}&size=${size}`),
  task: (id) => api('/schedule-tasks/' + id),
  createTask: (payload) => api('/schedule-tasks', { method: 'POST', body: payload }),
  event: (id) => api('/events/' + id),
  eventsPage: ({ page = 0, size = 10, status, eventType } = {}) => {
    const q = new URLSearchParams({ page, size });
    if (status) q.set('status', status);
    if (eventType) q.set('eventType', eventType);
    return api('/events?' + q);
  },
  newOrderEvent: (payload) => api('/events/new-orders', { method: 'POST', body: payload }),
  breakdownEvent: (payload) => api('/events/breakdowns', { method: 'POST', body: payload }),
  planVersions: async () => (await api('/plan-versions')).items,
  planVersionsPage: (page = 0, size = 20) => api(`/plan-versions?page=${page}&size=${size}`),
  planVersion: (id) => api('/plan-versions/' + id),
  planVersionOperations: (id, page = 0, size = 5000) =>
    api(`/plan-versions/${encodeURIComponent(id)}/operations?page=${page}&size=${size}`),
  diff: (id, baselineId) => api('/plan-versions/' + id + '/diff?baselineVersionId=' + encodeURIComponent(baselineId)),
  submitReview: (id, version) => api('/plan-versions/' + id + '/submit-review', { method: 'POST', body: { version } }),
  revise: (id, version) => api('/plan-versions/' + id + '/revise', { method: 'POST', body: { version } }),
  review: (id, payload) => api('/plan-versions/' + id + '/review', { method: 'POST', body: payload }),
  publish: (id, version) => api('/plan-versions/' + id + '/publish', { method: 'POST', body: { version } }),
  execution: (operationId, payload) => api('/operations/' + encodeURIComponent(operationId) + '/execution', { method: 'POST', body: payload }),
  demoReset: () => api('/demo/reset', { method: 'POST', body: {} }),
  createMachine: (payload) => api('/machines', { method: 'POST', body: payload }),
  updateMachine: (id, payload) => api('/machines/' + encodeURIComponent(id), { method: 'PUT', body: payload }),
  setMachineStatus: (id, status) => api('/machines/' + encodeURIComponent(id) + '/status', { method: 'POST', body: { status } }),
  calendarIntervals: (calendarId) => api('/calendars/' + encodeURIComponent(calendarId) + '/intervals'),
  addCalendarInterval: (calendarId, payload) => api('/calendars/' + encodeURIComponent(calendarId) + '/intervals', { method: 'POST', body: payload }),
  createTemplate: (payload) => api('/process-templates', { method: 'POST', body: payload }),
  setTemplateStatus: (id, status) => api('/process-templates/' + encodeURIComponent(id) + '/status', { method: 'POST', body: { status } }),
  copyTemplate: (id) => api('/process-templates/' + encodeURIComponent(id) + '/copy', { method: 'POST', body: {} }),
  createOrder: (payload) => api('/orders', { method: 'POST', body: payload }),
  updateOrder: (id, payload) => api('/orders/' + encodeURIComponent(id), { method: 'PUT', body: payload }),
};

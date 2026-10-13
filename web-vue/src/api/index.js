/* API 访问层：统一响应包 {requestId,timestamp,code,message,data}（自旧版 web/js/api.js 逐行移植）
 * 与旧版的行为契约：X-Source 头、非 GET 自动 Idempotency-Key、15s 超时、
 * 401 → 已注册的 unauthorized 回调、下载走 Blob + Content-Disposition、上传走 FormData。
 * token 直接读 localStorage（与 stores/auth.js 同一 key），避免模块循环依赖。 */
// URL 参数来自外部链接，不能直接决定携带 JWT 的请求目标。
// 仅允许同源 API，或本地页面访问本机 API（含 Vite 同源代理和 8082 → 8081）。
function trustedLinkApiBase(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    const loopback = (host) => ['localhost', '127.0.0.1', '[::1]'].includes(host);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
        || url.search || url.hash || url.pathname !== '/api/v1') return null;
    if (url.origin === location.origin
        || (loopback(location.hostname) && loopback(url.hostname))) return url.href;
  } catch { /* 无效 URL 不作为 API 地址 */ }
  return null;
}

export const API_BASE = trustedLinkApiBase(new URLSearchParams(location.search).get('api'))
  || localStorage.getItem('fjsp.apiBase')
  || 'http://localhost:8081/api/v1';

const TOKEN_KEY = 'fjsp.token';

export class ApiError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

let unauthorizedHandler = null;
export function setUnauthorizedHandler(fn) { unauthorizedHandler = fn; }
function onUnauthorized() { if (unauthorizedHandler) unauthorizedHandler(); }

function currentToken() { return localStorage.getItem(TOKEN_KEY); }

/* fetch 统一 15s 超时（Chrome/Safari 均支持 AbortSignal.timeout）；
 * 调度任务提交为异步任务模式（提交即返回 taskId，前端轮询进度），无同步长耗时接口需要豁免。 */
const FETCH_TIMEOUT_MS = 15000;
function networkErrorText(e) {
  if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
    return `请求超时（${FETCH_TIMEOUT_MS / 1000}s）：业务服务无响应，请检查 ${API_BASE} 是否正常运行`;
  }
  return '无法连接业务服务 ' + API_BASE + '：' + (e && e.message);
}

async function api(path, options = {}) {
  const opts = { method: options.method || 'GET', headers: {}, ...options };
  opts.headers['X-Source'] = 'web';
  const token = currentToken();
  if (token) opts.headers['Authorization'] = 'Bearer ' + token;
  if (opts.body && typeof opts.body !== 'string') {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  if (opts.method !== 'GET' && !opts.headers['Idempotency-Key']) {
    opts.headers['Idempotency-Key'] = crypto.randomUUID();
  }
  opts.signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(API_BASE + path, opts);
  } catch (e) {
    throw new ApiError('E_NETWORK', networkErrorText(e));
  }
  let body = null;
  try { body = await resp.json(); } catch (e) { /* 非 JSON */ }
  if (!body) throw new ApiError('E_HTTP_' + resp.status, 'HTTP ' + resp.status);
  if (resp.status === 401 || body.code === 'E_UNAUTHORIZED') {
    onUnauthorized();
    throw new ApiError('E_UNAUTHORIZED', body.message || '未认证或凭证已失效');
  }
  if (body.code !== 'OK') throw new ApiError(body.code, body.message || body.code);
  return body.data;
}

export const Api = {
  /* F-01 看板：可选 planVersionId（id 或 versionCode）与时间窗口 window=SHIFT/LAST_24H/CUSTOM（CUSTOM 需 from/to ISO 时间） */
  dashboard: ({ planVersionId, window, from, to } = {}) => {
    const q = new URLSearchParams();
    if (planVersionId) q.set('planVersionId', planVersionId);
    if (window) q.set('window', window);
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    const qs = q.toString();
    return api('/dashboard' + (qs ? '?' + qs : ''));
  },
  machines: () => api('/machines'),
  orders: () => api('/orders'),
  templates: () => api('/process-templates'),
  /* 列表端点统一 Page 包络 {items,page,size,total,totalPages}；xxx() 取 items 数组，xxxPage() 取完整分页包络 */
  tasks: async () => (await api('/schedule-tasks')).items,
  tasksPage: (page = 0, size = 20) => api(`/schedule-tasks?page=${page}&size=${size}`),
  task: (id) => api('/schedule-tasks/' + id),
  createTask: (payload) => api('/schedule-tasks', { method: 'POST', body: payload }),
  cancelTask: (id) => api('/schedule-tasks/' + encodeURIComponent(id) + '/cancel', { method: 'POST' }),
  retryTask: (id) => api('/schedule-tasks/' + encodeURIComponent(id) + '/retry', { method: 'POST' }),
  /* EventSource 无法自定义请求头：先用正常 JWT 换取 60s 一次性 stream ticket，
   * SSE 地址只携带 ticket（一次性、绑定任务），避免 JWT 进入 URL/浏览器历史/代理日志 */
  taskEventsUrl: async (id) => {
    const t = await api('/schedule-tasks/' + encodeURIComponent(id) + '/events/ticket',
      { method: 'POST' });
    return API_BASE + '/schedule-tasks/' + encodeURIComponent(id)
      + '/events?ticket=' + encodeURIComponent(t.ticket);
  },
  event: (id) => api('/events/' + id),
  /* F-08 重调度向导：影响范围预览（硬/软锁定数、影响工序/订单、两种模式预计规模） */
  reschedulePreview: (eventId, { planVersionId, freezeWindowMinutes } = {}) => {
    const q = new URLSearchParams();
    if (planVersionId) q.set('planVersionId', planVersionId);
    if (freezeWindowMinutes !== undefined && freezeWindowMinutes !== null && freezeWindowMinutes !== '') {
      q.set('freezeWindowMinutes', freezeWindowMinutes);
    }
    const qs = q.toString();
    return api('/events/' + encodeURIComponent(eventId) + '/reschedule-preview' + (qs ? '?' + qs : ''));
  },
  eventsPage: ({ page = 0, size = 10, status, eventType } = {}) => {
    const q = new URLSearchParams({ page, size });
    if (status) q.set('status', status);
    if (eventType) q.set('eventType', eventType);
    return api('/events?' + q);
  },
  newOrderEvent: (payload) => api('/events/new-orders', { method: 'POST', body: payload }),
  breakdownEvent: (payload) => api('/events/breakdowns', { method: 'POST', body: payload }),
  /* F-07 事件生命周期：关闭（存在未终态任务返回 409）与修订（新事件 revisionOf 指向原事件） */
  closeEvent: (id) => api('/events/' + encodeURIComponent(id) + '/close', { method: 'POST' }),
  reviseEvent: (id, payload) => api('/events/' + encodeURIComponent(id) + '/revise', { method: 'POST', body: payload }),
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
  rollback: (id, remark) => api('/plan-versions/' + id + '/rollback', { method: 'POST', body: { remark } }),
  execution: (operationId, payload) => api('/operations/' + encodeURIComponent(operationId) + '/execution', { method: 'POST', body: payload }),
  executionTimeline: (operationId) => api('/operations/' + encodeURIComponent(operationId) + '/execution'),
  demoReset: () => api('/demo/reset', { method: 'POST', body: {} }),
  createMachine: (payload) => api('/machines', { method: 'POST', body: payload }),
  updateMachine: (id, payload) => api('/machines/' + encodeURIComponent(id), { method: 'PUT', body: payload }),
  setMachineStatus: (id, status) => api('/machines/' + encodeURIComponent(id) + '/status', { method: 'POST', body: { status } }),
  calendarIntervals: (calendarId) => api('/calendars/' + encodeURIComponent(calendarId) + '/intervals'),
  addCalendarInterval: (calendarId, payload) => api('/calendars/' + encodeURIComponent(calendarId) + '/intervals', { method: 'POST', body: payload }),
  /* F-02 日历版本：版本历史（入参可为任意版本 id）；删除区间同样生成新版本 */
  calendarVersions: (calendarId) => api('/calendars/' + encodeURIComponent(calendarId) + '/versions'),
  deleteCalendarInterval: (calendarId, intervalId) => api('/calendars/' + encodeURIComponent(calendarId) + '/intervals/' + encodeURIComponent(intervalId), { method: 'DELETE' }),
  createTemplate: (payload) => api('/process-templates', { method: 'POST', body: payload }),
  setTemplateStatus: (id, status) => api('/process-templates/' + encodeURIComponent(id) + '/status', { method: 'POST', body: { status } }),
  copyTemplate: (id) => api('/process-templates/' + encodeURIComponent(id) + '/copy', { method: 'POST', body: {} }),
  createOrder: (payload) => api('/orders', { method: 'POST', body: payload }),
  updateOrder: (id, payload) => api('/orders/' + encodeURIComponent(id), { method: 'PUT', body: payload }),
  /* F-04 订单修订：已排程订单的工艺字段变更走修订记录；修订历史查询 */
  createOrderRevision: (orderId, payload) => api('/orders/' + encodeURIComponent(orderId) + '/revisions', { method: 'POST', body: payload }),
  orderRevisions: (orderId) => api('/orders/' + encodeURIComponent(orderId) + '/revisions'),
  /* F-09 排程结果 CSV 导出（附件下载，携带 JWT） */
  exportPlanVersion: (id) => apiDownload('/plan-versions/' + encodeURIComponent(id) + '/export'),
  /* F-12 系统管理（仅 ADMIN）：用户管理 + 基础字典维护 */
  adminUsersPage: (page = 0, size = 20) => api(`/admin/users?page=${page}&size=${size}`),
  adminCreateUser: (payload) => api('/admin/users', { method: 'POST', body: payload }),
  adminUpdateUser: (id, payload) => api('/admin/users/' + encodeURIComponent(id), { method: 'PUT', body: payload }),
  adminSetUserStatus: (id, enabled) => api('/admin/users/' + encodeURIComponent(id) + '/status', { method: 'POST', body: { enabled } }),
  adminResetUserPassword: (id, password) => api('/admin/users/' + encodeURIComponent(id) + '/password', { method: 'POST', body: { password } }),
  adminConfigs: () => api('/admin/configs'),
  adminUpdateConfig: (key, configValue) => api('/admin/configs/' + encodeURIComponent(key), { method: 'PUT', body: { configValue } }),
  /* Agent 处置时间线（仅 ADMIN）：审计日志按 source/sessionId 过滤 */
  auditLogsPage: ({ page = 0, size = 20, source, sessionId } = {}) => {
    const q = new URLSearchParams({ page, size });
    if (source) q.set('source', source);
    if (sessionId) q.set('sessionId', sessionId);
    return api('/audit-logs?' + q);
  },
  /* F-05 批量导入（仅 ADMIN）：模板下载 / 预览（multipart 上传）/ 整批入库 */
  importTemplate: (type) => apiDownload('/import/templates/' + encodeURIComponent(type)),
  importPreview: (type, file) => apiUpload('/import/' + encodeURIComponent(type) + '/preview', file),
  importCommit: (type, batchCode) => api('/import/' + encodeURIComponent(type) + '/commit', { method: 'POST', body: { batchCode } }),
};

/* 附件下载：fetch 携带 JWT 头取 Blob 后触发浏览器保存（不能 <a href> 直连，会丢 Authorization 头）。
 * 文件名优先取 Content-Disposition 的 filename。 */
async function apiDownload(path) {
  const headers = { 'X-Source': 'web' };
  const token = currentToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;
  let resp;
  try {
    resp = await fetch(API_BASE + path, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (e) {
    throw new ApiError('E_NETWORK', networkErrorText(e));
  }
  if (!resp.ok) {
    let body = null;
    try { body = await resp.json(); } catch (e) { /* 非 JSON */ }
    if (resp.status === 401 || (body && body.code === 'E_UNAUTHORIZED')) {
      onUnauthorized();
      throw new ApiError('E_UNAUTHORIZED', (body && body.message) || '未认证或凭证已失效');
    }
    throw new ApiError((body && body.code) || 'E_HTTP_' + resp.status,
      (body && body.message) || ('HTTP ' + resp.status));
  }
  const blob = await resp.blob();
  const dispo = resp.headers.get('Content-Disposition') || '';
  const m = dispo.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
  const name = m ? decodeURIComponent(m[1].replace(/"$/, '')) : 'export.csv';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* 文件上传：FormData + JWT（不能走 api() 的 JSON 序列化，Content-Type 由浏览器带 boundary 自动生成）；
 * 响应仍是统一 ApiResponse 包络。 */
async function apiUpload(path, file) {
  const headers = { 'X-Source': 'web' };
  const token = currentToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const form = new FormData();
  form.append('file', file);
  let resp;
  try {
    resp = await fetch(API_BASE + path, { method: 'POST', headers, body: form, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (e) {
    throw new ApiError('E_NETWORK', networkErrorText(e));
  }
  let body = null;
  try { body = await resp.json(); } catch (e) { /* 非 JSON */ }
  if (!body) throw new ApiError('E_HTTP_' + resp.status, 'HTTP ' + resp.status);
  if (resp.status === 401 || body.code === 'E_UNAUTHORIZED') {
    onUnauthorized();
    throw new ApiError('E_UNAUTHORIZED', body.message || '未认证或凭证已失效');
  }
  if (body.code !== 'OK') throw new ApiError(body.code, body.message || body.code);
  return body.data;
}

/* 认证：JWT 登录、token/user 持久化、角色判断（服务端强制为准，前端仅控制展示） */
import { defineStore } from 'pinia';
import { API_BASE, ApiError } from '../api';

const TOKEN_KEY = 'fjsp.token';
const USER_KEY = 'fjsp.user';

export const ROLE_TEXT = {
  DISPATCHER: '调度员', REVIEWER: '审核员', PRODUCTION_MANAGER: '生产主管', ADMIN: '管理员',
};
export function roleText(role) { return ROLE_TEXT[role] || role || '-'; }

function readUser() {
  try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch (e) { return null; }
}

export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: localStorage.getItem(TOKEN_KEY),
    user: readUser(),
  }),
  getters: {
    isLoggedIn: (s) => !!s.token,
    role: (s) => (s.user ? s.user.role : null),
  },
  actions: {
    hasAnyRole(...roles) {
      return this.role === 'ADMIN' || roles.includes(this.role);
    },
    async login(username, password) {
      let resp;
      try {
        resp = await fetch(API_BASE + '/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Source': 'web' },
          body: JSON.stringify({ username, password }),
          signal: AbortSignal.timeout(15000),
        });
      } catch (e) {
        throw new ApiError('E_NETWORK',
          (e && (e.name === 'TimeoutError' || e.name === 'AbortError'))
            ? '请求超时（15s）：业务服务无响应，请检查 ' + API_BASE + ' 是否正常运行'
            : '无法连接业务服务 ' + API_BASE + '：' + (e && e.message));
      }
      const body = await resp.json().catch(() => null);
      if (!body || body.code !== 'OK') {
        throw new ApiError(body && body.code ? body.code : 'E_HTTP_' + resp.status,
          body && body.message ? body.message : '登录失败');
      }
      this.token = body.data.token;
      this.user = {
        username: body.data.username, role: body.data.role, displayName: body.data.displayName,
      };
      localStorage.setItem(TOKEN_KEY, this.token);
      localStorage.setItem(USER_KEY, JSON.stringify(this.user));
      return body.data;
    },
    clear() {
      this.token = null;
      this.user = null;
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    },
    /* 页面级定时器/SSE 由各视图组件 onBeforeUnmount 自行清理，无需全局钩子 */
    logout() { this.clear(); },
    handleUnauthorized() { this.clear(); },
  },
});

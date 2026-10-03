/* 认证：JWT 登录、token 存储、当前用户展示、角色可见性（服务端强制为准，此处仅控制展示） */
const Auth = {
  TOKEN_KEY: 'fjsp.token',
  USER_KEY: 'fjsp.user',

  token() { return localStorage.getItem(this.TOKEN_KEY); },
  user() {
    try { return JSON.parse(localStorage.getItem(this.USER_KEY)); } catch (e) { return null; }
  },
  role() { const u = this.user(); return u ? u.role : null; },
  hasAnyRole(...roles) {
    const r = this.role();
    return r === 'ADMIN' || roles.includes(r);
  },

  async login(username, password) {
    let resp;
    try {
      resp = await fetch(API_BASE + '/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Source': 'web' },
        body: JSON.stringify({ username, password }),
      });
    } catch (e) {
      throw new ApiError('E_NETWORK', '无法连接业务服务 ' + API_BASE + '：' + e.message);
    }
    const body = await resp.json().catch(() => null);
    if (!body || body.code !== 'OK') {
      throw new ApiError(body && body.code ? body.code : 'E_HTTP_' + resp.status,
        body && body.message ? body.message : '登录失败');
    }
    localStorage.setItem(this.TOKEN_KEY, body.data.token);
    localStorage.setItem(this.USER_KEY, JSON.stringify({
      username: body.data.username, role: body.data.role, displayName: body.data.displayName,
    }));
    return body.data;
  },

  clear() {
    localStorage.removeItem(this.TOKEN_KEY);
    localStorage.removeItem(this.USER_KEY);
  },

  logout() {
    this.clear();
    location.reload();
  },

  handleUnauthorized() {
    this.clear();
    this.showLogin('登录已过期，请重新登录');
  },

  showLogin(message) {
    document.querySelector('.app').style.display = 'none';
    const view = document.getElementById('loginView');
    view.style.display = 'flex';
    const err = document.getElementById('loginError');
    err.textContent = message || '';
    setTimeout(() => document.getElementById('loginUsername').focus(), 0);
  },

  hideLogin() {
    document.getElementById('loginView').style.display = 'none';
    document.querySelector('.app').style.display = '';
  },

  bindLoginForm(onSuccess) {
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('loginSubmit');
      const err = document.getElementById('loginError');
      err.textContent = '';
      btn.disabled = true;
      btn.textContent = '登录中…';
      try {
        await this.login(
          document.getElementById('loginUsername').value.trim(),
          document.getElementById('loginPassword').value);
        this.hideLogin();
        await onSuccess();
      } catch (ex) {
        err.textContent = errMsg(ex);
      } finally {
        btn.disabled = false;
        btn.textContent = '登 录';
      }
    });
  },

  renderUserBadge() {
    const u = this.user();
    if (!u) return;
    const el = document.getElementById('userBadge');
    const initial = (u.displayName || u.username || '?').charAt(0);
    el.innerHTML = `<span class="avatar">${esc(initial)}</span>`
      + `<span>${esc(u.displayName || u.username)} · ${esc(roleText(u.role))}</span>`
      + '<button class="btn small" id="logoutBtn" style="margin-left:8px">退出</button>';
    document.getElementById('logoutBtn').onclick = () => this.logout();
  },
};

const ROLE_TEXT = {
  DISPATCHER: '调度员', REVIEWER: '审核员', PRODUCTION_MANAGER: '生产主管', ADMIN: '管理员',
};
function roleText(role) { return ROLE_TEXT[role] || role || '-'; }

/* 按角色隐藏带 data-roles 的元素（如 "DISPATCHER,ADMIN"），动态渲染内容由 observer 兜底 */
function applyRoleVisibility(root) {
  (root.querySelectorAll ? root.querySelectorAll('[data-roles]') : []).forEach(el => {
    const roles = el.dataset.roles.split(',').map(s => s.trim());
    el.style.display = Auth.hasAnyRole(...roles) ? '' : 'none';
  });
}
new MutationObserver(mutations => {
  if (!Auth.token()) return;
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (node.nodeType !== 1) continue;
      if (node.matches && node.matches('[data-roles]')) applyRoleVisibility(node.parentNode || document.body);
      applyRoleVisibility(node);
    }
  }
}).observe(document.body, { childList: true, subtree: true });

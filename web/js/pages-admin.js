/* F-12 系统管理页（仅 ADMIN，服务端 /api/v1/admin/** 强制鉴权）：用户管理 + 基础字典维护 */

let adminUsersPageNo = 0;

/* ---------------- 用户管理 ---------------- */
registerPage('admin-users', ['系统管理', '用户管理'], async (el) => {
  el.innerHTML = loadingHtml('正在加载用户…');
  let page;
  try { page = await Api.adminUsersPage(adminUsersPageNo, 20); }
  catch (e) { el.innerHTML = errorBoxHtml(e, '用户列表加载失败'); return; }
  const users = page.items || [];

  el.innerHTML = `
    <div class="page-header"><div><h1>用户管理</h1><p>账号新增 / 编辑 / 启停 / 重置密码；停用后账号无法再登录</p></div>
      <div class="buttons"><button class="btn" onclick="renderCurrent()">&#8635; 刷新</button>
      <button class="btn primary" id="auAdd">+ 新增用户</button></div></div>
    <section class="card table-card"><div class="table-wrap"><table class="data-table">
      <thead><tr><th>用户名</th><th>显示名</th><th>角色</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead>
      <tbody>${users.map(u => `<tr>
        <td class="machine-name">${esc(u.username)}</td>
        <td>${esc(u.displayName || '-')}</td>
        <td>${esc(roleText(u.role))}</td>
        <td>${u.enabled ? tag('启用', 'green') : tag('停用', 'gray')}</td>
        <td>${fmtDateTime(u.createdAt)}</td>
        <td class="table-actions">
          <a data-act="edit" data-id="${esc(u.id)}">编辑</a>
          ${u.enabled
            ? `<a data-act="off" data-id="${esc(u.id)}" style="color:#e6a23c">停用</a>`
            : `<a data-act="on" data-id="${esc(u.id)}" style="color:#67c23a">启用</a>`}
          <a data-act="reset" data-id="${esc(u.id)}" style="color:#d54941">重置密码</a>
        </td></tr>`).join('') || '<tr><td colspan="6" style="text-align:center;color:#909399">暂无用户</td></tr>'}</tbody>
    </table></div>${pagerHtml(page)}</section>`;
  bindPager(el, (delta) => { adminUsersPageNo = Math.max(0, adminUsersPageNo + delta); renderCurrent(); });

  const ROLE_OPTIONS = ['DISPATCHER', 'REVIEWER', 'PRODUCTION_MANAGER', 'ADMIN']
    .map(r => `<option value="${r}">${esc(roleText(r))}（${r}）</option>`).join('');

  document.getElementById('auAdd').onclick = () => {
    openModal({
      title: '新增用户', okText: '创建',
      body: `
      <div class="form-grid">
        <label class="required">用户名</label><input class="field" id="ufName" placeholder="2-32 位字母、数字或 _ . -">
        <label class="required">显示名</label><input class="field" id="ufDisplay" placeholder="如 调度员乙">
        <label class="required">角色</label><select class="field" id="ufRole">${ROLE_OPTIONS}</select>
        <label class="required">初始密码</label><input class="field" id="ufPassword" type="password" autocomplete="new-password" placeholder="至少 8 位，含字母与数字">
      </div>
      <p class="hint">创建后请将初始密码告知使用人；密码至少 8 位且须同时包含字母与数字。</p>`,
      onOk: async () => {
        const username = document.getElementById('ufName').value.trim();
        const displayName = document.getElementById('ufDisplay').value.trim();
        const password = document.getElementById('ufPassword').value;
        if (!username) { modalError('请填写用户名'); return false; }
        if (!password) { modalError('请填写初始密码'); return false; }
        await Api.adminCreateUser({
          username, displayName: displayName || undefined, password,
          role: document.getElementById('ufRole').value,
        });
        toast('用户 ' + username + ' 已创建');
        renderCurrent();
      },
    });
  };

  el.querySelectorAll('a[data-act]').forEach(a => {
    a.onclick = async () => {
      const u = users.find(x => x.id === a.dataset.id);
      if (!u) return;
      const act = a.dataset.act;
      if (act === 'edit') {
        openModal({
          title: '编辑用户 ' + u.username, okText: '保存',
          body: `
          <div class="form-grid">
            <label>用户名</label><input class="field" value="${esc(u.username)}" disabled>
            <label class="required">显示名</label><input class="field" id="efDisplay" value="${esc(u.displayName || '')}">
            <label class="required">角色</label><select class="field" id="efRole">${['DISPATCHER', 'REVIEWER', 'PRODUCTION_MANAGER', 'ADMIN']
              .map(r => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${esc(roleText(r))}（${r}）</option>`).join('')}</select>
          </div>
          <p class="hint">至少需保留一个启用中的管理员账号；最后一个管理员的降级/停用会被拒绝。</p>`,
          onOk: async () => {
            await Api.adminUpdateUser(u.id, {
              role: document.getElementById('efRole').value,
              displayName: document.getElementById('efDisplay').value.trim() || undefined,
            });
            toast('用户 ' + u.username + ' 已更新');
            renderCurrent();
          },
        });
      } else if (act === 'reset') {
        openModal({
          title: '重置密码 · ' + u.username, okText: '重置',
          body: `
          <div class="form-grid">
            <label class="required">新密码</label><input class="field" id="rfPassword" type="password" autocomplete="new-password" placeholder="至少 8 位，含字母与数字">
          </div>
          <p class="hint">重置后旧密码立即失效；已签发的登录令牌在到期前仍可使用。</p>`,
          onOk: async () => {
            const password = document.getElementById('rfPassword').value;
            if (!password) { modalError('请填写新密码'); return false; }
            await Api.adminResetUserPassword(u.id, password);
            toast('用户 ' + u.username + ' 的密码已重置');
          },
        });
      } else {
        const toDisable = act === 'off';
        if (toDisable && !confirm(`确定停用用户 ${u.username}？停用后该账号无法再登录。`)) return;
        try {
          await Api.adminSetUserStatus(u.id, !toDisable);
          toast(`用户 ${u.username} 已${toDisable ? '停用' : '启用'}`);
          renderCurrent();
        } catch (e) { toastErr(e, '操作失败'); }
      }
    };
  });
});

/* ---------------- 基础字典维护 ---------------- */
registerPage('admin-configs', ['系统管理', '字典维护'], async (el) => {
  el.innerHTML = loadingHtml('正在加载配置…');
  let configs;
  try { configs = await Api.adminConfigs(); }
  catch (e) { el.innerHTML = errorBoxHtml(e, '配置加载失败'); return; }

  el.innerHTML = `
    <div class="page-header"><div><h1>基础字典维护</h1><p>键值型系统配置；每次修改生成新配置版本并即时生效，全程留审计</p></div>
      <div class="buttons"><button class="btn" onclick="renderCurrent()">&#8635; 刷新</button></div></div>
    <section class="card table-card"><div class="table-wrap"><table class="data-table">
      <thead><tr><th>配置键</th><th>配置值</th><th>说明</th><th>版本</th><th>生效时间</th><th>更新人</th><th>操作</th></tr></thead>
      <tbody>${configs.map(c => `<tr>
        <td class="machine-name">${esc(c.configKey)}</td>
        <td style="max-width:320px;word-break:break-all">${esc(c.configValue)}</td>
        <td><span class="muted">${esc(c.description || '-')}</span></td>
        <td>v${c.version}</td>
        <td>${fmtDateTime(c.effectiveAt)}</td>
        <td>${esc(c.updatedBy || '-')}</td>
        <td class="table-actions"><a data-key="${esc(c.configKey)}">编辑</a></td></tr>`).join('')
        || '<tr><td colspan="7" style="text-align:center;color:#909399">暂无配置项</td></tr>'}</tbody>
    </table></div></section>`;

  el.querySelectorAll('a[data-key]').forEach(a => {
    a.onclick = () => {
      const c = configs.find(x => x.configKey === a.dataset.key);
      if (!c) return;
      openModal({
        title: '编辑配置 ' + c.configKey, okText: '保存',
        body: `
        <div class="form-grid">
          <label>配置键</label><input class="field" value="${esc(c.configKey)}" disabled>
          <label>说明</label><input class="field" value="${esc(c.description || '')}" disabled>
          <label class="required">配置值</label><textarea class="field" id="cvValue" style="min-height:64px">${esc(c.configValue || '')}</textarea>
        </div>
        <p class="hint">保存后配置版本 v${c.version} → v${c.version + 1}，新的生效时间即时生效并写入审计。</p>`,
        onOk: async () => {
          const configValue = document.getElementById('cvValue').value.trim();
          if (!configValue) { modalError('配置值不能为空'); return false; }
          const r = await Api.adminUpdateConfig(c.configKey, configValue);
          toast(`配置 ${c.configKey} 已更新为 v${r.version}`);
          renderCurrent();
        },
      });
    };
  });
});

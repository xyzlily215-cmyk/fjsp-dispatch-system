/* v-role 指令：按角色隐藏元素（等价旧版 data-roles + applyRoleVisibility）。
 * 用法：v-role="['DISPATCHER','ADMIN']" 或 v-role="'DISPATCHER,ADMIN'"；ADMIN 恒可见。 */
import { useAuthStore } from '../stores/auth';

function applyRole(el, value) {
  const auth = useAuthStore();
  const roles = Array.isArray(value) ? value : String(value || '').split(',').map(s => s.trim());
  el.style.display = auth.hasAnyRole(...roles) ? '' : 'none';
}

export const vRole = {
  mounted(el, binding) { applyRole(el, binding.value); },
  updated(el, binding) { applyRole(el, binding.value); },
};

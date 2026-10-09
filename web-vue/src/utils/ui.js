/* 消息提示：替代旧版 util.js 的 toast/toastErr（改用 ElMessage） */
import { ElMessage } from 'element-plus';
import { errMsg } from './format';

export function toast(msg, type = 'success') {
  ElMessage({ message: msg, type: type === 'error' ? 'error' : type === 'info' ? 'info' : 'success' });
}

export function toastErr(e, prefix) {
  toast((prefix ? prefix + '：' : '') + errMsg(e), 'error');
}

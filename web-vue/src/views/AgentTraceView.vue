<template>
  <AsyncPage :loading="loading" :error="error" error-title="Agent 处置记录加载失败" loading-text="正在加载 Agent 处置记录…">
    <div class="page-header">
      <div>
        <h1>Agent 处置时间线</h1>
        <p>AGH 智能体对业务系统的写操作审计（X-Source: agh），按会话分组，与 AGH 工作台的工具调用链一一对应</p>
      </div>
      <div class="buttons">
        <input class="field" v-model="sessionFilter" placeholder="按会话 ID 过滤（可选）"
               style="width:280px" @keyup.enter="reload">
        <button class="btn" @click="reload">&#8635; 刷新</button>
      </div>
    </div>

    <section v-for="s in sessions" :key="s.id" class="card session-card">
      <div class="session-head">
        <span class="session-id">会话 {{ s.id }}</span>
        <span class="muted">{{ s.items.length }} 步 · {{ fmtDateTime(s.items[0].createdAt) }} 起</span>
      </div>
      <div class="timeline">
        <div v-for="it in s.items" :key="it.id" class="tl-item">
          <span class="tl-dot" :class="dotClass(it.action)"></span>
          <div class="tl-body">
            <div class="tl-title">
              <b>{{ actionText(it.action) }}</b>
              <span class="muted">{{ it.objectType }} · {{ it.objectId }}</span>
              <span class="tl-time">{{ fmtTime(it.createdAt) }}</span>
            </div>
            <div v-if="it.detail" class="tl-detail">{{ it.detail }}</div>
          </div>
        </div>
      </div>
    </section>

    <div v-if="!sessions.length && !loading" class="card" style="padding:32px;text-align:center;color:#909399">
      暂无 Agent 操作记录：在 AGH 工作台发起一次基线排程或扰动处置后，这里会按会话展示完整操作链
    </div>
    <Pager v-if="page && page.total > page.size" :page="page" @change="onPage" />
  </AsyncPage>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { Api } from '../api';
import { fmtDateTime } from '../utils/format';
import AsyncPage from '../components/AsyncPage.vue';
import Pager from '../components/Pager.vue';

/* 与业务服务 AuditService.record 的 action 取值对应 */
const ACTIONS = {
  EVENT_BREAKDOWN: '故障上报',
  EVENT_NEW_ORDER: '订单插单',
  EVENT_CLOSE: '事件关闭',
  EVENT_REVISE: '事件修订',
  TASK_CREATE: '创建调度任务',
  TASK_CANCEL_REQUESTED: '请求取消任务',
  TASK_CANCELLED: '任务取消',
  TASK_FAILED: '任务失败',
  TASK_RETRY_SCHEDULED: '任务重试',
  TASK_MANUAL_RETRY: '人工重试任务',
  TASK_RECOVERED: '任务恢复',
  PLAN_SUBMIT_REVIEW: '提交评审',
  PLAN_REVIEW_APPROVE: '评审通过',
  PLAN_REVIEW_REJECT: '评审驳回',
  PLAN_REVISE: '退回修改',
  PLAN_PUBLISH: '发布上线',
  PLAN_ROLLBACK: '计划回滚',
  PLAN_EXPORT: '导出计划',
  DEMO_RESET: '演示重置',
};

const page = ref(null);
const loading = ref(true);
const error = ref(null);
const pageNo = ref(0);
const sessionFilter = ref('');

/* 服务端按时间倒序返回：按会话分组（组间保持倒序），组内翻为正序，读作一条处置链 */
const sessions = computed(() => {
  const groups = new Map();
  for (const it of (page.value && page.value.items) || []) {
    const key = it.sessionId || '(无会话)';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  return [...groups.entries()].map(([id, items]) => ({ id, items: items.slice().reverse() }));
});

function actionText(action) {
  return ACTIONS[action] || action;
}

function dotClass(action) {
  if (['PLAN_PUBLISH', 'PLAN_REVIEW_APPROVE'].includes(action)) return 'ok';
  if (['EVENT_BREAKDOWN', 'PLAN_REVIEW_REJECT', 'DEMO_RESET', 'TASK_FAILED'].includes(action)) return 'bad';
  if (['PLAN_SUBMIT_REVIEW', 'EVENT_NEW_ORDER', 'PLAN_ROLLBACK'].includes(action)) return 'warn';
  return '';
}

function fmtTime(s) {
  if (!s) return '-';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleTimeString('zh-CN', { hour12: false });
}

async function load() {
  loading.value = true; error.value = null;
  try {
    page.value = await Api.auditLogsPage({
      page: pageNo.value, size: 50, source: 'agh',
      sessionId: sessionFilter.value.trim() || undefined,
    });
  } catch (e) {
    error.value = e;
  } finally {
    loading.value = false;
  }
}

function reload() { pageNo.value = 0; load(); }
function onPage(delta) { pageNo.value = Math.max(0, pageNo.value + delta); load(); }

onMounted(load);
</script>

<style scoped>
.session-card { margin-bottom: 14px; padding: 14px 18px; }
.session-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 10px; }
.session-id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; color: #409eff; }
.timeline { border-left: 2px solid #e4e7ed; margin-left: 6px; }
.tl-item { position: relative; padding: 6px 0 6px 18px; }
.tl-dot {
  position: absolute; left: -7px; top: 12px; width: 12px; height: 12px;
  border-radius: 50%; background: #409eff; border: 2px solid #fff;
}
.tl-dot.ok { background: #67c23a; }
.tl-dot.warn { background: #e6a23c; }
.tl-dot.bad { background: #f56c6c; }
.tl-title { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
.tl-time { margin-left: auto; color: #909399; font-size: 12px; font-variant-numeric: tabular-nums; }
.tl-detail {
  margin-top: 4px; font-size: 12px; color: #606266; word-break: break-all;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
</style>

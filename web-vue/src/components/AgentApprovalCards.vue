<template>
  <div v-if="agent.approvals.length" class="approval-list">
    <div v-for="card in agent.approvals" :key="card.requestId" class="approval-card">
      <div class="approval-head">
        <span class="approval-tag">人工审批</span>
        <span class="approval-tool">{{ approvalToolName(card) }}</span>
        <span v-if="card.approval" class="approval-risk">{{ riskLabel(card.approval.risk) }}</span>
      </div>
      <!-- 五要素审批信息（BFF 下发）：人类可读摘要 + 业务对象 + 可审批角色 + 有效期 + 参数摘要指纹 -->
      <template v-if="card.approval">
        <div class="approval-summary">{{ card.approval.summary }}</div>
        <div class="approval-meta">
          <span v-if="bizText(card)">业务对象：{{ bizText(card) }}</span>
          <span>需角色：{{ rolesText(card.approval.requiredRoles) }}</span>
          <span>有效期至 {{ expireText(card.approval.expiresAt) }}</span>
          <span>参数指纹 {{ card.approval.digest }}</span>
        </div>
      </template>
      <pre v-else class="approval-args">{{ approvalArgsText(card) }}</pre>
      <div class="approval-btns">
        <button type="button" class="ap-btn approve" :disabled="!!card.resolving"
                @click="onApprove(card, 'allowed-once')">
          {{ card.resolving === 'allowed-once' ? '批准中…' : '批准执行' }}
        </button>
        <button type="button" class="ap-btn reject" :disabled="!!card.resolving"
                @click="onApprove(card, 'rejected')">
          {{ card.resolving === 'rejected' ? '拒绝中…' : '拒绝' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/* 待审批卡片列表：AgentChat（侧栏）与 AiInsightCard（页内 AI 卡片）共用。
 * 对应 fjsp-tools 三级审批的人工确认，批准/拒绝经 agent-bff 回传 verdict；
 * BFF 批准时按五要素审批记录重校验（归属/有效期/角色/一次性）。 */
import { useAgentStore, type ApprovalCard } from '../stores/agent';

const agent = useAgentStore();

const ROLE_NAMES: Record<string, string> = {
  ADMIN: '管理员',
  DISPATCHER: '调度员',
  REVIEWER: '审核员',
  PRODUCTION_MANAGER: '生产主管',
};

function approvalToolName(card: ApprovalCard) {
  return card.approval?.tool || (card.toolCall.name as string) || (card.toolCall.title as string) || '未知工具';
}
const RISK_NAMES: Record<string, string> = { WRITE: '写操作', HIGH_RISK: '高风险', DESTRUCTIVE: '破坏性', UNKNOWN: '未知级别' };
function riskLabel(risk: string) {
  return RISK_NAMES[risk] || risk;
}
function bizText(card: ApprovalCard) {
  const biz = card.approval?.bizObject;
  return biz ? Object.entries(biz).map(([k, v]) => `${k}=${v}`).join('，') : '';
}
function rolesText(roles: string[]) {
  return roles.length ? roles.map((r) => ROLE_NAMES[r] || r).join(' / ') : '无（不可批准）';
}
function expireText(expiresAt: number) {
  if (!expiresAt) return '—';
  const d = new Date(expiresAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function approvalArgsText(card: ApprovalCard) {
  const args = card.toolCall.args ?? card.toolCall.arguments;
  if (args === undefined) return '';
  const text = typeof args === 'string' ? args : JSON.stringify(args, null, 2);
  return text.length > 500 ? text.slice(0, 500) + ' …' : text;
}

async function onApprove(card: ApprovalCard, verdict: 'allowed-once' | 'rejected') {
  try {
    await agent.approve(card.requestId, verdict);
  } catch (e) {
    const err = e as { code?: string; message?: string };
    ElMessage.warning(err.code === 'permission_not_found' ? '该审批已失效（可能已超时）' : (err.message || '审批提交失败'));
  }
}
</script>

<style scoped>
.approval-list { display:flex; flex-direction:column; gap:8px; }
.approval-card { border:1px solid #f5dab1; border-radius:8px; background:#fff; padding:8px 10px; }
.approval-head { display:flex; align-items:center; gap:8px; margin-bottom:6px; }
.approval-tag { flex:none; padding:1px 7px; border-radius:4px; background:#e6a23c; color:#fff; font-size:11px; font-weight:600; }
.approval-tool { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; color:#606266; }
.approval-risk { flex:none; padding:1px 7px; border-radius:4px; background:#fef0f0; color:#f56c6c; font-size:11px; }
.approval-summary { margin:0 0 6px; font-size:12px; color:#303133; word-break:break-all; }
.approval-meta { display:flex; flex-direction:column; gap:2px; margin:0 0 8px; font-size:11px; color:#909399; }
.approval-args { margin:0 0 8px; font-size:11px; color:#909399; white-space:pre-wrap; word-break:break-all; max-height:100px; overflow-y:auto; }
.approval-btns { display:flex; gap:8px; }
.ap-btn { flex:1; border:0; border-radius:6px; padding:6px 0; font-size:12.5px; cursor:pointer; }
.ap-btn.approve { background:var(--blue, #409eff); color:#fff; }
.ap-btn.approve:hover:not(:disabled) { background:#66b1ff; }
.ap-btn.reject { background:#f4f4f5; color:#606266; border:1px solid #dcdfe6; }
.ap-btn.reject:hover:not(:disabled) { color:#f56c6c; border-color:#fbc4c4; }
.ap-btn:disabled { opacity:.55; cursor:default; }
</style>

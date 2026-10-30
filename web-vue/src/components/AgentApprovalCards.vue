<template>
  <div v-if="agent.approvals.length" class="approval-list">
    <div v-for="card in agent.approvals" :key="card.requestId" class="approval-card">
      <div class="approval-head">
        <span class="approval-tag">人工审批</span>
        <span class="approval-tool">{{ approvalToolName(card) }}</span>
      </div>
      <pre class="approval-args">{{ approvalArgsText(card) }}</pre>
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
 * 对应 fjsp-tools 三级审批的人工确认，批准/拒绝经 agent-bff 回传 verdict。 */
import { useAgentStore, type ApprovalCard } from '../stores/agent';

const agent = useAgentStore();

function approvalToolName(card: ApprovalCard) {
  return (card.toolCall.name as string) || (card.toolCall.title as string) || '未知工具';
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
.approval-args { margin:0 0 8px; font-size:11px; color:#909399; white-space:pre-wrap; word-break:break-all; max-height:100px; overflow-y:auto; }
.approval-btns { display:flex; gap:8px; }
.ap-btn { flex:1; border:0; border-radius:6px; padding:6px 0; font-size:12.5px; cursor:pointer; }
.ap-btn.approve { background:var(--blue, #409eff); color:#fff; }
.ap-btn.approve:hover:not(:disabled) { background:#66b1ff; }
.ap-btn.reject { background:#f4f4f5; color:#606266; border:1px solid #dcdfe6; }
.ap-btn.reject:hover:not(:disabled) { color:#f56c6c; border-color:#fbc4c4; }
.ap-btn:disabled { opacity:.55; cursor:default; }
</style>

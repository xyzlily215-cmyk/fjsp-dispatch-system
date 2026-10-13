#!/usr/bin/env node
/* 把 AGH 会话证据（driver 落盘的 .jsonl 事件流）渲染成单文件 HTML 时间线：
 * 用户指令 / 助手输出 / 工具调用（含风险级别）/ 审批请求与决定 / 工具结果，
 * 按 seq 排序，颜色区分。用于演示与提交材料（submission/05-运行证据说明.md）。
 *
 * 用法：node scripts/render-trace.mjs <events.jsonl> [输出.html]
 */
import { readFileSync, writeFileSync } from 'node:fs';

const input = process.argv[2];
if (!input) {
  console.error('usage: node scripts/render-trace.mjs <events.jsonl> [out.html]');
  process.exit(1);
}
const out = process.argv[3] ?? input.replace(/\.jsonl$/, '') + '.html';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmtTs = (ts) => (ts ? new Date(ts).toLocaleTimeString('zh-CN', { hour12: false }) : '');
const textOf = (d) => (d?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('');

const events = readFileSync(input, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

// toolUseId → 工具名（tool/result 事件不带名字，从 call 事件回填）
const toolNames = new Map();
for (const e of events) {
  if (e.type === 'tool/call') toolNames.set(e.data?.toolUseId, e.data?.name);
}

const KIND = {
  prompt: { label: '用户指令', cls: 'prompt' },
  assistant: { label: '助手', cls: 'assistant' },
  tool: { label: '工具调用', cls: 'tool' },
  approval: { label: '审批', cls: 'approval' },
  result: { label: '工具结果', cls: 'result' },
  system: { label: '系统', cls: 'system' },
};

const rows = [];
for (const e of events) {
  const d = e.data ?? {};
  const ts = fmtTs(e.ts);
  if (e.type === 'session/start') {
    rows.push({ kind: 'system', ts, title: '会话开始', body: `profile=${d.resolvedProfileHash ?? ''}` });
  } else if (e.type === 'user/message') {
    rows.push({ kind: 'prompt', ts, title: textOf(d) || JSON.stringify(d) });
  } else if (e.type === 'assistant/message') {
    const text = textOf(d);
    if (text) rows.push({ kind: 'assistant', ts, title: text });
  } else if (e.type === 'tool/call') {
    const risk = d.resolvedPolicy?.requiresApproval;
    const riskTag = risk && risk !== 'never' ? ` <span class="risk">审批:${esc(risk)}</span>` : '';
    rows.push({
      kind: 'tool', ts,
      title: `${esc(d.name)}${riskTag}`,
      body: d.args && Object.keys(d.args).length ? JSON.stringify(d.args, null, 2) : '',
    });
  } else if (e.type === 'approval/asked') {
    rows.push({ kind: 'approval', ts, title: `请求审批：<b>${esc(d.summary)}</b>`, body: `risk=${esc(d.risk)}` });
  } else if (e.type === 'approval/decided') {
    rows.push({ kind: 'approval', ts, title: `审批决定：<b>${esc(d.verdict)}</b>`, body: `via=${esc(d.via)}` });
  } else if (e.type === 'tool/result') {
    const name = toolNames.get(d.toolUseId) ?? '';
    const text = textOf(d);
    rows.push({
      kind: 'result', ts,
      title: `${esc(name)} ${d.isError ? '<span class="risk">失败</span>' : '完成'}`,
      body: text.length > 2000 ? text.slice(0, 2000) + `\n…（截断，共 ${text.length} 字符）` : text,
    });
  } else if (e.type === 'turn/end') {
    rows.push({ kind: 'system', ts, title: `回合结束：${esc(d.reason ?? '')}` });
  }
}

const counts = rows.reduce((m, r) => ((m[r.kind] = (m[r.kind] ?? 0) + 1), m), {});
const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>AGH 会话时间线 - ${esc(input.split('/').pop())}</title>
<style>
  body { font: 14px/1.6 -apple-system, "PingFang SC", sans-serif; background: #f5f6f8; margin: 0; padding: 24px; }
  h1 { font-size: 18px; } .meta { color: #909399; font-size: 12px; margin-bottom: 16px; }
  .tl { border-left: 2px solid #dcdfe6; margin-left: 8px; }
  .it { position: relative; padding: 8px 0 8px 20px; }
  .dot { position: absolute; left: -7px; top: 14px; width: 12px; height: 12px; border-radius: 50%; border: 2px solid #fff; }
  .prompt .dot { background: #303133; } .assistant .dot { background: #67c23a; }
  .tool .dot { background: #409eff; } .approval .dot { background: #e6a23c; }
  .result .dot { background: #c0c4cc; } .system .dot { background: #909399; }
  .tag { font-size: 11px; color: #fff; border-radius: 3px; padding: 1px 6px; margin-right: 6px; vertical-align: 2px; }
  .prompt .tag { background: #303133; } .assistant .tag { background: #67c23a; }
  .tool .tag { background: #409eff; } .approval .tag { background: #e6a23c; }
  .result .tag { background: #c0c4cc; } .system .tag { background: #909399; }
  .ts { color: #909399; font-size: 12px; margin-left: 8px; font-variant-numeric: tabular-nums; }
  .risk { color: #f56c6c; font-size: 12px; }
  pre { background: #fff; border: 1px solid #e4e7ed; border-radius: 4px; padding: 8px; font-size: 12px;
        white-space: pre-wrap; word-break: break-all; margin: 4px 0 0; max-height: 260px; overflow: auto; }
</style></head><body>
<h1>AGH 会话处置时间线</h1>
<div class="meta">来源：${esc(input)} · 共 ${events.length} 个事件 ·
  工具调用 ${counts.tool ?? 0} · 审批 ${counts.approval ?? 0} · 助手输出 ${counts.assistant ?? 0}</div>
<div class="tl">
${rows.map((r) => `  <div class="it ${r.kind}"><span class="dot"></span>
    <div><span class="tag">${KIND[r.kind].label}</span><span class="ts">${r.ts}</span> ${r.title}</div>
    ${r.body ? `<pre>${esc(r.body)}</pre>` : ''}
  </div>`).join('\n')}
</div></body></html>
`;

writeFileSync(out, html);
console.log(`[render-trace] ${rows.length} 个时间节点 -> ${out}`);
console.log(`[render-trace] 统计: ${JSON.stringify(counts)}`);

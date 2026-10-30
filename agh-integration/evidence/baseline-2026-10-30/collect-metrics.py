#!/usr/bin/env python3
# collect-metrics.py — 从 AGH 事件流 jsonl 采集 Golden 基线指标（任务 0.3）
# 用法: python3 collect-metrics.py <events.jsonl> [...]
# 输出: 每文件一行 JSON：步骤数/审批点/工具错误/tokens/耗时/工具序列/模型
import json, sys
from datetime import datetime

def parse_ts(ts):
    return datetime.fromisoformat(ts.replace('Z', '+00:00')).timestamp()

for path in sys.argv[1:]:
    steps = 0
    approvals_asked = 0
    approvals_decided = 0
    tool_errors = []
    tokens = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "reasoning": 0}
    llm_ms = 0
    models = set()
    calls = []
    t_start = None
    t_end = None
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            e = json.loads(line)
            t = e.get('type')
            ts = e.get('ts')
            if ts:
                p = parse_ts(ts)
                if t == 'turn/start' and (t_start is None or p < t_start):
                    t_start = p
                if t == 'turn/end' and (t_end is None or p > t_end):
                    t_end = p
            d = e.get('data') or {}
            if t == 'tool/call':
                steps += 1
                calls.append(d.get('name'))
            elif t == 'approval/asked':
                approvals_asked += 1
            elif t == 'approval/decided':
                approvals_decided += 1
            elif t == 'tool/result':
                name = None
                structured = d.get('structured')
                ok = None
                if isinstance(structured, dict):
                    ok = structured.get('ok')
                if ok is None:
                    content = d.get('content') or []
                    if content and isinstance(content[0], dict):
                        try:
                            ok = json.loads(content[0].get('text') or '{}').get('ok')
                        except Exception:
                            ok = None
                if ok is False:
                    err = (structured or {}).get('error') or {}
                    tool_errors.append(err.get('code') or 'unknown')
            elif t == 'cost/ledger':
                tk = d.get('tokens') or {}
                for k in tokens:
                    tokens[k] += tk.get(k, 0) or 0
                llm_ms += (d.get('timing') or {}).get('durationMs', 0) or 0
                if d.get('model'):
                    models.add(d['model'])
    out = {
        "file": path,
        "steps": steps,
        "approvalsAsked": approvals_asked,
        "approvalsDecided": approvals_decided,
        "toolErrors": tool_errors,
        "tokens": tokens,
        "llmDurationMs": llm_ms,
        "wallMs": int((t_end - t_start) * 1000) if t_start and t_end else None,
        "models": sorted(models),
        "toolSequence": calls,
    }
    print(json.dumps(out, ensure_ascii=False))

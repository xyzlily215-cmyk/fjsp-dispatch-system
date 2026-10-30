#!/usr/bin/env bash
# restore-snapshot.sh — 还原 Golden 评估集数据快照。
# 机制：调用业务服务 /demo/reset 清库重灌种子（business-service DemoService.reset +
# SeedService.seed，种子文件 business-service/src/main/resources/seed/demo_instance.json，
# 规模 20 订单 / 8 设备 / 3 产品族模板 / 76 工序），随后逐项校验规模与仿真起点。
# 确定性前提：业务服务以 FJSP_SIMULATION_MODE=FIXED 启动（见 evaluation/golden-set.md 第 2 节），
# 此时 simulationStartAt 固定为种子文件的 2026-09-16T08:00:00+08:00。
# 用法: agh-integration/evaluation/snapshot/restore-snapshot.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck disable=SC1091
source "$REPO_ROOT/scripts/demo-common.sh"
load_demo_env

require_command curl
require_command python3
wait_for_readiness "$FJSP_READINESS_URL" "业务服务" 30
demo_auth_login

printf '还原 Golden 快照：POST %s/demo/reset\n' "$FJSP_API_BASE"
response="$(curl -fsS -X POST "$FJSP_API_BASE/demo/reset" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $FJSP_AUTH_TOKEN" \
  -H "Idempotency-Key: golden-restore-$(date +%s)" \
  -H 'X-Source: golden-eval' \
  -d '{}')"

# 逐项校验种子规模与仿真起点；FJSP_EXPECT_SIM_START 可覆盖期望值（默认 FIXED 模式锚点）
FJSP_EXPECT_SIM_START="${FJSP_EXPECT_SIM_START:-2026-09-16T08:00:00+08:00}" \
  python3 - "$response" <<'PY'
import json, os, sys
data = json.loads(sys.argv[1])
# 业务服务统一响应包络 {requestId,code,message,data}，种子摘要在 data.seed
payload = data.get("data") if isinstance(data.get("data"), dict) else data
seed = payload.get("seed", {})
expect = {"machines": 8, "processTemplates": 3, "orders": 20, "operations": 76}
failed = False
for key, want in expect.items():
    got = seed.get(key)
    ok = got == want
    failed |= not ok
    print(f"{'PASS' if ok else 'FAIL'} seed.{key}={want}（实际 {got}）")
sim_start = seed.get("simulationStartAt")
want_start = os.environ["FJSP_EXPECT_SIM_START"]
# Jackson 序列化 OffsetDateTime 秒为 0 时省略 :SS（2026-09-16T08:00+08:00），按解析后的时刻比较
from datetime import datetime
try:
    ok = sim_start is not None and datetime.fromisoformat(sim_start) == datetime.fromisoformat(want_start)
except ValueError:
    ok = False
failed |= not ok
print(f"{'PASS' if ok else 'FAIL'} seed.simulationStartAt={want_start}（实际 {sim_start}）"
      + ("" if ok else " —— 业务服务疑似未以 FJSP_SIMULATION_MODE=FIXED 启动"))
sys.exit(1 if failed else 0)
PY

printf 'Golden 快照还原完成。\n'

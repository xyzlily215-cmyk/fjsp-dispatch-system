#!/usr/bin/env bash
# 清空并重新导入演示数据。仅面向本地演示环境。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/demo-common.sh"
load_demo_env

"$SCRIPT_DIR/check-env.sh"
require_command curl
wait_for_url "$FJSP_API_BASE/machines" "业务服务" 30

printf '即将重置演示数据库中的业务数据（数据库结构和 Compose 数据卷不删除）。\n'
response="$(curl -fsS -X POST "$FJSP_API_BASE/demo/reset" \
  -H 'Content-Type: application/json' \
  -H "X-Source: demo-script" \
  -H "X-Operator-Id: ${FJSP_OPERATOR:-demo-operator}" \
  -d '{}')"
printf '%s\n' "$response" | python3 -m json.tool
printf '演示数据重置完成。\n'

#!/usr/bin/env bash
# 运行面向前端字段契约的完整 API E2E 检查。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/demo-common.sh"
load_demo_env

"$SCRIPT_DIR/check-env.sh"
require_command node
require_command python3
wait_for_readiness "$FJSP_READINESS_URL" "业务服务" 30
export FJSP_API="$FJSP_API_BASE"
exec node "$ROOT_DIR/web/scripts/e2e-api-check.mjs"

#!/usr/bin/env bash
# 运行业务服务全流程冒烟测试。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/demo-common.sh"
load_demo_env

"$SCRIPT_DIR/check-env.sh"
require_command curl
require_command python3
export BASE="$FJSP_API_BASE"
exec "$ROOT_DIR/business-service/scripts/smoke-test.sh"

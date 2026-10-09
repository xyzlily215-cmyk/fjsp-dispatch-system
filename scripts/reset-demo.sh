#!/usr/bin/env bash
# 清空并重新导入演示数据。仅面向本地演示环境。
# 默认交互确认；-y/--yes 跳过确认；stdin 非 tty（CI/管道）时自动跳过确认。
set -euo pipefail

ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
    *) printf '未知参数: %s（支持 -y/--yes）\n' "$arg" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/demo-common.sh"
load_demo_env

"$SCRIPT_DIR/check-env.sh"
require_command curl
require_command python3
wait_for_readiness "$FJSP_READINESS_URL" "业务服务" 30
demo_auth_login

printf '即将重置演示数据库中的业务数据（数据库结构和 Compose 数据卷不删除）。\n'
if [[ "$ASSUME_YES" != "1" && -t 0 ]]; then
  read -r -p '确认重置？[y/N] ' reply || true
  if [[ ! "$reply" =~ ^[yY]$ ]]; then
    printf '已取消，未修改任何数据。\n'
    exit 0
  fi
fi
response="$(curl -fsS -X POST "$FJSP_API_BASE/demo/reset" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $FJSP_AUTH_TOKEN" \
  -H "X-Source: demo-script" \
  -d '{}')"
printf '%s\n' "$response" | python3 -m json.tool
printf '演示数据重置完成。\n'

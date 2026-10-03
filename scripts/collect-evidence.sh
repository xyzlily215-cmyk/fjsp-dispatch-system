#!/usr/bin/env bash
# 采集本地演示运行证据；默认写入 /tmp，不写入仓库，不输出密码或 API Key。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/demo-common.sh"
load_demo_env

require_command curl
require_command docker
require_command python3
wait_for_url "$FJSP_API_BASE/machines" "业务服务" 30
demo_auth_login

OUT_DIR="${1:-${TMPDIR:-/tmp}/fjsp-evidence-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$OUT_DIR"

{
  printf 'collectedAt=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'apiBase=%s\n' "$FJSP_API_BASE"
  printf 'algorithmBase=%s\n' "$FJSP_ALGORITHM_BASE_URL"
  printf 'webPort=%s\n' "$FJSP_WEB_PORT"
  printf 'aghPort=%s\n' "$FJSP_AGH_PORT"
  printf '\n-- compose ps --\n'
  docker_compose ps || true
} >"$OUT_DIR/manifest.txt"

curl -fsS "$FJSP_ALGORITHM_BASE_URL/health" >"$OUT_DIR/algorithm-health.json"
curl -fsS -H "Authorization: Bearer $FJSP_AUTH_TOKEN" "$FJSP_API_BASE/machines" >"$OUT_DIR/machines.json"
curl -fsS -H "Authorization: Bearer $FJSP_AUTH_TOKEN" "$FJSP_API_BASE/dashboard" >"$OUT_DIR/dashboard.json"
curl -fsS -I "http://127.0.0.1:${FJSP_WEB_PORT}/index.html" >"$OUT_DIR/web-headers.txt" || true
if curl -fsS --max-time 3 "http://127.0.0.1:${FJSP_AGH_PORT}/" >/dev/null 2>&1; then
  curl -fsS -I "http://127.0.0.1:${FJSP_AGH_PORT}/" >"$OUT_DIR/agh-headers.txt" || true
fi

printf '证据已采集到：%s\n' "$OUT_DIR"
printf '文件：\n'
find "$OUT_DIR" -maxdepth 1 -type f -print | sort

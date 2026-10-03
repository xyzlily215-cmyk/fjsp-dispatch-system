#!/usr/bin/env bash
# 一键启动 FJSP 演示环境。不会删除数据库卷或重置业务数据。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/demo-common.sh"
load_demo_env

"$SCRIPT_DIR/check-env.sh"
require_command docker
require_command curl
require_command python3
require_command mvn
require_command java

printf '\n== 1. 启动 PostgreSQL / Redis ==\n'
docker_compose up -d postgres redis
wait_for_container_health fjsp-postgres
wait_for_container_health fjsp-redis

printf '\n== 2. 启动算法服务 ==\n'
if ! curl -fsS --max-time 3 "$FJSP_ALGORITHM_BASE_URL/health" >/dev/null 2>&1; then
  start_process algorithm "uvicorn app.api:app" "$ROOT_DIR/algorithm-service" "$(log_file algorithm)" \
    python3 -m uvicorn app.api:app --host 127.0.0.1 --port "$FJSP_ALGORITHM_PORT"
fi
wait_for_url "$FJSP_ALGORITHM_BASE_URL/health" "算法服务"

printf '\n== 3. 构建并启动业务服务 ==\n'
if ! curl -fsS --max-time 3 "$FJSP_API_BASE/machines" >/dev/null 2>&1; then
  (cd "$ROOT_DIR/business-service" && mvn -q -DskipTests package)
  start_process business "business-service-1.0.0.jar" "$ROOT_DIR/business-service" "$(log_file business)" \
    java -jar target/business-service-1.0.0.jar
fi
wait_for_url "$FJSP_API_BASE/machines" "业务服务" 120

printf '\n== 4. 启动前端静态服务 ==\n'
if ! curl -fsS --max-time 3 "http://127.0.0.1:${FJSP_WEB_PORT}/index.html" >/dev/null 2>&1; then
  start_process web "http.server ${FJSP_WEB_PORT}" "$ROOT_DIR/web" "$(log_file web)" \
    python3 -m http.server "$FJSP_WEB_PORT" --bind 127.0.0.1
fi
wait_for_url "http://127.0.0.1:${FJSP_WEB_PORT}/index.html" "前端"

if [[ "$FJSP_START_AGH" == "1" ]]; then
  printf '\n== 5. 启动 AGH 工作台 ==\n'
  require_command node
  local_agh="$ROOT_DIR/agh-integration/agnes-harness/packages/cli/dist/local/agnes.mjs"
  [[ -f "$local_agh" ]] || { printf 'AGH CLI 未构建: %s\n' "$local_agh" >&2; exit 1; }
  if ! curl -fsS --max-time 3 "http://127.0.0.1:${FJSP_AGH_PORT}/" >/dev/null 2>&1; then
    start_process agh "agnes-harness/packages/cli/dist/local/agnes.mjs serve" "$ROOT_DIR/agh-integration" "$(log_file agh)" \
      node agnes-harness/packages/cli/dist/local/agnes.mjs serve
  fi
  wait_for_url "http://127.0.0.1:${FJSP_AGH_PORT}/" "AGH 工作台" 60
else
  printf '\n== 5. 跳过 AGH（FJSP_START_AGH=%s）==\n' "$FJSP_START_AGH"
fi

cat <<SUMMARY

演示环境已启动：
  前端: http://127.0.0.1:${FJSP_WEB_PORT}/index.html?api=${FJSP_API_BASE}
  业务 API: ${FJSP_API_BASE}
  算法服务: ${FJSP_ALGORITHM_BASE_URL}/health
  AGH: http://127.0.0.1:${FJSP_AGH_PORT}/

运行数据未被重置。如需重建演示数据，请执行：
  ./scripts/reset-demo.sh
日志目录：${RUNTIME_DIR}
SUMMARY

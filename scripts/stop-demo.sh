#!/usr/bin/env bash
# 停止 start-demo.sh 启动的本地进程，并停止 Compose 容器；不删除数据卷。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/demo-common.sh"
load_demo_env

stop_process agh "agnes-harness/packages/cli/dist/local/agnes.mjs serve"
stop_process web "http.server ${FJSP_WEB_PORT}"
stop_process business "business-service-1.0.0.jar"
stop_process algorithm "uvicorn app.api:app"

compose_marker="$(compose_marker_file)"
if [[ -f "$compose_marker" ]]; then
  if command -v docker >/dev/null 2>&1; then
    docker_compose stop postgres >/dev/null
    printf '[完成] PostgreSQL 已停止，数据卷保留。\n'
  else
    printf '[跳过] docker 不可用，PostgreSQL 容器未停止。\n'
  fi
  rm -f "$compose_marker"
else
  printf '[跳过] 未发现 compose.started 标记，PostgreSQL 非本次 start-demo.sh 启动，保持运行。\n'
fi

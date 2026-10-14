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

printf '\n== 1. 启动 PostgreSQL ==\n'
docker_compose up -d postgres
# 记录本次 Compose 启动标记，stop-demo.sh 仅在标记存在时停止容器
: >"$(compose_marker_file)"
wait_for_container_health fjsp-postgres

printf '\n== 2. 启动算法服务 ==\n'
if ! curl -fsS --max-time 3 "$FJSP_ALGORITHM_BASE_URL/health" >/dev/null 2>&1; then
  start_process algorithm "uvicorn app.api:app" "$ROOT_DIR/algorithm-service" "$(log_file algorithm)" \
    python3 -m uvicorn app.api:app --host 127.0.0.1 --port "$FJSP_ALGORITHM_PORT" --workers 1
fi
wait_for_url "$FJSP_ALGORITHM_BASE_URL/health" "算法服务"

printf '\n== 3. 构建并启动业务服务 ==\n'
if ! curl -fsS --max-time 3 "$FJSP_READINESS_URL" >/dev/null 2>&1; then
  jar="$ROOT_DIR/business-service/target/business-service-1.0.0.jar"
  if [[ "${FJSP_SKIP_BUILD:-0}" == "1" ]]; then
    if [[ -f "$jar" ]]; then
      printf '[跳过] FJSP_SKIP_BUILD=1，沿用现有构建产物 %s\n' "$jar"
    else
      printf '[警告] FJSP_SKIP_BUILD=1 但 %s 不存在，仍执行完整构建。\n' "$jar" >&2
      (cd "$ROOT_DIR/business-service" && mvn -q -DskipTests package)
    fi
  elif [[ -f "$jar" ]] \
    && [[ -z "$(find "$ROOT_DIR/business-service/src" "$ROOT_DIR/business-service/pom.xml" -newer "$jar" -print -quit)" ]]; then
    printf '[跳过] %s 已新于 src/ 与 pom.xml，跳过 Maven 构建。\n' "$jar"
  else
    (cd "$ROOT_DIR/business-service" && mvn -q -DskipTests package)
  fi
  start_process business "business-service-1.0.0.jar" "$ROOT_DIR/business-service" "$(log_file business)" \
    env SPRING_PROFILES_ACTIVE="${SPRING_PROFILES_ACTIVE:-local}" java -jar target/business-service-1.0.0.jar
fi
wait_for_readiness "$FJSP_READINESS_URL" "业务服务" 120

printf '\n== 4. 启动前端静态服务 ==\n'
web_root="$ROOT_DIR/$FJSP_WEB_DIR"
if [[ ! -f "$web_root/index.html" ]]; then
  printf '[错误] 前端目录 %s 不存在 index.html' "$web_root" >&2
  if [[ "$FJSP_WEB_DIR" == web-vue/* ]]; then
    printf '（Vue 版需先构建：cd web-vue && npm install && npm run build）' >&2
  fi
  printf '\n' >&2
  exit 1
fi
if ! curl -fsS --max-time 3 "http://127.0.0.1:${FJSP_WEB_PORT}/index.html" >/dev/null 2>&1; then
  start_process web "http.server ${FJSP_WEB_PORT}" "$web_root" "$(log_file web)" \
    python3 -m http.server "$FJSP_WEB_PORT" --bind 127.0.0.1
fi
wait_for_url "http://127.0.0.1:${FJSP_WEB_PORT}/index.html" "前端"

if [[ "$FJSP_START_AGH" == "1" ]]; then
  printf '\n== 5. 启动 AGH 工作台 ==\n'
  require_command node
  ensure_node24
  local_agh="$ROOT_DIR/agh-integration/agnes-harness/packages/cli/dist/local/agnes.mjs"
  [[ -f "$local_agh" ]] || { printf 'AGH CLI 未构建: %s\n' "$local_agh" >&2; exit 1; }

  # serve 自动拉起 daemon 在 macOS 上不稳定（daemon child exited before readiness），
  # 这里显式检查并按手动方式启动 daemon，serve 检测到已有 daemon 会直接复用。
  agh_home="${AGH_HOME:-$HOME/.agh}"
  daemon_sock="$agh_home/data/daemon/agnesd.sock"
  daemon_owner="$agh_home/data/daemon/owner.json"
  daemon_alive=0
  if [[ -S "$daemon_sock" && -f "$daemon_owner" ]]; then
    owner_pid="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["pid"])' "$daemon_owner" 2>/dev/null || true)"
    if [[ -n "${owner_pid:-}" ]] && process_matches "$owner_pid" "daemon.mjs --profile"; then
      daemon_alive=1
      printf '[复用] AGH daemon 已运行，PID=%s\n' "$owner_pid"
    fi
  fi
  if [[ "$daemon_alive" == "0" ]]; then
    start_process agh-daemon "daemon.mjs --profile" "$ROOT_DIR/agh-integration" "$(log_file agh-daemon)" \
      node agnes-harness/packages/cli/dist/local/daemon.mjs --profile local-dev \
        --workspace "$ROOT_DIR/agh-integration" --data-dir "$agh_home/data" \
        --local-web-addr 127.0.0.1:0 --local-web-origin "http://127.0.0.1:${FJSP_AGH_PORT}"
    for _ in {1..30}; do [[ -S "$daemon_sock" ]] && break; sleep 1; done
    [[ -S "$daemon_sock" ]] || { printf '[失败] AGH daemon 未就绪，请查看 %s\n' "$(log_file agh-daemon)" >&2; exit 1; }
    printf '[就绪] AGH daemon: %s\n' "$daemon_sock"
  fi

  if ! curl -fsS --max-time 3 "http://127.0.0.1:${FJSP_AGH_PORT}/" >/dev/null 2>&1; then
    start_process agh "agnes-harness/packages/cli/dist/local/agnes.mjs serve" "$ROOT_DIR/agh-integration" "$(log_file agh)" \
      env AGNES_HUB_ORIGIN="$FJSP_AGH_HUB_ORIGIN" \
        node agnes-harness/packages/cli/dist/local/agnes.mjs serve
  fi
  wait_for_url "http://127.0.0.1:${FJSP_AGH_PORT}/" "AGH 工作台" 60

  # MHS 虚拟机床设备（machine-m03 → ws://…:4180），需已启用 @agnes/mhs 插件
  # FJSP_MHS_MACHINES 为空时只起 M-03；设为 "M-01 M-02 ... M-08" 则一次拉起整个车间
  if [[ "$FJSP_START_MHS" == "1" ]]; then
    mhs_dir="$ROOT_DIR/agh-integration/mhs-devices"
    if [[ -x "$mhs_dir/.venv/bin/python" && -f "$mhs_dir/machine-m03.py" ]]; then
      start_process m03 "machine-m03.py" "$ROOT_DIR/agh-integration" "$(log_file m03)" \
        env PYTHONPATH=agnes-harness/packages/mhs/python/src \
          "$mhs_dir/.venv/bin/python" mhs-devices/machine-m03.py "${FJSP_AGH_HUB_ORIGIN/http/ws}" ${FJSP_MHS_MACHINES:-M-03}
      wait_for_url "${FJSP_AGH_HUB_ORIGIN}/" "AgnesHub Devices 面板" 10 || true
    else
      printf '[跳过] MHS 设备未准备（缺 .venv 或 machine-m03.py），见 agh-integration/README.md「MHS 设备接入」\n'
    fi
  fi
else
  printf '\n== 5. 跳过 AGH（FJSP_START_AGH=%s）==\n' "$FJSP_START_AGH"
fi

cat <<SUMMARY

演示环境已启动：
  前端: http://127.0.0.1:${FJSP_WEB_PORT}/index.html?api=${FJSP_API_BASE}
  业务 API: ${FJSP_API_BASE}
  算法服务: ${FJSP_ALGORITHM_BASE_URL}/health
SUMMARY
if [[ "$FJSP_START_AGH" == "1" ]]; then
  printf '  AGH: http://127.0.0.1:%s/\n  AgnesHub Devices 面板: %s/\n' \
    "$FJSP_AGH_PORT" "$FJSP_AGH_HUB_ORIGIN"
fi
cat <<SUMMARY

运行数据未被重置。如需重建演示数据，请执行：
  ./scripts/reset-demo.sh
日志目录：${RUNTIME_DIR}
SUMMARY

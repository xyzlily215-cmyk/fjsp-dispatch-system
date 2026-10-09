#!/usr/bin/env bash
# Shared helpers for the local FJSP demo lifecycle scripts.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${FJSP_RUNTIME_DIR:-${TMPDIR:-/tmp}/fjsp-demo}"
mkdir -p "$RUNTIME_DIR"

load_demo_env() {
  local env_file="$ROOT_DIR/.env"
  if [[ -f "$env_file" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$env_file"
    set +a
  fi

  export FJSP_DB_HOST="${FJSP_DB_HOST:-localhost}"
  export FJSP_DB_PORT="${FJSP_DB_PORT:-5432}"
  export FJSP_DB_NAME="${FJSP_DB_NAME:-fjsp}"
  export FJSP_DB_USER="${FJSP_DB_USER:-fjsp}"
  export FJSP_ALGORITHM_PORT="${FJSP_ALGORITHM_PORT:-8101}"
  export FJSP_ALGORITHM_BASE_URL="${FJSP_ALGORITHM_BASE_URL:-http://localhost:${FJSP_ALGORITHM_PORT}}"
  export FJSP_API_BASE="${FJSP_API_BASE:-http://localhost:8081/api/v1}"
  export FJSP_READINESS_URL="${FJSP_READINESS_URL:-${FJSP_API_BASE%/api/v1}/actuator/health/readiness}"
  export FJSP_WEB_PORT="${FJSP_WEB_PORT:-8082}"
  # 前端静态目录（相对仓库根）：默认 Vue 版构建产物 web-vue/dist（需先 cd web-vue && npm run build）
  export FJSP_WEB_DIR="${FJSP_WEB_DIR:-web-vue/dist}"
  export FJSP_AGH_PORT="${FJSP_AGH_PORT:-4177}"
  export FJSP_START_AGH="${FJSP_START_AGH:-1}"
  export FJSP_AUTH_USER="${FJSP_AUTH_USER:-admin}"
  export FJSP_AUTH_PASSWORD="${FJSP_AUTH_PASSWORD:-Fj@123456}"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    printf '缺少命令: %s\n' "$1" >&2
    exit 1
  }
}

pid_file() { printf '%s/%s.pid' "$RUNTIME_DIR" "$1"; }
log_file() { printf '%s/%s.log' "$RUNTIME_DIR" "$1"; }
compose_marker_file() { printf '%s/compose.started' "$RUNTIME_DIR"; }

process_command() {
  ps -p "$1" -o command= 2>/dev/null || true
}

process_matches() {
  local pid="$1" signature="$2"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  [[ "$(process_command "$pid")" == *"$signature"* ]]
}

start_process() {
  local name="$1" signature="$2" workdir="$3" logfile="$4"
  shift 4
  local pid_path
  pid_path="$(pid_file "$name")"

  if [[ -f "$pid_path" ]] && process_matches "$(cat "$pid_path")" "$signature"; then
    printf '[复用] %s 已运行，PID=%s\n' "$name" "$(cat "$pid_path")"
    return 0
  fi
  rm -f "$pid_path"

  printf '[启动] %s\n' "$name"
  nohup bash -c 'cd "$1" && shift && exec "$@"' _ "$workdir" "$@" >"$logfile" 2>&1 &
  local pid=$!
  printf '%s\n' "$pid" >"$pid_path"
  sleep 1
  if ! process_matches "$pid" "$signature"; then
    printf '[失败] %s 未能启动，请查看 %s\n' "$name" "$logfile" >&2
    return 1
  fi
  printf '[完成] %s，PID=%s，日志=%s\n' "$name" "$pid" "$logfile"
}

stop_process() {
  local name="$1" signature="$2" pid_path pid
  pid_path="$(pid_file "$name")"
  [[ -f "$pid_path" ]] || return 0
  pid="$(cat "$pid_path")"
  if process_matches "$pid" "$signature"; then
    printf '[停止] %s，PID=%s\n' "$name" "$pid"
    kill "$pid" 2>/dev/null || true
    for _ in {1..20}; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.25
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
  else
    printf '[跳过] %s 的 PID 文件已过期或进程签名不匹配\n' "$name"
  fi
  rm -f "$pid_path"
}

wait_for_url() {
  local url="$1" label="$2" timeout="${3:-60}"
  local end=$((SECONDS + timeout)) code
  while (( SECONDS < end )); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$url" 2>/dev/null || true)"
    # 2xx/3xx 就绪；401 同样说明服务已在响应（认证层拦截，属正常就绪信号）
    if [[ "$code" =~ ^[23][0-9][0-9]$ ]] || [[ "$code" == "401" ]]; then
      printf '[就绪] %s: %s\n' "$label" "$url"
      return 0
    fi
    sleep 1
  done
  printf '[超时] %s 未就绪: %s\n' "$label" "$url" >&2
  return 1
}

# 业务服务就绪判断：轮询 /actuator/health/readiness，要求 HTTP 200 且聚合 status=UP
# （readiness 分组含 db/flyway，就绪即代表迁移完成、数据库可连接）
wait_for_readiness() {
  local url="$1" label="$2" timeout="${3:-60}"
  local end=$((SECONDS + timeout))
  while (( SECONDS < end )); do
    if curl -fsS --max-time 3 "$url" 2>/dev/null \
        | python3 -c 'import sys,json; sys.exit(0 if json.load(sys.stdin).get("status") == "UP" else 1)' \
            2>/dev/null; then
      printf '[就绪] %s: %s\n' "$label" "$url"
      return 0
    fi
    sleep 1
  done
  printf '[超时] %s 未就绪: %s\n' "$label" "$url" >&2
  return 1
}

# 登录业务服务并导出 FJSP_AUTH_TOKEN（默认 admin 演示账号，可用 FJSP_AUTH_USER/FJSP_AUTH_PASSWORD 覆盖）
demo_auth_login() {
  local body
  body="$(curl -fsS -X POST "$FJSP_API_BASE/auth/login" \
    -H 'Content-Type: application/json' -H 'X-Source: demo-script' \
    -d "{\"username\":\"$FJSP_AUTH_USER\",\"password\":\"$FJSP_AUTH_PASSWORD\"}")" || {
      printf '登录业务服务失败: %s\n' "$FJSP_API_BASE" >&2
      return 1
    }
  FJSP_AUTH_TOKEN="$(printf '%s' "$body" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["token"])')"
  export FJSP_AUTH_TOKEN
}

# Compose needs the required password variable even for read-only commands such as
# `ps` and `stop`. Use a local placeholder only when no password was supplied;
# start-demo.sh still calls check-env.sh before any mutating Compose command.
docker_compose() {
  local compose_password="${FJSP_DB_PASSWORD:-unused-for-compose-read-only}"
  FJSP_DB_PASSWORD="$compose_password" docker compose -f "$ROOT_DIR/deploy/docker-compose.yml" "$@"
}

wait_for_container_health() {
  local container="$1" timeout="${2:-90}"
  local end=$((SECONDS + timeout)) status
  while (( SECONDS < end )); do
    status="$(docker inspect -f '{{.State.Health.Status}}' "$container" 2>/dev/null || true)"
    case "$status" in
      healthy) printf '[就绪] 容器 %s healthy\n' "$container"; return 0 ;;
      unhealthy) printf '[失败] 容器 %s unhealthy\n' "$container" >&2; return 1 ;;
    esac
    sleep 1
  done
  printf '[超时] 容器 %s 未通过健康检查\n' "$container" >&2
  return 1
}

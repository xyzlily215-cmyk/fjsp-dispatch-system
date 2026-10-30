#!/usr/bin/env bash
# 隔离回归环境一键脚本（任务 0.4）。
# 与演示环境完全隔离：独立 PostgreSQL 容器 fjsp-postgres-reg（deploy/docker-compose.regression.yml，
# compose project 名 fjsp-regression）、独立端口（DB 15432 / business 18081 / algorithm 18101，
# 均可由 FJSP_REG_* 覆盖）、独立凭据（FJSP_REG_DB_*，来自 .env.regression 或环境，不读演示用 .env）。
#
# 流程：拉起回归 DB → 以回归配置 + FJSP_SIMULATION_MODE=FIXED 启动算法/业务服务
#       → 跑 agh-integration/evaluation/scenarios/ 全部 6 个场景脚本（纯 API 断言，不拉起 AGH；
#         s05/s06 为全量业务断言，s01–s04 为扰动触发 + 脚本内业务断言，agent 行为回归属后续阶段）
#       → 停服务、down -v 清理回归容器与数据卷（默认；--keep 保留现场便于排查）。
#
# 用法：
#   scripts/run-regression.sh                 # 完整跑一遍并清理
#   scripts/run-regression.sh --keep          # 跑完保留回归环境（手动清理：--cleanup-only）
#   scripts/run-regression.sh --cleanup-only  # 只清理上一次 --keep 留下的回归环境
# 失败时输出服务日志尾部与容器状态作为诊断；任一场景断言失败则整体退出码非 0。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# 回归进程 PID/日志独立目录（须在 source demo-common.sh 前设置，避免与演示 runtime 混淆）
export FJSP_RUNTIME_DIR="${FJSP_RUNTIME_DIR:-${TMPDIR:-/tmp}/fjsp-regression}"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/demo-common.sh"

KEEP=0
CLEANUP_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    --cleanup-only) CLEANUP_ONLY=1 ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *) printf '未知参数: %s（-h 查看用法）\n' "$arg" >&2; exit 2 ;;
  esac
done

# ---- 回归环境变量：只读 .env.regression / FJSP_REG_*，绝不加载演示用 .env ----
load_regression_env() {
  local env_file="$ROOT_DIR/.env.regression"
  if [[ -f "$env_file" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$env_file"
    set +a
  fi
  export FJSP_REG_DB_PORT="${FJSP_REG_DB_PORT:-15432}"
  export FJSP_REG_DB_NAME="${FJSP_REG_DB_NAME:-fjsp_reg}"
  export FJSP_REG_DB_USER="${FJSP_REG_DB_USER:-fjsp_reg}"
  # 回归库为一次性实例：未显式给口令时生成本次运行专用的随机口令（compose 与业务服务共用）
  if [[ -z "${FJSP_REG_DB_PASSWORD:-}" || "$FJSP_REG_DB_PASSWORD" == "change-this-regression-password" ]]; then
    FJSP_REG_DB_PASSWORD="reg-$(openssl rand -hex 12)"
    printf '[口令] FJSP_REG_DB_PASSWORD 未设置或为占位值，已生成本次运行的一次性随机口令\n'
  fi
  export FJSP_REG_DB_PASSWORD
  export FJSP_REG_BUSINESS_PORT="${FJSP_REG_BUSINESS_PORT:-18081}"
  export FJSP_REG_ALGORITHM_PORT="${FJSP_REG_ALGORITHM_PORT:-18101}"
  export FJSP_REG_AUTH_USER="${FJSP_REG_AUTH_USER:-admin}"
  export FJSP_REG_AUTH_PASSWORD="${FJSP_REG_AUTH_PASSWORD:-Fj@123456}"
  # 场景脚本（common.mjs）读取的覆盖变量
  export FJSP_API_BASE="http://localhost:${FJSP_REG_BUSINESS_PORT}/api/v1"
  export FJSP_AUTH_USER="$FJSP_REG_AUTH_USER"
  export FJSP_AUTH_PASSWORD="$FJSP_REG_AUTH_PASSWORD"
}

# 回归 compose 固定独立 project 名：与演示 compose（project=deploy）隔离，
# down -v 只清理本项目资源，绝不触碰 fjsp-postgres / fjsp-pgdata。
reg_compose() {
  docker compose -p fjsp-regression -f "$ROOT_DIR/deploy/docker-compose.regression.yml" "$@"
}

reg_cleanup() {
  printf '\n== 清理回归环境 ==\n'
  stop_process business-reg "business-service-1.0.0.jar"
  stop_process algorithm-reg "uvicorn app.api:app --host 127.0.0.1 --port ${FJSP_REG_ALGORITHM_PORT:-18101}"
  reg_compose down -v
  printf '[完成] 回归容器与数据卷已清理（日志保留在 %s）\n' "$RUNTIME_DIR"
}

check_port_free() {
  local port="$1" label="$2"
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    printf '[冲突] %s 端口 %s 已被占用：\n' "$label" "$port" >&2
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >&2 || true
    printf '请改用 FJSP_REG_* 端口变量（写入 .env.regression 或直接 export）后重试。\n' >&2
    return 1
  fi
}

print_diagnostics() {
  printf '\n== 诊断信息 ==\n' >&2
  local name log
  for name in algorithm-reg business-reg; do
    log="$(log_file "$name")"
    if [[ -f "$log" ]]; then
      printf -- '---- %s 日志尾部（%s）----\n' "$name" "$log" >&2
      tail -n 40 "$log" >&2 || true
    fi
  done
  printf -- '---- 回归容器状态 ----\n' >&2
  docker ps -a --filter "name=fjsp-postgres-reg" >&2 || true
}

load_regression_env

if [[ "$CLEANUP_ONLY" == "1" ]]; then
  reg_cleanup
  exit 0
fi

require_command docker
require_command curl
require_command python3
require_command mvn
require_command java
require_command node
require_command lsof
require_command openssl

# 场景脚本用到 fetch / crypto.randomUUID，需 Node ≥ 18（无需 AGH 的 Node 24）
node_major="$(node -v | sed 's/^v//;s/\..*//')"
if [[ "$node_major" -lt 18 ]]; then
  printf '[失败] 场景脚本需要 Node ≥ 18，当前 v%s\n' "$node_major" >&2
  exit 1
fi

printf '\n== 0. 端口冲突预检（回归端口不得占用，也不复用演示端口）==\n'
check_port_free "$FJSP_REG_DB_PORT" "回归 PostgreSQL"
check_port_free "$FJSP_REG_BUSINESS_PORT" "回归业务服务"
check_port_free "$FJSP_REG_ALGORITHM_PORT" "回归算法服务"

STARTED=0
CLEANUP_DONE=0
on_exit() {
  local rc=$?
  if [[ "$rc" != "0" ]]; then
    print_diagnostics
  fi
  if [[ "$STARTED" == "1" && "$KEEP" == "0" && "$CLEANUP_DONE" == "0" ]]; then
    CLEANUP_DONE=1
    reg_cleanup || true
  elif [[ "$STARTED" == "1" && "$KEEP" == "1" ]]; then
    printf '\n[保留] --keep 生效：回归环境保留运行，清理请执行 %s --cleanup-only\n' "$0"
  fi
  exit "$rc"
}
trap on_exit EXIT

printf '\n== 1. 启动回归 PostgreSQL（容器 fjsp-postgres-reg，端口 %s）==\n' "$FJSP_REG_DB_PORT"
reg_compose up -d postgres-reg
STARTED=1
wait_for_container_health fjsp-postgres-reg

printf '\n== 2. 启动回归算法服务（端口 %s）==\n' "$FJSP_REG_ALGORITHM_PORT"
if ! curl -fsS --max-time 3 "http://127.0.0.1:${FJSP_REG_ALGORITHM_PORT}/health" >/dev/null 2>&1; then
  start_process algorithm-reg \
    "uvicorn app.api:app --host 127.0.0.1 --port ${FJSP_REG_ALGORITHM_PORT}" \
    "$ROOT_DIR/algorithm-service" "$(log_file algorithm-reg)" \
    python3 -m uvicorn app.api:app --host 127.0.0.1 --port "$FJSP_REG_ALGORITHM_PORT" --workers 1
fi
wait_for_url "http://127.0.0.1:${FJSP_REG_ALGORITHM_PORT}/health" "回归算法服务"

printf '\n== 3. 构建并启动回归业务服务（端口 %s，FJSP_SIMULATION_MODE=FIXED）==\n' "$FJSP_REG_BUSINESS_PORT"
if ! curl -fsS --max-time 3 "http://127.0.0.1:${FJSP_REG_BUSINESS_PORT}/actuator/health/readiness" >/dev/null 2>&1; then
  jar="$ROOT_DIR/business-service/target/business-service-1.0.0.jar"
  if [[ "${FJSP_SKIP_BUILD:-0}" == "1" && -f "$jar" ]]; then
    printf '[跳过] FJSP_SKIP_BUILD=1，沿用现有构建产物 %s\n' "$jar"
  elif [[ -f "$jar" ]] \
    && [[ -z "$(find "$ROOT_DIR/business-service/src" "$ROOT_DIR/business-service/pom.xml" -newer "$jar" -print -quit)" ]]; then
    printf '[跳过] %s 已新于 src/ 与 pom.xml，跳过 Maven 构建。\n' "$jar"
  else
    (cd "$ROOT_DIR/business-service" && mvn -q -DskipTests package)
  fi
  # 数据源指向回归库；local profile 提供演示种子账号与 /demo/reset；
  # FIXED 仿真模式把 simulationStartAt 固定为种子文件的 2026-09-16T08:00+08:00（golden-set.md 2.2 节）
  start_process business-reg "business-service-1.0.0.jar" \
    "$ROOT_DIR/business-service" "$(log_file business-reg)" \
    env SPRING_PROFILES_ACTIVE=local \
      SERVER_PORT="$FJSP_REG_BUSINESS_PORT" \
      FJSP_DB_HOST=127.0.0.1 \
      FJSP_DB_PORT="$FJSP_REG_DB_PORT" \
      FJSP_DB_NAME="$FJSP_REG_DB_NAME" \
      FJSP_DB_USER="$FJSP_REG_DB_USER" \
      FJSP_DB_PASSWORD="$FJSP_REG_DB_PASSWORD" \
      FJSP_ALGORITHM_BASE_URL="http://127.0.0.1:${FJSP_REG_ALGORITHM_PORT}" \
      FJSP_SIMULATION_MODE=FIXED \
      java -jar target/business-service-1.0.0.jar
fi
wait_for_readiness "http://127.0.0.1:${FJSP_REG_BUSINESS_PORT}/actuator/health/readiness" "回归业务服务" 180

printf '\n== 4. 运行 Golden 场景断言（API %s，不拉起 AGH）==\n' "$FJSP_API_BASE"
SCENARIOS=(
  s01-machine-breakdown
  s02-urgent-order
  s03-mixed-disturbance
  s04-infeasible
  s05-duplicate-alert
  s06-review-reject
)
summary_file="$RUNTIME_DIR/scenario-results.jsonl"
: >"$summary_file"
failed=0
for scenario in "${SCENARIOS[@]}"; do
  printf '\n---- 场景 %s ----\n' "$scenario"
  if node "$ROOT_DIR/agh-integration/evaluation/scenarios/${scenario}.mjs" \
      | tee >(grep '^SCENARIO_RESULT ' >>"$summary_file" || true); then
    printf '[通过] %s\n' "$scenario"
  else
    printf '[失败] %s（断言未全过，见上方 FAIL 行）\n' "$scenario" >&2
    failed=1
    break
  fi
done

printf '\n== 回归汇总 ==\n'
printf '场景结果（SCENARIO_RESULT）：%s\n' "$summary_file"
if [[ "$failed" == "1" ]]; then
  printf '[失败] 存在未通过场景，回归不通过。\n' >&2
  exit 1
fi
printf '[通过] 全部 %d 个场景断言通过。\n' "${#SCENARIOS[@]}"

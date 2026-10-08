#!/usr/bin/env bash
# 性能基线：对核心 SQL 跑 EXPLAIN ANALYZE，输出扫描方式与耗时。
# 用法：./scripts/perf-baseline.sh [标签]
# 对比索引效果：应用 V4 前跑一次（如 ./scripts/perf-baseline.sh before），
# 应用 V4 后再跑一次（./scripts/perf-baseline.sh after）。
# 小数据量下规划器仍选 Seq Scan（正确决策）；PG_FORCE_INDEX=1 可强制禁用顺序扫描以验证索引可用性。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/demo-common.sh"
load_demo_env

require_command docker

PG_CONTAINER="${PG_CONTAINER:-fjsp-postgres}"
LABEL="${1:-baseline}"

PV_SQL="(SELECT id FROM plan_version ORDER BY created_at DESC LIMIT 1)"

explain() {
  local name="$1" sql="$2" out scan time
  out="$(docker exec "$PG_CONTAINER" psql -U "$FJSP_DB_USER" -d "$FJSP_DB_NAME" -At \
    -c "${PG_FORCE_INDEX:+SET enable_seqscan=off;} EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF) $sql")"
  scan="$(printf '%s\n' "$out" | grep -oE '(Seq Scan|Index Scan|Index Only Scan|Bitmap Heap Scan)( backward)?( using [a-z0-9_]+)?' | head -1)"
  time="$(printf '%s\n' "$out" | grep -oE 'Execution Time: [0-9.]+ ms' | head -1 | sed 's/Execution Time: //')"
  printf '| %s | %s | %s |\n' "$name" "${scan:-?}" "${time:-?}"
}

printf '== 性能基线（%s）==  库=%s 容器=%s\n' "$LABEL" "$FJSP_DB_NAME" "$PG_CONTAINER"
docker exec "$PG_CONTAINER" psql -U "$FJSP_DB_USER" -d "$FJSP_DB_NAME" -At -c \
  "SELECT 'schedule_task=' || (SELECT count(*) FROM schedule_task) || ' plan_version=' || (SELECT count(*) FROM plan_version) || ' schedule_operation=' || (SELECT count(*) FROM schedule_operation) || ' event=' || (SELECT count(*) FROM event) || ' audit_log=' || (SELECT count(*) FROM audit_log);"
printf '| 查询 | 计划节点 | 耗时 |\n|---|---|---|\n'
explain '看板最近事件 recentEvents'  "SELECT * FROM event ORDER BY occurred_at DESC LIMIT 5"
explain '看板最近任务 recentTasks'  "SELECT * FROM schedule_task ORDER BY created_at DESC LIMIT 5"
explain '任务列表分页'              "SELECT * FROM schedule_task ORDER BY created_at DESC LIMIT 20 OFFSET 0"
explain '计划版本列表分页'          "SELECT * FROM plan_version ORDER BY created_at DESC LIMIT 20 OFFSET 0"
explain '计划详情工序'              "SELECT * FROM schedule_operation WHERE plan_version_id = $PV_SQL"
explain '事件列表过滤(BREAKDOWN)'   "SELECT * FROM event WHERE event_type = 'BREAKDOWN' ORDER BY occurred_at DESC LIMIT 50"
explain '审计查询(object_type)'     "SELECT * FROM audit_log WHERE object_type = 'plan_version' ORDER BY created_at DESC LIMIT 20"

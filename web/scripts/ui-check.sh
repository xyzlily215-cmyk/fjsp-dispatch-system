#!/usr/bin/env bash
# ui-check.sh — 验证前端（8082）跨域访问业务服务（8081）的关键接口
# 用法: bash web/scripts/ui-check.sh
set -euo pipefail
ORIGIN="http://localhost:8082"
API="http://localhost:8081/api/v1"
FAIL=0

check_cors() {
  local method="$1" path="$2"
  local resp header
  resp=$(curl -s -i -H "Origin: $ORIGIN" "$API$path") || true
  header=$(printf '%s' "$resp" | grep -i '^Access-Control-Allow-Origin:' | tr -d '\r') || true
  if printf '%s' "$header" | grep -q "$ORIGIN"; then
    echo "PASS  CORS $method $path -> $header"
  else
    echo "FAIL  CORS $method $path (missing Access-Control-Allow-Origin)"; FAIL=1
  fi
}

check_preflight() {
  local path="$1" req_method="$2"
  local resp
  resp=$(curl -s -i -X OPTIONS -H "Origin: $ORIGIN" \
    -H "Access-Control-Request-Method: $req_method" \
    -H "Access-Control-Request-Headers: content-type,idempotency-key" \
    "$API$path") || true
  if printf '%s' "$resp" | grep -qi "Access-Control-Allow-Origin: $ORIGIN" \
     && printf '%s' "$resp" | grep -qi "idempotency-key"; then
    echo "PASS  preflight $req_method $path"
  else
    echo "FAIL  preflight $req_method $path"; FAIL=1
  fi
}

check_static() {
  local path="$1"
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:8082$path") || true
  if [ "$code" = "200" ]; then echo "PASS  static $path"; else echo "FAIL  static $path (HTTP $code)"; FAIL=1; fi
}

echo "== 静态资源 =="
for p in /index.html /css/app.css /js/api.js /js/app.js /js/util.js /js/pages-board.js /js/pages-gantt.js /js/pages-compare.js /js/pages-schedule.js /js/pages-events.js /js/pages-review.js /js/pages-misc.js; do
  check_static "$p"
done

echo "== CORS 简单请求（带 Origin） =="
for p in /dashboard /machines /orders /process-templates /schedule-tasks /plan-versions; do
  check_cors GET "$p"
done

echo "== CORS 预检（POST 写接口） =="
check_preflight /schedule-tasks POST
check_preflight /events/new-orders POST
check_preflight /events/breakdowns POST
check_preflight /plan-versions/some-id/publish POST
check_preflight /operations/O001-10/execution POST
check_preflight /demo/reset POST
check_preflight /machines POST
check_preflight /machines/M-01 PUT
check_preflight /machines/M-01/status POST
check_preflight /calendars/CAL-M-01/intervals POST
check_preflight /process-templates POST
check_preflight /process-templates/some-id/status POST
check_preflight /process-templates/some-id/copy POST
check_preflight /orders POST
check_preflight /orders/O001 PUT

if [ "$FAIL" = "0" ]; then echo "ALL PASS"; else echo "SOME CHECKS FAILED"; exit 1; fi

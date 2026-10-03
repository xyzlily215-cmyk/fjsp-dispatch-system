#!/usr/bin/env bash
# FJSP 业务服务全流程冒烟测试
# 前置：业务服务运行在 8080，算法服务运行在 ${ALGO:-8101}
set -u
BASE="${BASE:-http://localhost:8081/api/v1}"
PASS=0
FAIL=0

say()  { printf '\n\033[1;34m== %s ==\033[0m\n' "$*"; }
ok()   { PASS=$((PASS+1)); printf '\033[32m[PASS]\033[0m %s\n' "$*"; }
bad()  { FAIL=$((FAIL+1)); printf '\033[31m[FAIL]\033[0m %s\n' "$*"; }
jqget(){ python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(\"d\"+sys.argv[1]))" "$1" 2>/dev/null; }

# 计划版本乐观锁辅助：submit-review/review/publish/revise 均需携带当前 version
pv_version(){ curl -s "$BASE/plan-versions/$1" | jqget "['data']['version']"; }
submit_review(){ curl -s -X POST "$BASE/plan-versions/$1/submit-review" \
  -H 'Content-Type: application/json' -d "{\"version\":$(pv_version "$1")}"; }

# 直连 Postgres 校验审计落库（可用环境变量覆盖）
PG_CONTAINER="${PG_CONTAINER:-fjsp-postgres}"
PG_USER="${PG_USER:-fjsp}"
PG_DB="${PG_DB:-fjsp}"
psqlq(){ docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -t -A -c "$1" 2>/dev/null; }

say "0. demo/reset 重置并重新 seed"
RESET=$(curl -s -X POST "$BASE/demo/reset")
echo "$RESET" | head -c 300; echo

say "1. GET /machines 应返回 8 台设备"
MACHINES=$(curl -s "$BASE/machines")
COUNT=$(echo "$MACHINES" | python3 -c "import sys,json;print(len(json.load(sys.stdin)['data']))")
[ "$COUNT" = "8" ] && ok "8 台设备" || bad "设备数量=$COUNT"

say "2. 创建基线任务"
TASK_RESP=$(curl -s -X POST "$BASE/schedule-tasks" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: smoke-baseline-001' \
  -d '{"mode":"BASELINE"}')
echo "$TASK_RESP" | head -c 300; echo
TASK_ID=$(echo "$TASK_RESP" | jqget "['data']['taskId']")
[ -n "$TASK_ID" ] && ok "任务创建 taskId=$TASK_ID" || { bad "任务创建失败"; exit 1; }

say "2b. 幂等重放：相同 Idempotency-Key 相同请求应返回原 taskId"
REPLAY=$(curl -s -X POST "$BASE/schedule-tasks" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: smoke-baseline-001' \
  -d '{"mode":"BASELINE"}')
REPLAY_ID=$(echo "$REPLAY" | jqget "['data']['taskId']")
[ "$REPLAY_ID" = "$TASK_ID" ] && ok "幂等重放返回原 taskId" || bad "幂等重放失败: $REPLAY"

say "2c. 幂等冲突：相同 Key 不同请求应返回 E_DUPLICATE"
DUP=$(curl -s -X POST "$BASE/schedule-tasks" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: smoke-baseline-001' \
  -d '{"mode":"BASELINE","freezeWindowMinutes":60}')
DUP_CODE=$(echo "$DUP" | jqget "['code']")
[ "$DUP_CODE" = "E_DUPLICATE" ] && ok "同键不同摘要返回 E_DUPLICATE" || bad "幂等冲突未触发: $DUP"

say "3. 轮询基线任务直到终态"
for i in $(seq 1 90); do
  T=$(curl -s "$BASE/schedule-tasks/$TASK_ID")
  STATUS=$(echo "$T" | jqget "['data']['status']")
  [ "$STATUS" = "SUCCESS" ] || [ "$STATUS" = "TIME_LIMIT" ] || [ "$STATUS" = "INFEASIBLE" ] || [ "$STATUS" = "FAILED" ] && break
  sleep 2
done
echo "$T" | python3 -m json.tool | head -30
PV1=$(echo "$T" | jqget "['data']['planVersionId']")
{ [ "$STATUS" = "SUCCESS" ] || [ "$STATUS" = "TIME_LIMIT" ]; } && [ -n "$PV1" ] && [ "$PV1" != "None" ] \
  && ok "基线任务完成 status=$STATUS planVersionId=$PV1" || { bad "基线任务未成功: status=$STATUS"; exit 1; }

say "4. 提交审核 -> 审核通过 -> 发布"
SUB=$(submit_review "$PV1")
echo "$SUB" | head -c 200; echo
VER=$(echo "$SUB" | jqget "['data']['version']")
[ "$(echo "$SUB" | jqget "['data']['status']")" = "REVIEW_PENDING" ] && ok "提交审核" || bad "提交审核失败"

REV=$(curl -s -X POST "$BASE/plan-versions/$PV1/review" -H 'Content-Type: application/json' \
  -d "{\"decision\":\"APPROVE\",\"comment\":\"smoke ok\",\"version\":$VER}")
VER=$(echo "$REV" | jqget "['data']['version']")
[ "$(echo "$REV" | jqget "['data']['status']")" = "REVIEWED" ] && ok "审核通过" || bad "审核失败: $REV"

PUB=$(curl -s -X POST "$BASE/plan-versions/$PV1/publish" -H 'Content-Type: application/json' \
  -d "{\"version\":$VER}")
[ "$(echo "$PUB" | jqget "['data']['status']")" = "PUBLISHED" ] && ok "发布成功" || bad "发布失败: $PUB"

say "5. 执行反馈：首个 RUNNING 使计划转 EXECUTING"
FIRST_OP=$(curl -s "$BASE/plan-versions/$PV1" | python3 -c "
import sys,json
d=json.load(sys.stdin)['data']['operations']
d.sort(key=lambda o:o['startAt'])
print(d[0]['operationId'])")
EX=$(curl -s -X POST "$BASE/operations/$FIRST_OP/execution" -H 'Content-Type: application/json' \
  -d '{"status":"RUNNING"}')
[ "$(echo "$EX" | jqget "['data']['planVersionStatus']")" = "EXECUTING" ] && ok "PUBLISHED->EXECUTING" || bad "执行反馈异常: $EX"
EX2=$(curl -s -X POST "$BASE/operations/$FIRST_OP/execution" -H 'Content-Type: application/json' \
  -d '{"status":"COMPLETED"}')
[ "$(echo "$EX2" | jqget "['data']['status']")" = "COMPLETED" ] && ok "COMPLETED 反馈" || bad "COMPLETED 失败: $EX2"

say "6. 创建故障事件（M-03，仿真时间 2026-09-17 08:00 +08:00 修 120 分钟）"
BD=$(curl -s -X POST "$BASE/events/breakdowns" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: smoke-breakdown-001' \
  -d '{"machineId":"M-03","occurredAt":"2026-09-17T08:00:00+08:00","repairDurationMinutes":120,"source":"smoke","note":"冒烟测试故障"}')
echo "$BD" | head -c 400; echo
EVENT_ID=$(echo "$BD" | jqget "['data']['eventId']")
[ -n "$EVENT_ID" ] && [ "$EVENT_ID" != "None" ] && ok "故障事件创建 eventId=$EVENT_ID" || bad "故障事件失败: $BD"

say "6b. GET /events/{id} 影响集合明细"
curl -s "$BASE/events/$EVENT_ID" | python3 -c "
import sys,json
d=json.load(sys.stdin)['data']
print('impactSummary:', d['impactSummary'])
for i in d['impacts'][:5]: print(' ', i['operationId'], i['impactType'], i['lockType'])"

say "7. LOCAL_RESCHEDULE 重调度任务"
LT=$(curl -s -X POST "$BASE/schedule-tasks" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: smoke-local-001' \
  -d "{\"mode\":\"LOCAL_RESCHEDULE\",\"oldPlanVersionId\":\"$PV1\",\"eventId\":\"$EVENT_ID\"}")
TASK2=$(echo "$LT" | jqget "['data']['taskId']")
[ -n "$TASK2" ] && [ "$TASK2" != "None" ] && ok "重调度任务创建 taskId=$TASK2" || { bad "重调度任务创建失败: $LT"; exit 1; }
for i in $(seq 1 90); do
  T2=$(curl -s "$BASE/schedule-tasks/$TASK2")
  STATUS2=$(echo "$T2" | jqget "['data']['status']")
  [ "$STATUS2" = "SUCCESS" ] || [ "$STATUS2" = "TIME_LIMIT" ] || [ "$STATUS2" = "INFEASIBLE" ] || [ "$STATUS2" = "FAILED" ] && break
  sleep 2
done
PV2=$(echo "$T2" | jqget "['data']['planVersionId']")
{ [ "$STATUS2" = "SUCCESS" ] || [ "$STATUS2" = "TIME_LIMIT" ]; } && [ -n "$PV2" ] && [ "$PV2" != "None" ] \
  && ok "重调度完成 status=$STATUS2 planVersionId=$PV2" || { bad "重调度未成功: $T2"; exit 1; }

say "8. diff 基线 vs 重调度"
curl -s "$BASE/plan-versions/$PV2/diff?baselineVersionId=$PV1" | python3 -c "
import sys,json
d=json.load(sys.stdin)['data']
print('summary:', json.dumps(d['summary'], ensure_ascii=False)[:400])
print('kpiDiff:', json.dumps(d['kpiDiff'], ensure_ascii=False)[:300])"

say "9. 并发发布：两个 REVIEWED 候选只有一个成功"
# 先让 PV2 走审核流
SUB2=$(submit_review "$PV2")
V2=$(echo "$SUB2" | jqget "['data']['version']")
curl -s -X POST "$BASE/plan-versions/$PV2/review" -H 'Content-Type: application/json' \
  -d "{\"decision\":\"APPROVE\",\"comment\":\"ok\",\"version\":$V2}" > /dev/null
V2=$(curl -s "$BASE/plan-versions/$PV2" | jqget "['data']['version']")
# 再造一个重调度候选 PV3
LT3=$(curl -s -X POST "$BASE/schedule-tasks" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: smoke-local-002' \
  -d "{\"mode\":\"LOCAL_RESCHEDULE\",\"oldPlanVersionId\":\"$PV1\",\"eventId\":\"$EVENT_ID\",\"algorithm\":{\"randomSeed\":42}}")
TASK3=$(echo "$LT3" | jqget "['data']['taskId']")
for i in $(seq 1 90); do
  T3=$(curl -s "$BASE/schedule-tasks/$TASK3")
  STATUS3=$(echo "$T3" | jqget "['data']['status']")
  [ "$STATUS3" = "SUCCESS" ] || [ "$STATUS3" = "TIME_LIMIT" ] || [ "$STATUS3" = "INFEASIBLE" ] || [ "$STATUS3" = "FAILED" ] && break
  sleep 2
done
PV3=$(echo "$T3" | jqget "['data']['planVersionId']")
SUB3=$(submit_review "$PV3")
V3=$(echo "$SUB3" | jqget "['data']['version']")
curl -s -X POST "$BASE/plan-versions/$PV3/review" -H 'Content-Type: application/json' \
  -d "{\"decision\":\"APPROVE\",\"comment\":\"ok\",\"version\":$V3}" > /dev/null
V3=$(curl -s "$BASE/plan-versions/$PV3" | jqget "['data']['version']")

R1=$(mktemp); R2=$(mktemp)
curl -s -X POST "$BASE/plan-versions/$PV2/publish" -H 'Content-Type: application/json' -d "{\"version\":$V2}" > "$R1" &
curl -s -X POST "$BASE/plan-versions/$PV3/publish" -H 'Content-Type: application/json' -d "{\"version\":$V3}" > "$R2" &
wait
C1=$(jqget "['code']" < "$R1"); C2=$(jqget "['code']" < "$R2")
echo "publish PV2 -> $C1 ; publish PV3 -> $C2"
# 败者可能因乐观锁冲突得到 E_VERSION_STALE，或因基准版本(PV1)已被取代得到 E_PLAN_STALE
CONCUR_OK=0
if [ "$C1" = "OK" ] && { [ "$C2" = "E_VERSION_STALE" ] || [ "$C2" = "E_PLAN_STALE" ]; }; then
  CONCUR_OK=1; WINNER_PV=$PV2; LOSER_PV=$PV3
elif [ "$C2" = "OK" ] && { [ "$C1" = "E_VERSION_STALE" ] || [ "$C1" = "E_PLAN_STALE" ]; }; then
  CONCUR_OK=1; WINNER_PV=$PV3; LOSER_PV=$PV2
fi
if [ "$CONCUR_OK" = "1" ]; then
  ok "并发发布只有一个成功（胜者 ${WINNER_PV}，败者 ${LOSER_PV}）"
else
  bad "并发发布结果异常: $C1 / $C2"
fi
rm -f "$R1" "$R2"

say "10. E_EVENT_IN_PROCESS：执行中工序区间内登记故障"
# 找一个当前发布计划中未来开始的工序，反馈 RUNNING，再在其计划区间内登记故障
TARGET=$(curl -s "$BASE/plan-versions" | python3 -c "
import sys,json
vs=[v for v in json.load(sys.stdin)['data'] if v['status'] in ('PUBLISHED','EXECUTING')]
print(vs[0]['id'])")
INP_OP=$(curl -s "$BASE/plan-versions/$TARGET" | python3 -c "
import sys,json,datetime
ops=json.load(sys.stdin)['data']['operations']
future=[o for o in ops if o['startAt'] > '2026-09-16T08:05']
future.sort(key=lambda o:o['startAt'])
print(future[0]['operationId']+'|'+future[0]['machineId']+'|'+future[0]['startAt'] if future else '')")
OP_ID=$(echo "$INP_OP" | cut -d'|' -f1)
OP_M=$(echo "$INP_OP" | cut -d'|' -f2)
OP_S=$(echo "$INP_OP" | cut -d'|' -f3)
curl -s -X POST "$BASE/operations/$OP_ID/execution" -H 'Content-Type: application/json' -d '{"status":"RUNNING"}' > /dev/null
# occurredAt 落在该工序计划区间内
OCCUR=$(python3 -c "
import datetime
s='$OP_S'.replace('Z','+00:00')
t=datetime.datetime.fromisoformat(s)+datetime.timedelta(minutes=1)
print(t.isoformat())")
EIP=$(curl -s -X POST "$BASE/events/breakdowns" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: smoke-breakdown-002' \
  -d "{\"machineId\":\"$OP_M\",\"occurredAt\":\"$OCCUR\",\"repairDurationMinutes\":30}")
[ "$(echo "$EIP" | jqget "['code']")" = "E_EVENT_IN_PROCESS" ] && ok "E_EVENT_IN_PROCESS 触发" || bad "E_EVENT_IN_PROCESS 未触发: $EIP"

say "11. 插单事件"
NO=$(curl -s -X POST "$BASE/events/new-orders" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: smoke-neworder-001' \
  -d '{"subType":"URGENT_INSERT","productFamily":"轴类A","quantity":10,"occurredAt":"2026-09-17T08:00:00+08:00","arrivalAt":"2026-09-17T08:00:00+08:00","dueAt":"2026-09-19T20:00:00+08:00","priority":5,"note":"冒烟插单"}')
echo "$NO" | head -c 400; echo
[ "$(echo "$NO" | jqget "['code']")" = "OK" ] && ok "插单成功" || bad "插单失败: $NO"
NO2=$(curl -s -X POST "$BASE/events/new-orders" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: smoke-neworder-002' \
  -d '{"subType":"NORMAL_APPEND","orderCode":"ORD-20260916-001","productFamily":"轴类A","quantity":5,"dueAt":"2026-09-19T20:00:00+08:00","priority":3}')
[ "$(echo "$NO2" | jqget "['code']")" = "E_DUPLICATE" ] && ok "重复订单号返回 E_DUPLICATE" || bad "重复订单号未拦截: $NO2"

say "12. dashboard 聚合"
curl -s "$BASE/dashboard" | python3 -c "
import sys,json
d=json.load(sys.stdin)['data']
print('currentPlan:', (d['currentPlan'] or {}).get('versionCode'), (d['currentPlan'] or {}).get('status'))
print('orderStats:', d['orderStats'])
print('machines:', len(d['machines']), 'recentEvents:', len(d['recentEvents']), 'recentTasks:', len(d['recentTasks']))
print('exceptions.breakdowns:', len(d['exceptions']['breakdowns']))"

say "13. 状态机：DRAFT 直接发布应返回 E_STATE_CONFLICT"
# 专用基线任务，避免破坏主线场景状态
BT=$(curl -s -X POST "$BASE/schedule-tasks" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: smoke-baseline-002' \
  -d '{"mode":"BASELINE"}')
TASK4=$(echo "$BT" | jqget "['data']['taskId']")
[ -n "$TASK4" ] && [ "$TASK4" != "None" ] && ok "专用基线任务创建 taskId=$TASK4" || { bad "专用基线任务创建失败: $BT"; exit 1; }
for i in $(seq 1 90); do
  T4=$(curl -s "$BASE/schedule-tasks/$TASK4")
  STATUS4=$(echo "$T4" | jqget "['data']['status']")
  [ "$STATUS4" = "SUCCESS" ] || [ "$STATUS4" = "TIME_LIMIT" ] || [ "$STATUS4" = "INFEASIBLE" ] || [ "$STATUS4" = "FAILED" ] && break
  sleep 2
done
PVX=$(echo "$T4" | jqget "['data']['planVersionId']")
{ [ "$STATUS4" = "SUCCESS" ] || [ "$STATUS4" = "TIME_LIMIT" ]; } && [ -n "$PVX" ] && [ "$PVX" != "None" ] \
  && ok "专用基线完成 status=$STATUS4 planVersionId=$PVX" || { bad "专用基线未成功: $T4"; exit 1; }
PUB_DRAFT=$(curl -s -X POST "$BASE/plan-versions/$PVX/publish" -H 'Content-Type: application/json' \
  -d "{\"version\":$(pv_version "$PVX")}")
[ "$(echo "$PUB_DRAFT" | jqget "['code']")" = "E_STATE_CONFLICT" ] \
  && ok "DRAFT 直接发布被拒 E_STATE_CONFLICT" || bad "DRAFT 直接发布未被拒: $PUB_DRAFT"

say "14. 状态机：REVIEW_PENDING 直接发布应返回 E_STATE_CONFLICT"
SUBX=$(submit_review "$PVX")
[ "$(echo "$SUBX" | jqget "['data']['status']")" = "REVIEW_PENDING" ] \
  && ok "PVX 提交审核 REVIEW_PENDING" || { bad "PVX 提交审核失败: $SUBX"; exit 1; }
PUB_PEND=$(curl -s -X POST "$BASE/plan-versions/$PVX/publish" -H 'Content-Type: application/json' \
  -d "{\"version\":$(pv_version "$PVX")}")
[ "$(echo "$PUB_PEND" | jqget "['code']")" = "E_STATE_CONFLICT" ] \
  && ok "REVIEW_PENDING 直接发布被拒 E_STATE_CONFLICT" || bad "REVIEW_PENDING 直接发布未被拒: $PUB_PEND"

say "15. 审核驳回 -> revise 修订回 DRAFT"
V=$(pv_version "$PVX")
REJ=$(curl -s -X POST "$BASE/plan-versions/$PVX/review" -H 'Content-Type: application/json' \
  -d "{\"decision\":\"REJECT\",\"comment\":\"smoke reject\",\"version\":$V}")
[ "$(echo "$REJ" | jqget "['data']['status']")" = "REJECTED" ] \
  && ok "审核驳回 REJECTED" || { bad "审核驳回失败: $REJ"; exit 1; }
RV=$(curl -s -X POST "$BASE/plan-versions/$PVX/revise" -H 'Content-Type: application/json' \
  -d "{\"version\":$(pv_version "$PVX")}")
[ "$(echo "$RV" | jqget "['data']['status']")" = "DRAFT" ] \
  && ok "revise 回到 DRAFT" || bad "revise 失败: $RV"

say "16. submit-review 携带过期 version 应返回 E_VERSION_STALE"
V=$(pv_version "$PVX")
STALE_SUB=$(curl -s -X POST "$BASE/plan-versions/$PVX/submit-review" -H 'Content-Type: application/json' \
  -d "{\"version\":$((V+999))}")
[ "$(echo "$STALE_SUB" | jqget "['code']")" = "E_VERSION_STALE" ] \
  && ok "过期 version 提交审核被拒 E_VERSION_STALE" || bad "过期 version 未被拒: $STALE_SUB"
SUBX2=$(submit_review "$PVX")
[ "$(echo "$SUBX2" | jqget "['data']['status']")" = "REVIEW_PENDING" ] \
  && ok "正确 version 再次提交审核成功" || { bad "再次提交审核失败: $SUBX2"; exit 1; }

say "17. 快照之后发生新扰动，发布应返回 E_PLAN_STALE"
# 顺带验证自定义请求头透传（场景 20 校验落库）
V=$(pv_version "$PVX")
APP=$(curl -s -X POST "$BASE/plan-versions/$PVX/review" -H 'Content-Type: application/json' \
  -H 'X-Operator-Id: smoke-tester' -H 'X-Source: smoke' -H 'X-AGH-Session-Id: smoke-session-1' \
  -d "{\"decision\":\"APPROVE\",\"comment\":\"smoke approve with headers\",\"version\":$V}")
[ "$(echo "$APP" | jqget "['data']['status']")" = "REVIEWED" ] \
  && ok "带请求头审核通过 REVIEWED" || { bad "审核通过失败: $APP"; exit 1; }
NE=$(curl -s -X POST "$BASE/events/new-orders" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: smoke-neworder-stale-001' \
  -d '{"subType":"URGENT_INSERT","productFamily":"轴类A","quantity":3,"occurredAt":"2026-09-18T08:00:00+08:00","arrivalAt":"2026-09-18T08:00:00+08:00","dueAt":"2026-09-20T20:00:00+08:00","priority":4,"note":"快照后新扰动"}')
[ "$(echo "$NE" | jqget "['code']")" = "OK" ] && ok "快照后新事件已登记" || bad "新事件登记失败: $NE"
PUB_STALE=$(curl -s -X POST "$BASE/plan-versions/$PVX/publish" -H 'Content-Type: application/json' \
  -d "{\"version\":$(pv_version "$PVX")}")
[ "$(echo "$PUB_STALE" | jqget "['code']")" = "E_PLAN_STALE" ] \
  && ok "快照后新扰动发布被拒 E_PLAN_STALE" || bad "E_PLAN_STALE(新扰动) 未触发: $PUB_STALE"

say "18. 基准版本已被取代的候选发布应返回 E_PLAN_STALE"
# 场景 9 并发发布的败者仍为 REVIEWED，其 parent(PV1) 已被取代
PUB_LOSER=$(curl -s -X POST "$BASE/plan-versions/$LOSER_PV/publish" -H 'Content-Type: application/json' \
  -d "{\"version\":$(pv_version "$LOSER_PV")}")
[ "$(echo "$PUB_LOSER" | jqget "['code']")" = "E_PLAN_STALE" ] \
  && ok "基准被取代候选发布被拒 E_PLAN_STALE" || bad "E_PLAN_STALE(基准取代) 未触发: $PUB_LOSER"

say "19. 审计字段落库（audit_log / plan_version）"
AUD=$(psqlq "SELECT COALESCE(operator,'') || '|' || COALESCE(source,'') || '|' || COALESCE(request_id,'') FROM audit_log WHERE action='PLAN_PUBLISH' ORDER BY created_at DESC LIMIT 1")
echo "latest PLAN_PUBLISH audit: $AUD"
A_OP=$(echo "$AUD" | cut -d'|' -f1)
A_SRC=$(echo "$AUD" | cut -d'|' -f2)
A_RID=$(echo "$AUD" | cut -d'|' -f3)
[ -n "$A_OP" ] && [ -n "$A_SRC" ] && [ -n "$A_RID" ] \
  && ok "audit_log operator/source/request_id 非空" \
  || bad "audit_log 审计字段缺失（可用 PG_CONTAINER/PG_USER/PG_DB 覆盖连接）: $AUD"
PVR=$(psqlq "SELECT COALESCE(reviewed_by,'') || '|' || COALESCE(reviewed_at::text,'') || '|' || COALESCE(published_by,'') || '|' || COALESCE(published_at::text,'') FROM plan_version WHERE id='$WINNER_PV'")
echo "published plan_version row ($WINNER_PV): $PVR"
P_REVIEWED_BY=$(echo "$PVR" | cut -d'|' -f1)
P_REVIEWED_AT=$(echo "$PVR" | cut -d'|' -f2)
P_PUBLISHED_BY=$(echo "$PVR" | cut -d'|' -f3)
P_PUBLISHED_AT=$(echo "$PVR" | cut -d'|' -f4)
[ -n "$P_REVIEWED_BY" ] && [ -n "$P_REVIEWED_AT" ] && [ -n "$P_PUBLISHED_BY" ] && [ -n "$P_PUBLISHED_AT" ] \
  && ok "plan_version reviewed_by/reviewed_at/published_by/published_at 非空" \
  || bad "plan_version 审计字段缺失: $PVR"

say "20. 请求头 X-Operator-Id/X-Source/X-AGH-Session-Id 透传到 audit_log"
HDR=$(psqlq "SELECT COALESCE(operator,'') || '|' || COALESCE(source,'') || '|' || COALESCE(session_id,'') FROM audit_log WHERE action='PLAN_REVIEW_APPROVE' AND object_id='$PVX' ORDER BY created_at DESC LIMIT 1")
[ "$HDR" = "smoke-tester|smoke|smoke-session-1" ] \
  && ok "审计行携带自定义请求头" || bad "请求头透传异常: $HDR"

printf '\n\033[1m结果: PASS=%d FAIL=%d\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" = "0" ]

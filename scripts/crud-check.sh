#!/usr/bin/env bash
# crud-check.sh — 新增基础数据写接口冒烟（正例 + 负例校验）
# 用法: bash web/scripts/crud-check.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../../scripts/demo-common.sh"
load_demo_env
API="${FJSP_API:-$FJSP_API_BASE}"
FAIL=0
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

# 业务服务已启用 JWT：先登录拿 token（默认 admin 演示账号，可用 FJSP_AUTH_USER/FJSP_AUTH_PASSWORD 覆盖），
# 之后所有请求统一经 curl 包装函数携带 Authorization 头。
demo_auth_login
curl() { command curl -H "Authorization: Bearer $FJSP_AUTH_TOKEN" "$@"; }

ikey() { python3 -c 'import uuid;print(uuid.uuid4())'; }

# post PATH JSON [期望code]
post() {
  local path="$1" body="$2" expect="${3:-OK}"
  local resp code
  resp=$(curl -s -X POST -H 'Content-Type: application/json' -H "Idempotency-Key: $(ikey)" \
    -d "$body" "$API$path") || true
  code=$(printf '%s' "$resp" | python3 -c "import json,sys; print(json.load(sys.stdin)['code'])" 2>/dev/null) || true
  if [ "$code" = "$expect" ]; then
    echo "PASS  POST $path -> $code"
  else
    echo "FAIL  POST $path -> $code (期望 $expect)"; printf '%s\n' "$resp" | head -c 400; echo; FAIL=1
  fi
  printf '%s' "$resp" > "$TMP"
}

put() {
  local path="$1" body="$2" expect="${3:-OK}"
  local resp code
  resp=$(curl -s -X PUT -H 'Content-Type: application/json' -H "Idempotency-Key: $(ikey)" \
    -d "$body" "$API$path") || true
  code=$(printf '%s' "$resp" | python3 -c "import json,sys; print(json.load(sys.stdin)['code'])" 2>/dev/null) || true
  if [ "$code" = "$expect" ]; then
    echo "PASS  PUT  $path -> $code"
  else
    echo "FAIL  PUT  $path -> $code (期望 $expect)"; printf '%s\n' "$resp" | head -c 400; echo; FAIL=1
  fi
  printf '%s' "$resp" > "$TMP"
}

# 相对今天生成日期（UTC，避免时区漂移）；兼容 macOS BSD date 与 GNU date
plus_days() {
  if date -u -v+"$1"d +%F >/dev/null 2>&1; then
    date -u -v+"$1"d +%F
  else
    date -u -d "+$1 days" +%F
  fi
}
SUF=$(date +%s)
D1=$(plus_days 30)
D2=$(plus_days 31)
D3=$(plus_days 32)
ARR=$(plus_days 10)
DUE=$(plus_days 12)

# 设备/日历 id 不硬编码：从 GET /machines 动态取前 3 台（不足时回退到第一台）
MACH_INFO=$(curl -s "$API/machines" | python3 -c "
import json,sys
for m in json.load(sys.stdin)['data'][:3]: print(m['machineId'], m['calendarId'])
" 2>/dev/null || true)
MID1=$(awk 'NR==1{print $1}' <<<"$MACH_INFO"); CAL1=$(awk 'NR==1{print $2}' <<<"$MACH_INFO")
MID2=$(awk 'NR==2{print $1}' <<<"$MACH_INFO"); CAL2=$(awk 'NR==2{print $2}' <<<"$MACH_INFO")
MID3=$(awk 'NR==3{print $1}' <<<"$MACH_INFO")
if [ -z "$MID1" ] || [ -z "$CAL1" ]; then echo "FAIL  GET /machines 无可用设备"; exit 1; fi
MID2=${MID2:-$MID1}; CAL2=${CAL2:-$CAL1}; MID3=${MID3:-$MID1}

echo "== 设备 =="
post /machines "{\"machineCode\":\"M-T$SUF\",\"machineName\":\"测试机床\",\"workCenterId\":\"WC-车削\",\"calendarId\":\"$CAL1\",\"productFamilies\":[\"轴类A\"],\"remark\":\"冒烟\"}"
post /machines "{\"machineCode\":\"M-T$SUF\",\"workCenterId\":\"WC-车削\",\"productFamilies\":[\"轴类A\"]}" E_DUPLICATE
post /machines "{\"machineCode\":\"\",\"workCenterId\":\"WC-车削\",\"productFamilies\":[\"轴类A\"]}" E_VALIDATION
put "/machines/M-T$SUF" "{\"machineCode\":\"M-T$SUF\",\"machineName\":\"测试机床改\",\"workCenterId\":\"WC-铣削\",\"calendarId\":\"$CAL2\",\"productFamilies\":[\"轴类A\",\"盘类B\"],\"remark\":\"已编辑\"}"
post "/machines/M-T$SUF/status" '{"status":"INACTIVE"}'
post "/machines/M-T$SUF/status" '{"status":"BOGUS"}' E_VALIDATION
post "/machines/M-T$SUF/status" '{"status":"ACTIVE"}'

echo "== 设备日历区间（F-02 版本化） =="
CAL1V1=$CAL1
post "/calendars/$CAL1/intervals" "{\"intervalType\":\"HOLIDAY\",\"startAt\":\"${D1}T00:00:00Z\",\"endAt\":\"${D2}T00:00:00Z\",\"note\":\"冒烟节假日\"}"
# 日历变更生成新版本：响应携带新版本 id/version，后续写操作改用新版本；旧版本区间不改写
CAL1=$(python3 -c "import json; print(json.load(open('$TMP'))['data']['calendarId'])" 2>/dev/null || true)
VER=$(python3 -c "import json; print(json.load(open('$TMP'))['data']['calendarVersion'])" 2>/dev/null || true)
if [ -n "$CAL1" ] && [ "$CAL1" != "$CAL1V1" ] && [ "$VER" = "2" ]; then
  echo "PASS  日历变更生成新版本 v$VER（旧版本 $CAL1V1 保留）"
else
  echo "FAIL  日历未生成新版本（calendarId=$CAL1 version=$VER）"; FAIL=1; CAL1=$CAL1V1
fi
VCNT=$(curl -s "$API/calendars/$CAL1/versions" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['data']))" 2>/dev/null || true)
VCNT=${VCNT:-0}
if [ "$VCNT" -ge 2 ]; then echo "PASS  GET /calendars/$CAL1/versions 版本数=$VCNT"; else echo "FAIL  版本历史不足 2 个"; FAIL=1; fi
post "/calendars/$CAL1/intervals" "{\"intervalType\":\"REPAIR\",\"startAt\":\"${D1}T12:00:00Z\",\"endAt\":\"${D2}T12:00:00Z\"}" E_VALIDATION
post "/calendars/$CAL1/intervals" "{\"intervalType\":\"BREAK\",\"startAt\":\"${D3}T00:00:00Z\",\"endAt\":\"${D2}T00:00:00Z\"}" E_VALIDATION
# 历史版本不可变更（已归档）
post "/calendars/$CAL1V1/intervals" "{\"intervalType\":\"BREAK\",\"startAt\":\"${D3}T00:00:00Z\",\"endAt\":\"${D3}T12:00:00Z\"}" E_STATE_CONFLICT
CNT=$(curl -s "$API/calendars/$CAL1/intervals" | python3 -c "import json,sys; d=json.load(sys.stdin)['data']; print(len([i for i in d if i['intervalType']!='WORK']))" 2>/dev/null || true)
CNT=${CNT:-0}
if [ "$CNT" -ge 1 ]; then echo "PASS  GET /calendars/$CAL1/intervals 非WORK区间数=$CNT"; else echo "FAIL  GET /calendars/$CAL1/intervals"; FAIL=1; fi
CNTV1=$(curl -s "$API/calendars/$CAL1V1/intervals" | python3 -c "import json,sys; d=json.load(sys.stdin)['data']; print(len([i for i in d if i['intervalType']!='WORK']))" 2>/dev/null || true)
CNTV1=${CNTV1:-0}
if [ "$CNTV1" = "0" ]; then echo "PASS  历史版本 v1 区间未被改写（非WORK=0）"; else echo "FAIL  历史版本被改写（非WORK=$CNTV1）"; FAIL=1; fi

echo "== 工艺模板 =="
post /process-templates "{\"templateCode\":\"TPL-测试$SUF\",\"productFamily\":\"测试族$SUF\",\"operations\":[{\"sequenceNo\":10,\"operationCode\":\"OP-10\",\"defaultCandidates\":[{\"machineId\":\"$MID1\",\"setupMinutes\":5,\"processMinutes\":30}]},{\"sequenceNo\":20,\"operationCode\":\"OP-20\",\"defaultCandidates\":[{\"machineId\":\"$MID2\",\"setupMinutes\":4,\"processMinutes\":25},{\"machineId\":\"$MID3\",\"setupMinutes\":6,\"processMinutes\":28}]}]}"
TID=$(python3 -c "import json; print(json.load(open('$TMP'))['data']['templateId'])" 2>/dev/null || true)
post /process-templates "{\"templateCode\":\"TPL-测试$SUF\",\"productFamily\":\"测试族$SUF\",\"operations\":[{\"sequenceNo\":10,\"operationCode\":\"OP-10\",\"defaultCandidates\":[{\"machineId\":\"$MID1\",\"setupMinutes\":5,\"processMinutes\":30}]}]}" E_DUPLICATE
post /process-templates "{\"templateCode\":\"TPL-坏$SUF\",\"productFamily\":\"测试族\",\"operations\":[]}" E_VALIDATION
post /process-templates "{\"templateCode\":\"TPL-坏2-$SUF\",\"productFamily\":\"测试族\",\"operations\":[{\"sequenceNo\":20,\"operationCode\":\"OP-20\",\"defaultCandidates\":[{\"machineId\":\"$MID1\",\"setupMinutes\":5,\"processMinutes\":30}]},{\"sequenceNo\":10,\"operationCode\":\"OP-10\",\"defaultCandidates\":[{\"machineId\":\"$MID1\",\"setupMinutes\":5,\"processMinutes\":30}]}]}" E_VALIDATION
post "/process-templates/$TID/status" '{"status":"INACTIVE"}'
post "/process-templates/$TID/copy" '{}'
V2=$(python3 -c "import json; d=json.load(open('$TMP'))['data']; print(d['templateVersion'], d['status'])" 2>/dev/null || true)
if [ "$V2" = "2 DRAFT" ]; then echo "PASS  复制模板得到 v2 DRAFT"; else echo "FAIL  复制模板: $V2"; FAIL=1; fi
TID2=$(python3 -c "import json; print(json.load(open('$TMP'))['data']['templateId'])" 2>/dev/null || true)
post "/process-templates/$TID2/status" '{"status":"ACTIVE"}'

echo "== 订单 =="
post /orders "{\"orderCode\":\"ORD-T$SUF\",\"productFamily\":\"测试族$SUF\",\"quantity\":10,\"arrivalAt\":\"${ARR}T00:00:00Z\",\"dueAt\":\"${DUE}T00:00:00Z\",\"priority\":2,\"templateId\":\"$TID2\"}"
OPS=$(python3 -c "import json; d=json.load(open('$TMP'))['data']; print(len(d['operationIds']))" 2>/dev/null || true)
if [ "$OPS" = "2" ]; then echo "PASS  订单实例化 2 道工序"; else echo "FAIL  订单实例化工序数=$OPS"; FAIL=1; fi
post /orders "{\"orderCode\":\"ORD-T$SUF\",\"productFamily\":\"测试族$SUF\",\"quantity\":10,\"arrivalAt\":\"${ARR}T00:00:00Z\",\"dueAt\":\"${DUE}T00:00:00Z\",\"priority\":2}" E_DUPLICATE
post /orders "{\"orderCode\":\"ORD-T2-$SUF\",\"productFamily\":\"测试族$SUF\",\"quantity\":0,\"arrivalAt\":\"${ARR}T00:00:00Z\",\"dueAt\":\"${DUE}T00:00:00Z\",\"priority\":2}" E_VALIDATION
post /orders "{\"orderCode\":\"ORD-T3-$SUF\",\"productFamily\":\"测试族$SUF\",\"quantity\":5,\"arrivalAt\":\"${DUE}T00:00:00Z\",\"dueAt\":\"${ARR}T00:00:00Z\",\"priority\":2}" E_VALIDATION
put "/orders/ORD-T$SUF" '{"quantity":20,"priority":1}'
# 已排程订单不可编辑：动态挑一个 SCHEDULED 状态的订单
SCHED_ORD=$(curl -s "$API/orders" | python3 -c "import json,sys; d=json.load(sys.stdin)['data']; s=[o['orderId'] for o in d if o['status']=='SCHEDULED']; print(s[0] if s else '')" 2>/dev/null || true)
if [ -n "$SCHED_ORD" ]; then
  put "/orders/$SCHED_ORD" '{"quantity":99}' E_STATE_CONFLICT
  # F-04：已排程订单的工艺字段变更走修订流程（原因必填），修订后提示需重新排程
  post "/orders/$SCHED_ORD/revisions" '{"reason":"冒烟修订","quantity":98}'
  NR=$(python3 -c "import json; d=json.load(open('$TMP'))['data']; print(d['revisionNo'], d['needsReschedule'])" 2>/dev/null || true)
  if [ -n "$NR" ] && [ "${NR#* }" = "True" ]; then echo "PASS  已排程订单修订成功（revisionNo/needsReschedule=$NR）"; else echo "FAIL  订单修订: $NR"; FAIL=1; fi
  post "/orders/$SCHED_ORD/revisions" '{"reason":"","quantity":97}' E_VALIDATION
  RCNT=$(curl -s "$API/orders/$SCHED_ORD/revisions" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['data']))" 2>/dev/null || true)
  RCNT=${RCNT:-0}
  if [ "$RCNT" -ge 1 ]; then echo "PASS  GET /orders/$SCHED_ORD/revisions 修订记录数=$RCNT"; else echo "FAIL  修订记录查询"; FAIL=1; fi
else
  echo "SKIP  无 SCHEDULED 订单可测"
fi

echo "== 幂等键缺失 =="
CODE=$(curl -s -X POST -H 'Content-Type: application/json' -d '{"machineCode":"X","workCenterId":"WC","productFamilies":["轴类A"]}' "$API/machines" | python3 -c "import json,sys; print(json.load(sys.stdin)['code'])" 2>/dev/null || true)
if [ "$CODE" = "E_VALIDATION" ]; then echo "PASS  缺少 Idempotency-Key -> E_VALIDATION"; else echo "FAIL  缺少 Idempotency-Key -> $CODE"; FAIL=1; fi

if [ "$FAIL" = "0" ]; then echo "ALL PASS"; else echo "SOME CHECKS FAILED"; exit 1; fi

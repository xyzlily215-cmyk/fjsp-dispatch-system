#!/usr/bin/env bash
# crud-check.sh — 新增基础数据写接口冒烟（正例 + 负例校验）
# 用法: bash scripts/crud-check.sh
set -u
API="${FJSP_API:-http://localhost:8081/api/v1}"
FAIL=0

# post PATH JSON [期望code]
post() {
  local path="$1" body="$2" expect="${3:-OK}"
  local resp code
  resp=$(curl -s -X POST -H 'Content-Type: application/json' -H "Idempotency-Key: $(uuidgen)" \
    -d "$body" "$API$path")
  code=$(printf '%s' "$resp" | python3 -c "import json,sys; print(json.load(sys.stdin)['code'])" 2>/dev/null)
  if [ "$code" = "$expect" ]; then
    echo "PASS  POST $path -> $code"
  else
    echo "FAIL  POST $path -> $code (期望 $expect)"; printf '%s\n' "$resp" | head -c 400; echo; FAIL=1
  fi
  printf '%s' "$resp" > /tmp/crud_last.json
}

put() {
  local path="$1" body="$2" expect="${3:-OK}"
  local resp code
  resp=$(curl -s -X PUT -H 'Content-Type: application/json' -H "Idempotency-Key: $(uuidgen)" \
    -d "$body" "$API$path")
  code=$(printf '%s' "$resp" | python3 -c "import json,sys; print(json.load(sys.stdin)['code'])" 2>/dev/null)
  if [ "$code" = "$expect" ]; then
    echo "PASS  PUT  $path -> $code"
  else
    echo "FAIL  PUT  $path -> $code (期望 $expect)"; printf '%s\n' "$resp" | head -c 400; echo; FAIL=1
  fi
  printf '%s' "$resp" > /tmp/crud_last.json
}

SUF=$(date +%s)
D1=$(python3 -c "import datetime,random; random.seed($SUF); d=datetime.date(2027,1,1)+datetime.timedelta(days=$SUF%300); print(d.isoformat())")
D2=$(python3 -c "import datetime; print((datetime.date.fromisoformat('$D1')+datetime.timedelta(days=1)).isoformat())")
D3=$(python3 -c "import datetime; print((datetime.date.fromisoformat('$D1')+datetime.timedelta(days=2)).isoformat())")

echo "== 设备 =="
post /machines "{\"machineCode\":\"M-T$SUF\",\"machineName\":\"测试机床\",\"workCenterId\":\"WC-车削\",\"calendarId\":\"CAL-M-01\",\"productFamilies\":[\"轴类A\"],\"remark\":\"冒烟\"}"
post /machines "{\"machineCode\":\"M-T$SUF\",\"workCenterId\":\"WC-车削\",\"productFamilies\":[\"轴类A\"]}" E_DUPLICATE
post /machines "{\"machineCode\":\"\",\"workCenterId\":\"WC-车削\",\"productFamilies\":[\"轴类A\"]}" E_VALIDATION
put "/machines/M-T$SUF" "{\"machineCode\":\"M-T$SUF\",\"machineName\":\"测试机床改\",\"workCenterId\":\"WC-铣削\",\"calendarId\":\"CAL-M-02\",\"productFamilies\":[\"轴类A\",\"盘类B\"],\"remark\":\"已编辑\"}"
post "/machines/M-T$SUF/status" '{"status":"INACTIVE"}'
post "/machines/M-T$SUF/status" '{"status":"BOGUS"}' E_VALIDATION
post "/machines/M-T$SUF/status" '{"status":"ACTIVE"}'

echo "== 设备日历区间 =="
post "/calendars/CAL-M-01/intervals" "{\"intervalType\":\"HOLIDAY\",\"startAt\":\"${D1}T00:00:00Z\",\"endAt\":\"${D2}T00:00:00Z\",\"note\":\"冒烟节假日\"}"
post "/calendars/CAL-M-01/intervals" "{\"intervalType\":\"REPAIR\",\"startAt\":\"${D1}T12:00:00Z\",\"endAt\":\"${D2}T12:00:00Z\"}" E_VALIDATION
post "/calendars/CAL-M-01/intervals" "{\"intervalType\":\"BREAK\",\"startAt\":\"${D3}T00:00:00Z\",\"endAt\":\"${D2}T00:00:00Z\"}" E_VALIDATION
CNT=$(curl -s "$API/calendars/CAL-M-01/intervals" | python3 -c "import json,sys; d=json.load(sys.stdin)['data']; print(len([i for i in d if i['intervalType']!='WORK']))")
if [ "$CNT" -ge 1 ]; then echo "PASS  GET /calendars/CAL-M-01/intervals 非WORK区间数=$CNT"; else echo "FAIL  GET /calendars/CAL-M-01/intervals"; FAIL=1; fi

echo "== 工艺模板 =="
post /process-templates "{\"templateCode\":\"TPL-测试$SUF\",\"productFamily\":\"测试族$SUF\",\"operations\":[{\"sequenceNo\":10,\"operationCode\":\"OP-10\",\"defaultCandidates\":[{\"machineId\":\"M-01\",\"setupMinutes\":5,\"processMinutes\":30}]},{\"sequenceNo\":20,\"operationCode\":\"OP-20\",\"defaultCandidates\":[{\"machineId\":\"M-02\",\"setupMinutes\":4,\"processMinutes\":25},{\"machineId\":\"M-03\",\"setupMinutes\":6,\"processMinutes\":28}]}]}"
TID=$(python3 -c "import json; print(json.load(open('/tmp/crud_last.json'))['data']['templateId'])")
post /process-templates "{\"templateCode\":\"TPL-测试$SUF\",\"productFamily\":\"测试族$SUF\",\"operations\":[{\"sequenceNo\":10,\"operationCode\":\"OP-10\",\"defaultCandidates\":[{\"machineId\":\"M-01\",\"setupMinutes\":5,\"processMinutes\":30}]}]}" E_DUPLICATE
post /process-templates "{\"templateCode\":\"TPL-坏$SUF\",\"productFamily\":\"测试族\",\"operations\":[]}" E_VALIDATION
post /process-templates "{\"templateCode\":\"TPL-坏2-$SUF\",\"productFamily\":\"测试族\",\"operations\":[{\"sequenceNo\":20,\"operationCode\":\"OP-20\",\"defaultCandidates\":[{\"machineId\":\"M-01\",\"setupMinutes\":5,\"processMinutes\":30}]},{\"sequenceNo\":10,\"operationCode\":\"OP-10\",\"defaultCandidates\":[{\"machineId\":\"M-01\",\"setupMinutes\":5,\"processMinutes\":30}]}]}" E_VALIDATION
post "/process-templates/$TID/status" '{"status":"INACTIVE"}'
post "/process-templates/$TID/copy" '{}'
V2=$(python3 -c "import json; d=json.load(open('/tmp/crud_last.json'))['data']; print(d['templateVersion'], d['status'])")
if [ "$V2" = "2 DRAFT" ]; then echo "PASS  复制模板得到 v2 DRAFT"; else echo "FAIL  复制模板: $V2"; FAIL=1; fi
TID2=$(python3 -c "import json; print(json.load(open('/tmp/crud_last.json'))['data']['templateId'])")
post "/process-templates/$TID2/status" '{"status":"ACTIVE"}'

echo "== 订单 =="
post /orders "{\"orderCode\":\"ORD-T$SUF\",\"productFamily\":\"测试族$SUF\",\"quantity\":10,\"arrivalAt\":\"2026-09-16T00:00:00Z\",\"dueAt\":\"2026-09-18T00:00:00Z\",\"priority\":2,\"templateId\":\"$TID2\"}"
OPS=$(python3 -c "import json; d=json.load(open('/tmp/crud_last.json'))['data']; print(len(d['operationIds']))")
if [ "$OPS" = "2" ]; then echo "PASS  订单实例化 2 道工序"; else echo "FAIL  订单实例化工序数=$OPS"; FAIL=1; fi
post /orders "{\"orderCode\":\"ORD-T$SUF\",\"productFamily\":\"测试族$SUF\",\"quantity\":10,\"arrivalAt\":\"2026-09-16T00:00:00Z\",\"dueAt\":\"2026-09-18T00:00:00Z\",\"priority\":2}" E_DUPLICATE
post /orders "{\"orderCode\":\"ORD-T2-$SUF\",\"productFamily\":\"测试族$SUF\",\"quantity\":0,\"arrivalAt\":\"2026-09-16T00:00:00Z\",\"dueAt\":\"2026-09-18T00:00:00Z\",\"priority\":2}" E_VALIDATION
post /orders "{\"orderCode\":\"ORD-T3-$SUF\",\"productFamily\":\"测试族$SUF\",\"quantity\":5,\"arrivalAt\":\"2026-09-18T00:00:00Z\",\"dueAt\":\"2026-09-16T00:00:00Z\",\"priority\":2}" E_VALIDATION
put "/orders/ORD-T$SUF" '{"quantity":20,"priority":1}'
# 已排程订单不可编辑：动态挑一个 SCHEDULED 状态的订单
SCHED_ORD=$(curl -s "$API/orders" | python3 -c "import json,sys; d=json.load(sys.stdin)['data']; s=[o['orderId'] for o in d if o['status']=='SCHEDULED']; print(s[0] if s else '')")
if [ -n "$SCHED_ORD" ]; then
  put "/orders/$SCHED_ORD" '{"quantity":99}' E_STATE_CONFLICT
else
  echo "SKIP  无 SCHEDULED 订单可测"
fi

echo "== 幂等键缺失 =="
CODE=$(curl -s -X POST -H 'Content-Type: application/json' -d '{"machineCode":"X","workCenterId":"WC","productFamilies":["轴类A"]}' "$API/machines" | python3 -c "import json,sys; print(json.load(sys.stdin)['code'])")
if [ "$CODE" = "E_VALIDATION" ]; then echo "PASS  缺少 Idempotency-Key -> E_VALIDATION"; else echo "FAIL  缺少 Idempotency-Key -> $CODE"; FAIL=1; fi

if [ "$FAIL" = "0" ]; then echo "ALL PASS"; else echo "SOME CHECKS FAILED"; exit 1; fi

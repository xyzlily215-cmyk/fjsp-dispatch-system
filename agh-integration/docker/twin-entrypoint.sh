#!/bin/bash
# twin 一体化容器入口：AGH daemon → AgnesHub(serve:4180) → agent-bff(4178，前台主进程)。
# MHS 虚拟设备（machine-m03.py）不随容器自启，由数字孪生页面「启动虚拟车间」
# 经 agent-bff /agent-api/twin/sim/start 按需拉起（sim.mts spawn，同容器 /tmp 触发文件生效）。
set -euo pipefail
cd /app/agh-integration

export FJSP_API_BASE="${FJSP_API_BASE:-http://business:8081/api/v1}"

# 1) AGH daemon（需 Node >= 24.10；数据落 ~/.agh/data，compose 挂卷持久化模型配置与插件）
node agnes-harness/packages/cli/dist/local/daemon.mjs --profile local-dev \
  --workspace /app/agh-integration --data-dir "$HOME/.agh/data" \
  --local-web-addr 127.0.0.1:0 --local-web-origin http://127.0.0.1:4177 \
  > /tmp/agh-daemon.log 2>&1 &

SOCK="$HOME/.agh/data/daemon/agnesd.sock"
for _ in $(seq 1 60); do [[ -S "$SOCK" ]] && break; sleep 1; done
if [[ ! -S "$SOCK" ]]; then
  echo "[twin] AGH daemon 未就绪，日志见 /tmp/agh-daemon.log" >&2
  exit 1
fi
echo "[twin] daemon ready: $SOCK"

# 2) AgnesHub（数字孪生设备通道；serve 会复用已运行的 daemon）
AGNES_HUB_ORIGIN="${AGNES_HUB_ORIGIN:-http://127.0.0.1:4180}" \
  node agnes-harness/packages/cli/dist/local/agnes.mjs serve > /tmp/agh-serve.log 2>&1 &
for _ in $(seq 1 60); do
  curl -fsS --max-time 2 "http://127.0.0.1:4180/" >/dev/null 2>&1 && break
  sleep 1
done
echo "[twin] hub ready: http://127.0.0.1:4180"

# 3) agent-bff（前台；AGENT_BFF_HOST/AGNES_HUB_URL 由 compose 注入）
exec tsx agent-bff/server.mts

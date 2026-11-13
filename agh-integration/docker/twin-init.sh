#!/bin/bash
# twin 容器一次性初始化：安装 @fjsp/fjsp-tools 插件 + 保存模型账号。
# 用法（服务器上）：
#   cd /opt/bysj/deploy
#   AGH_MODEL_API_KEY=sk-xxx docker compose -f docker-compose.prod.yml exec -e AGH_MODEL_API_KEY -w /app/agh-integration/agent-bff twin bash /opt/bysj/agh-integration/scripts/twin-init.sh
# 说明：AGH_MODEL_API_KEY 只经环境变量传入，不落仓库、不进镜像；模型账号由 daemon 存于 agh-data 卷。
set -euo pipefail

echo '== 1/3 安装 @agnes/mhs 插件（AgnesHub 设备通道；幂等重装）=='
tsx install-mhs-plugin.mts

echo '== 2/3 安装 fjsp-tools 插件（disable→remove→install→trust→enable，幂等）=='
tsx reinstall-plugin.mts

echo '== 3/3 保存模型账号（agnes-ai / agnes-3.0-flash，设为默认）=='
: "${AGH_MODEL_API_KEY:?请先设置 AGH_MODEL_API_KEY 环境变量}"
tsx model-config.mts save agnes-ai agnes-3.0-flash --default --base-url https://api.agnes-ai.cn/v1

echo '== 完成：模型账号与插件状态已持久化到 agh-data 卷 =='

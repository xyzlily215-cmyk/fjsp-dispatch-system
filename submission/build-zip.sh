#!/usr/bin/env bash
# 打包比赛提交 ZIP：组别-参赛编号-队伍名称-队长姓名.zip
# 内容 = git archive HEAD 源码快照 + submission/ 目录 + agh-integration/agh-trace-20261003.zip
set -euo pipefail

LIMIT_BYTES=$((200 * 1024 * 1024)) # 200MB

usage() {
  echo "用法: bash submission/build-zip.sh <组别> <参赛编号> <队伍名称> <队长姓名>" >&2
  echo "示例: bash submission/build-zip.sh 本科组 A001 示例队 张三" >&2
  exit 1
}

if [ "$#" -ne 4 ]; then
  usage
fi

GROUP="$1"; TEAM_ID="$2"; TEAM_NAME="$3"; LEADER="$4"
ZIP_NAME="${GROUP}-${TEAM_ID}-${TEAM_NAME}-${LEADER}.zip"

# 切到仓库根目录（脚本位于 submission/ 下）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

# 前置检查
command -v git >/dev/null 2>&1 || { echo "错误: 未找到 git" >&2; exit 1; }
command -v zip >/dev/null 2>&1 || { echo "错误: 未找到 zip" >&2; exit 1; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "错误: 当前目录不是 git 仓库" >&2; exit 1; }

# git archive 只打包已提交内容，先检查未提交改动
if [ -n "$(git status --porcelain)" ]; then
  echo "警告: 存在未提交/未跟踪的改动，git archive 不会包含它们：" >&2
  git status --porcelain >&2
  echo "请先 git add && git commit 后再打包。" >&2
  exit 1
fi

EVIDENCE_ZIP="agh-integration/agh-trace-20261003.zip"
if [ ! -f "${EVIDENCE_ZIP}" ]; then
  echo "警告: 未找到证据包 ${EVIDENCE_ZIP}，将跳过（建议确认后重新打包）。" >&2
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

STAGE_DIR="${TMP_DIR}/stage"
mkdir -p "${STAGE_DIR}"

echo "==> 导出 git archive HEAD 源码快照..."
git archive HEAD | tar -x -C "${STAGE_DIR}"

echo "==> 追加 submission/ 目录（含未提交的新材料）..."
mkdir -p "${STAGE_DIR}/submission"
# submission/ 中的新材料可能尚未提交，强制以工作区文件覆盖
cp -R "${SCRIPT_DIR}/." "${STAGE_DIR}/submission/"

if [ -f "${EVIDENCE_ZIP}" ]; then
  echo "==> 附带证据包 ${EVIDENCE_ZIP}..."
  mkdir -p "${STAGE_DIR}/agh-integration"
  cp "${EVIDENCE_ZIP}" "${STAGE_DIR}/agh-integration/"
fi

OUT_PATH="${REPO_ROOT}/${ZIP_NAME}"
rm -f "${OUT_PATH}"

echo "==> 生成 ${ZIP_NAME} ..."
( cd "${STAGE_DIR}" && zip -qr "${OUT_PATH}" . )

ZIP_SIZE="$(stat -f%z "${OUT_PATH}" 2>/dev/null || stat -c%s "${OUT_PATH}")"
ZIP_SIZE_MB="$(awk "BEGIN { printf \"%.1f\", ${ZIP_SIZE}/1048576 }")"

echo "==> 完成: ${OUT_PATH}"
echo "==> 大小: ${ZIP_SIZE_MB} MB (${ZIP_SIZE} bytes)"

if [ "${ZIP_SIZE}" -gt "${LIMIT_BYTES}" ]; then
  echo "警告: ZIP 超过 200MB 上限，请压缩后再提交！" >&2
  exit 2
fi

echo "==> 大小检查通过（≤ 200MB）。提交截止: 2026-10-15 12:00"

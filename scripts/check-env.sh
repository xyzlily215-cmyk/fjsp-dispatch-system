#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

required=(FJSP_DB_PASSWORD)
missing=()
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    missing+=("${name}")
  fi
done

if (( ${#missing[@]} > 0 )); then
  printf '缺少必需环境变量: %s\n' "${missing[*]}" >&2
  printf '请先执行: cp .env.example .env，然后填写本地值。\n' >&2
  exit 1
fi

if [[ "${FJSP_DB_PASSWORD}" == "change-this-password" ]]; then
  printf 'FJSP_DB_PASSWORD 仍为示例值，请改为本地密码。\n' >&2
  exit 1
fi

printf '环境变量检查通过。\n'
printf '数据库: %s@%s:%s/%s\n' \
  "${FJSP_DB_USER:-fjsp}" \
  "${FJSP_DB_HOST:-localhost}" \
  "${FJSP_DB_PORT:-5432}" \
  "${FJSP_DB_NAME:-fjsp}"
printf '算法服务: %s\n' "${FJSP_ALGORITHM_BASE_URL:-http://localhost:8101}"
printf '不会输出数据库密码或 API Key。\n'

#!/usr/bin/env bash
# IDEA's GUI process does not necessarily inherit the interactive shell's PATH.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
export PATH="$HOME/Desktop/developmentTool/Maven/apache-maven-3.9.0/bin:$HOME/.docker/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
if [[ -z "${JAVA_HOME:-}" ]]; then
  JAVA_HOME="$(/usr/libexec/java_home -v 17)"
  export JAVA_HOME
fi
export PATH="$JAVA_HOME/bin:$PATH"

# The demo script serves dist/ and intentionally does not build it.
command -v npm >/dev/null || { printf '未找到 npm，请先安装 Node.js。\n' >&2; exit 1; }
[[ -d "$ROOT_DIR/web-vue/node_modules" ]] || { printf '请先在 web-vue 执行 npm ci。\n' >&2; exit 1; }
(cd "$ROOT_DIR/web-vue" && npm run build)

FJSP_START_AGH=1 "$SCRIPT_DIR/start-demo.sh"

# The browser's AI panel talks directly to the BFF; start-demo.sh does not manage it.
# Reload the BFF so a healthy but stale process cannot serve an older CORS/API contract.
# shellcheck disable=SC1091
source "$SCRIPT_DIR/demo-common.sh"
load_demo_env
require_command lsof
ensure_node24
tsx="$ROOT_DIR/agh-integration/agnes-harness/node_modules/.bin/tsx"
[[ -x "$tsx" ]] || { printf '缺少 AGH tsx：%s\n' "$tsx" >&2; exit 1; }
bff_pid="$(lsof -nP -tiTCP:4178 -sTCP:LISTEN || true)"
if [[ -n "$bff_pid" ]]; then
  bff_cwd="$(lsof -nP -a -p "$bff_pid" -d cwd -Fn | sed -n 's/^n//p')"
  if [[ "$bff_cwd" != "$ROOT_DIR/agh-integration/agent-bff" ]] \
    || ! process_matches "$bff_pid" 'server.mts'; then
    printf '4178 端口由非本项目 BFF 进程占用，未停止 PID=%s。\n' "$bff_pid" >&2
    exit 1
  fi
  printf '[重启] agent-bff，PID=%s（加载最新代码）\n' "$bff_pid"
  kill "$bff_pid"
  for _ in {1..20}; do
    [[ -z "$(lsof -nP -tiTCP:4178 -sTCP:LISTEN || true)" ]] && break
    sleep 0.25
  done
  [[ -z "$(lsof -nP -tiTCP:4178 -sTCP:LISTEN || true)" ]] || {
    printf 'agent-bff 未能释放 4178 端口。\n' >&2
    exit 1
  }
fi
# IDEA's Shell Script runner closes its process tree when the run finishes.
# A detached session keeps the BFF alive after the short-lived launcher exits.
node -e '
  const { spawn } = require("node:child_process");
  const { openSync, closeSync } = require("node:fs");
  const [tsx, cwd, log] = process.argv.slice(1);
  const fd = openSync(log, "a");
  const child = spawn(tsx, ["server.mts"], {
    cwd, detached: true, stdio: ["ignore", fd, fd], env: process.env,
  });
  child.unref();
  closeSync(fd);
' "$tsx" "$ROOT_DIR/agh-integration/agent-bff" "$(log_file agent-bff)"
wait_for_url 'http://127.0.0.1:4178/agent-api/health' '智能体 BFF'
bff_pid="$(lsof -nP -tiTCP:4178 -sTCP:LISTEN)"
printf '%s\n' "$bff_pid" >"$(pid_file agent-bff)"
headers="$(curl -fsS -i -X OPTIONS 'http://127.0.0.1:4178/agent-api/twin/sim/start' \
  -H 'Origin: http://127.0.0.1:8082' -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: authorization,content-type')"
printf '%s\n' "$headers" | grep -qi '^Access-Control-Allow-Headers:.*Authorization' || {
  printf 'agent-bff 未放行浏览器 Authorization 请求头，请查看 %s\n' "$(log_file agent-bff)" >&2
  exit 1
}
printf 'IDEA 一键启动完成，前端：http://127.0.0.1:8082/index.html?api=%s\n' "$FJSP_API_BASE"

#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$HOME/.docker/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/demo-common.sh"
load_demo_env
stop_process agent-bff 'server.mts'
"$SCRIPT_DIR/stop-demo.sh"

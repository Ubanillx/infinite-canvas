#!/usr/bin/env bash
set -Eeuo pipefail

root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
agent_dir="$root_dir/canvas-agent"
web_dir="$root_dir/web"
port="${PORT:-3100}"
runtime_dir="${RUNTIME_DIR:-/tmp/infinite-canvas-$UID}"
agent_log="$runtime_dir/canvas-agent.log"
web_log="$runtime_dir/build-and-preview.log"
bun_bin="${BUN_BIN:-}"
node_bin="${NODE_BIN:-}"

if [[ -z "$bun_bin" ]]; then
    bun_bin="$(command -v bun || true)"
fi
[[ -x "$bun_bin" ]] || bun_bin="$HOME/.bun/bin/bun"

if [[ -z "$node_bin" ]]; then
    for candidate in "$HOME"/.nvm/versions/node/*/bin/node; do
        [[ -x "$candidate" ]] && node_bin="$candidate"
    done
    [[ -n "$node_bin" ]] || node_bin="$(command -v node || true)"
fi

[[ -x "$bun_bin" ]] || { echo "Bun was not found." >&2; exit 1; }
[[ -x "$node_bin" ]] || { echo "Node.js was not found." >&2; exit 1; }
[[ -f "$agent_dir/node_modules/.bin/tsc" ]] || { echo "Canvas Agent dependencies are missing." >&2; exit 1; }
[[ -f "$web_dir/node_modules/vite/bin/vite.js" ]] || { echo "Web dependencies are missing." >&2; exit 1; }

mkdir -p -m 700 "$runtime_dir"
chmod 700 "$runtime_dir"
: > "$agent_log"
: > "$web_log"
chmod 600 "$agent_log" "$web_log"

agent_pid=""
web_pid=""

cleanup() {
    status=$?
    trap - EXIT INT TERM
    for pid in "$web_pid" "$agent_pid"; do
        if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
            kill -TERM "$pid" 2>/dev/null || true
        fi
    done
    for pid in "$web_pid" "$agent_pid"; do
        if [[ "$pid" =~ ^[0-9]+$ ]]; then
            wait "$pid" 2>/dev/null || true
        fi
    done
    exit "$status"
}

trap 'exit 143' INT TERM
trap cleanup EXIT

export INFINITE_CANVAS_ALLOWED_NETWORKS="${INFINITE_CANVAS_ALLOWED_NETWORKS:-127.0.0.1,::1,192.168.0.0/22,172.16.0.0/12}"
export VITE_CANVAS_AGENT_URL="${VITE_CANVAS_AGENT_URL:-/api/canvas-agent}"

echo "Preparing Canvas Agent..."
cd "$agent_dir"
"$bun_bin" run build

if [[ -f "$HOME/.infinite-canvas/canvas-agent.json" ]]; then
    chmod 700 "$HOME/.infinite-canvas"
    chmod 600 "$HOME/.infinite-canvas/canvas-agent.json"
fi

echo "Building Web..."
cd "$web_dir"
"$node_bin" node_modules/vite/bin/vite.js build >> "$web_log" 2>&1

echo "Starting Canvas Agent..."
"$node_bin" "$agent_dir/dist/index.js" --debug >> "$agent_log" 2>&1 &
agent_pid=$!
for _ in {1..50}; do
    if curl -fsS --max-time 5 http://127.0.0.1:17371/health >/dev/null 2>&1; then
        break
    fi
    if ! kill -0 "$agent_pid" 2>/dev/null; then
        echo "Canvas Agent failed. See $agent_log" >&2
        exit 1
    fi
    sleep 0.2
done
curl -fsS --max-time 5 http://127.0.0.1:17371/health >/dev/null

echo "Starting Web on 0.0.0.0:$port..."
"$node_bin" node_modules/vite/bin/vite.js preview --host 0.0.0.0 --port "$port" >> "$web_log" 2>&1 &
web_pid=$!
for _ in {1..60}; do
    if curl -fsS --max-time 5 "http://127.0.0.1:$port/" >/dev/null 2>&1; then
        break
    fi
    if ! kill -0 "$web_pid" 2>/dev/null; then
        echo "Web failed. See $web_log" >&2
        exit 1
    fi
    sleep 0.5
done
curl -fsS --max-time 5 "http://127.0.0.1:$port/api/canvas-agent/health" >/dev/null

echo "Infinite Canvas is ready on port $port."
web_failures=0
agent_failures=0
while true; do
    web_stat="$(ps -p "$web_pid" -o stat= 2>/dev/null || true)"
    agent_stat="$(ps -p "$agent_pid" -o stat= 2>/dev/null || true)"
    if [[ -z "$web_stat" || "$web_stat" == Z* ]]; then
        echo "Web process exited; restarting via systemd." >&2
        exit 1
    fi
    if [[ -z "$agent_stat" || "$agent_stat" == Z* ]]; then
        echo "Canvas Agent process exited; restarting via systemd." >&2
        exit 1
    fi
    if curl -fsS --max-time 5 "http://127.0.0.1:$port/" >/dev/null 2>&1; then
        web_failures=0
    else
        web_failures=$((web_failures + 1))
    fi
    if curl -fsS --max-time 5 http://127.0.0.1:17371/health >/dev/null 2>&1; then
        agent_failures=0
    else
        agent_failures=$((agent_failures + 1))
    fi
    if ((web_failures >= 3 || agent_failures >= 3)); then
        echo "Health check failed repeatedly; restarting via systemd." >&2
        exit 1
    fi
    sleep 5
done

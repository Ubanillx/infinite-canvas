#!/usr/bin/env bash
set -Eeuo pipefail

root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
agent_dir="$root_dir/canvas-agent"
runtime_dir="${RUNTIME_DIR:-/tmp/infinite-canvas-$UID}"
agent_pid_file="$runtime_dir/canvas-agent.pid"
web_pid_file="$runtime_dir/preview.pid"
agent_log="$runtime_dir/canvas-agent.log"
web_log="$runtime_dir/build-and-preview.log"
action="${1:-start}"
if [[ -n "${BUN_BIN:-}" ]]; then
    bun_bin="$BUN_BIN"
else
    bun_bin="$(command -v bun || true)"
fi
if [[ -n "${NODE_BIN:-}" ]]; then
    node_bin="$NODE_BIN"
else
    node_bin=""
    # Prefer the user's nvm Node so the bundled/local Codex versions and auth
    # environment remain consistent after non-interactive restarts.
    for candidate in "$HOME"/.nvm/versions/node/*/bin/node; do
        [[ -x "$candidate" ]] && node_bin="$candidate"
    done
    [[ -n "$node_bin" ]] || node_bin="$(command -v node || true)"
fi

[[ -x "$bun_bin" ]] || bun_bin="$HOME/.bun/bin/bun"
mkdir -p -m 700 "$runtime_dir"
chmod 700 "$runtime_dir"

pid_command() {
    ps -p "$1" -o args= 2>/dev/null || true
}

known_agent_pid() {
    local candidate command_line
    while read -r candidate; do
        [[ "$candidate" =~ ^[0-9]+$ ]] || continue
        command_line="$(pid_command "$candidate")"
        if [[ "$command_line" == *"$agent_dir/dist/index.js"* || "$command_line" == *"@basketikun/canvas-agent"* || "$command_line" == *"/node_modules/.bin/canvas-agent"* ]]; then
            echo "$candidate"
            return
        fi
    done < <(lsof -tiTCP:17371 -sTCP:LISTEN 2>/dev/null || true)
}

stop_known_pid() {
    local pid="$1" label="$2" command_line
    [[ "$pid" =~ ^[0-9]+$ ]] || return 0
    kill -0 "$pid" 2>/dev/null || return 0
    command_line="$(pid_command "$pid")"
    if [[ "$label" == "Agent" && "$command_line" != *"$agent_dir/dist/index.js"* && "$command_line" != *"@basketikun/canvas-agent"* && "$command_line" != *"/node_modules/.bin/canvas-agent"* ]]; then
        echo "$label PID $pid is not an Infinite Canvas process; refusing to stop it." >&2
        return 1
    fi
    if [[ "$label" == "Web" && "$command_line" != *"$root_dir/web/node_modules/vite/bin/vite.js preview"* ]]; then
        echo "$label PID $pid is not an Infinite Canvas process; refusing to stop it." >&2
        return 1
    fi
    echo "Stopping $label (PID $pid)..."
    kill -TERM "$pid"
    for _ in {1..40}; do
        kill -0 "$pid" 2>/dev/null || return 0
        sleep 0.25
    done
    echo "$label did not stop within 10 seconds." >&2
    return 1
}

stop_services() {
    local pid
    if [[ -f "$web_pid_file" ]]; then
        read -r pid < "$web_pid_file" || true
        stop_known_pid "$pid" Web
        rm -f "$web_pid_file"
    fi
    pid="$(known_agent_pid || true)"
    if [[ -n "$pid" ]]; then
        stop_known_pid "$pid" Agent
    fi
    rm -f "$agent_pid_file"
}

service_status() {
    local agent_pid web_pid
    agent_pid="$(known_agent_pid || true)"
    web_pid=""
    [[ -f "$web_pid_file" ]] && read -r web_pid < "$web_pid_file" || true
    if [[ -n "$agent_pid" ]] && curl -fsS http://127.0.0.1:17371/health >/dev/null; then
        echo "Agent: running (PID $agent_pid, local-only 127.0.0.1:17371)"
    else
        echo "Agent: stopped"
    fi
    if [[ "$web_pid" =~ ^[0-9]+$ ]] && kill -0 "$web_pid" 2>/dev/null && curl -fsS http://127.0.0.1:3100/ >/dev/null; then
        echo "Web: running (PID $web_pid, http://192.168.3.253:3100)"
    else
        echo "Web: stopped"
    fi
    echo "Agent log: $agent_log"
    echo "Web log: $web_log"
}

start_services() {
    local old_agent_pid new_agent_pid web_pid command_line
    [[ -x "$bun_bin" ]] || { echo "Bun was not found." >&2; exit 1; }
    [[ -x "$node_bin" ]] || { echo "Node.js was not found." >&2; exit 1; }

    echo "Preparing Canvas Agent..."
    cd "$agent_dir"
    [[ -x node_modules/.bin/tsc ]] || "$bun_bin" install --frozen-lockfile --network-concurrency 4
    "$bun_bin" run build

    if [[ -f "$HOME/.infinite-canvas/canvas-agent.json" ]]; then
        chmod 700 "$HOME/.infinite-canvas"
        chmod 600 "$HOME/.infinite-canvas/canvas-agent.json"
    fi

    old_agent_pid="$(known_agent_pid || true)"
    [[ -z "$old_agent_pid" ]] || stop_known_pid "$old_agent_pid" Agent
    : > "$agent_log"
    chmod 600 "$agent_log"
    nohup "$node_bin" "$agent_dir/dist/index.js" --debug >> "$agent_log" 2>&1 </dev/null &
    new_agent_pid=$!
    echo "$new_agent_pid" > "$agent_pid_file"

    for _ in {1..50}; do
        curl -fsS http://127.0.0.1:17371/health >/dev/null 2>&1 && break
        kill -0 "$new_agent_pid" 2>/dev/null || { echo "Canvas Agent failed. Log: $agent_log" >&2; exit 1; }
        sleep 0.2
    done
    curl -fsS http://127.0.0.1:17371/health >/dev/null || { echo "Canvas Agent health check failed. Log: $agent_log" >&2; exit 1; }

    echo "Building and starting Web..."
    cd "$root_dir"
    INFINITE_CANVAS_ALLOWED_NETWORKS="${INFINITE_CANVAS_ALLOWED_NETWORKS:-127.0.0.1,::1,192.168.0.0/22,172.16.0.0/12}" VITE_CANVAS_AGENT_URL="/api/canvas-agent" ./run-background.sh
    read -r web_pid < "$web_pid_file"
    for _ in {1..120}; do
        command_line="$(pid_command "$web_pid")"
        if [[ "$command_line" == *"$root_dir/web/node_modules/vite/bin/vite.js preview"* ]] && curl -fsS http://127.0.0.1:3100/ >/dev/null 2>&1; then
            break
        fi
        kill -0 "$web_pid" 2>/dev/null || { echo "Web build failed. Log: $web_log" >&2; exit 1; }
        sleep 1
    done
    command_line="$(pid_command "$web_pid")"
    [[ "$command_line" == *"$root_dir/web/node_modules/vite/bin/vite.js preview"* ]] || { echo "Web startup timed out. Log: $web_log" >&2; exit 1; }
    curl -fsS http://127.0.0.1:3100/api/canvas-agent/health >/dev/null || { echo "Canvas Agent proxy health check failed." >&2; exit 1; }

    echo "All Infinite Canvas services are ready."
    service_status
}

case "$action" in
    start) start_services ;;
    restart) stop_services; start_services ;;
    stop) stop_services; service_status ;;
    status) service_status ;;
    *) echo "Usage: $0 [start|restart|stop|status]" >&2; exit 2 ;;
esac

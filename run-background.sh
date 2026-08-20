#!/usr/bin/env bash
set -Eeuo pipefail

root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
web_dir="$root_dir/web"
port="${PORT:-3100}"
runtime_dir="${RUNTIME_DIR:-/tmp/infinite-canvas-$UID}"
pid_file="$runtime_dir/preview.pid"
log_file="$runtime_dir/build-and-preview.log"
bun_bin="${BUN_BIN:-}"
agent_url="${VITE_CANVAS_AGENT_URL:-}"

if [[ -z "$bun_bin" ]]; then
    bun_bin="$(command -v bun || true)"
fi
if [[ ! -x "$bun_bin" && -x "$HOME/.bun/bin/bun" ]]; then
    bun_bin="$HOME/.bun/bin/bun"
fi

if [[ ! "$port" =~ ^[0-9]+$ ]] || (( port < 1 || port > 65535 )); then
    echo "Invalid PORT: $port" >&2
    exit 1
fi

if [[ ! -x "$bun_bin" ]]; then
    echo "Bun was not found. Set BUN_BIN to its absolute path." >&2
    exit 1
fi

if [[ ! -f "$web_dir/node_modules/vite/bin/vite.js" ]]; then
    echo "Dependencies are missing. Run bun install in $web_dir first." >&2
    exit 1
fi

mkdir -p "$runtime_dir"
old_pid=""

is_project_preview() {
    [[ "$1" == *"$web_dir/node_modules/.bin/vite preview"* || "$1" == *"$web_dir/node_modules/vite/bin/vite.js preview"* ]]
}

if [[ -f "$pid_file" ]]; then
    read -r candidate < "$pid_file" || true
    if [[ "$candidate" =~ ^[0-9]+$ ]] && kill -0 "$candidate" 2>/dev/null; then
        command_line="$(ps -p "$candidate" -o args=)"
        if ! is_project_preview "$command_line"; then
            echo "A background build is already running with PID $candidate. Log: $log_file" >&2
            exit 1
        fi
        old_pid="$candidate"
    else
        rm -f "$pid_file"
    fi
fi

if [[ -z "$old_pid" ]]; then
    mapfile -t port_pids < <(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
    for candidate in "${port_pids[@]}"; do
        command_line="$(ps -p "$candidate" -o args=)"
        if is_project_preview "$command_line"; then
            old_pid="$candidate"
            break
        fi
    done
    if ((${#port_pids[@]} > 0)) && [[ -z "$old_pid" ]]; then
        echo "Port $port is occupied by another process; refusing to stop it." >&2
        exit 1
    fi
fi

{
    echo
    echo "[$(date '+%F %T')] Background build requested (port=$port, previous_pid=${old_pid:-none})"
} >> "$log_file"

nohup bash -Eeuo pipefail -c '
    web_dir="$1"
    port="$2"
    pid_file="$3"
    old_pid="$4"
    bun_bin="$5"
    agent_url="$6"
    [[ -n "$agent_url" ]] && export VITE_CANVAS_AGENT_URL="$agent_url"

    cleanup_on_error() {
        status=$?
        if ((status != 0)); then
            rm -f "$pid_file"
            echo "[$(date "+%F %T")] Build or startup failed with status $status"
        fi
    }
    trap cleanup_on_error EXIT

    cd "$web_dir"
    echo "[$(date "+%F %T")] Building..."
    "$bun_bin" run build

    if [[ -n "$old_pid" ]] && kill -0 "$old_pid" 2>/dev/null; then
        echo "[$(date "+%F %T")] Stopping previous preview (PID $old_pid)..."
        kill -TERM "$old_pid"
        for _ in {1..20}; do
            kill -0 "$old_pid" 2>/dev/null || break
            sleep 0.5
        done
        if kill -0 "$old_pid" 2>/dev/null; then
            echo "Previous preview did not stop within 10 seconds."
            exit 1
        fi
    fi

    echo "[$(date "+%F %T")] Starting preview on 0.0.0.0:$port..."
    exec "$bun_bin" "$web_dir/node_modules/vite/bin/vite.js" preview --host 0.0.0.0 --port "$port"
' bash "$web_dir" "$port" "$pid_file" "$old_pid" "$bun_bin" "$agent_url" >> "$log_file" 2>&1 </dev/null &

new_pid=$!
echo "$new_pid" > "$pid_file"

echo "Background build started with PID $new_pid."
echo "Log: $log_file"
echo "URL after a successful build: http://192.168.2.231:$port"

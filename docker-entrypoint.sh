#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
agent_pid=""
web_pid=""
cleanup() {
    local status=$?
    trap - EXIT INT TERM
    for pid in "$web_pid" "$agent_pid"; do
        [[ -z "$pid" ]] || kill -TERM "$pid" 2>/dev/null || true
    done
    for pid in "$web_pid" "$agent_pid"; do
        [[ -z "$pid" ]] || wait "$pid" 2>/dev/null || true
    done
    exit "$status"
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

bun /usr/local/lib/infinite-canvas/configure-runtime.mjs
cd /app/canvas-agent
# Do not let the web PORT move the loopback-only Agent off its proxy target.
PORT=17371 node dist/index.js &
agent_pid=$!
for _ in {1..60}; do
    if bun -e 'fetch("http://127.0.0.1:17371/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'; then
        break
    fi
    kill -0 "$agent_pid" 2>/dev/null || { echo "Canvas Agent exited during startup" >&2; exit 1; }
    sleep 0.25
done
bun -e 'fetch("http://127.0.0.1:17371/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'
cd /app/web
bun node_modules/vite/bin/vite.js preview --host 0.0.0.0 --port "${PORT:-3000}" --strictPort &
web_pid=$!
set +e
wait -n "$agent_pid" "$web_pid"
status=$?
set -e
echo "An application process exited (status $status); stopping the container" >&2
((status != 0)) || status=1
exit "$status"

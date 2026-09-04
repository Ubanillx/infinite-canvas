#!/usr/bin/env bash
set -Eeuo pipefail

agent_log=/tmp/infinite-canvas-agent.log
web_log=/tmp/infinite-canvas-web.log

health_check() {
    bun -e 'fetch("http://127.0.0.1:17371/health").then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))'
}

cleanup() {
    if [[ -n "${agent_pid:-}" ]] && kill -0 "$agent_pid" 2>/dev/null; then
        kill -TERM "$agent_pid" 2>/dev/null || true
        wait "$agent_pid" 2>/dev/null || true
    fi
}
trap cleanup EXIT INT TERM

cd /app/canvas-agent
bun dist/index.js --debug >>"$agent_log" 2>&1 &
agent_pid=$!

for _ in {1..60}; do
    if health_check; then break; fi
    if ! kill -0 "$agent_pid" 2>/dev/null; then
        cat "$agent_log" >&2
        exit 1
    fi
    sleep 0.25
done
health_check || { cat "$agent_log" >&2; exit 1; }

cd /app/web
exec bun x vite preview --host 0.0.0.0 --port "${PORT:-3000}" 2> >(tee "$web_log" >&2)

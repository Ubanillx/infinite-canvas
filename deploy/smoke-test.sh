#!/usr/bin/env bash
set -Eeuo pipefail
: "${APP_IMAGE:?}"
container="$(docker run -d --init --network none \
    --tmpfs /data:uid=1000,gid=1000,mode=0700 \
    --tmpfs /home/node/.infinite-canvas:uid=1000,gid=1000,mode=0700 \
    --tmpfs /home/node/.codex:uid=1000,gid=1000,mode=0700 "$APP_IMAGE")"
cleanup() {
    status=$?
    trap - EXIT INT TERM
    if ((status != 0)); then docker logs "$container" >&2 || true; fi
    docker rm -f "$container" >/dev/null || true
    exit "$status"
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
deadline=$((SECONDS + 120))
while ((SECONDS < deadline)); do
    state="$(docker inspect --format '{{.State.Status}} {{.State.Health.Status}}' "$container")"
    if [[ "$state" == 'running healthy' ]]; then
        echo 'Container smoke test passed (Web, SQLite/authentication, Agent proxy)'
        exit 0
    fi
    [[ "$state" != exited* && "$state" != dead* ]] || exit 1
    sleep 1
done
echo 'Container smoke test timed out after 120 seconds' >&2
exit 1

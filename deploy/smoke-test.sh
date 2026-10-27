#!/usr/bin/env bash
# 用 Compose 起一套隔离的 app + PostgreSQL + RustFS 做冒烟检查，
# 结束时无论成败都删除容器与临时卷。
set -Eeuo pipefail
: "${APP_IMAGE:?}"
project="infinite-canvas-smoke"
compose_file="docker-compose.smoke.yml"

cleanup() {
    status=$?
    trap - EXIT INT TERM
    if ((status != 0)); then
        APP_IMAGE="$APP_IMAGE" docker compose -p "$project" -f "$compose_file" logs app >&2 || true
    fi
    APP_IMAGE="$APP_IMAGE" docker compose -p "$project" -f "$compose_file" down -v --remove-orphans >/dev/null 2>&1 || true
    exit "$status"
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

APP_IMAGE="$APP_IMAGE" docker compose -p "$project" -f "$compose_file" up -d --wait --wait-timeout 120
echo 'Container smoke test passed (Web, PostgreSQL authentication, RustFS media, Agent proxy)'

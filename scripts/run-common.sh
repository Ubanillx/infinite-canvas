#!/usr/bin/env bash
# Shared runtime helpers for the local start scripts. Source only; no side effects.

resolve_runtime_tools() {
    if [[ -n "${BUN_BIN:-}" ]]; then
        bun_bin="$BUN_BIN"
    else
        bun_bin="$(command -v bun || true)"
    fi
    [[ -x "$bun_bin" ]] || bun_bin="$HOME/.bun/bin/bun"

    if [[ -n "${NODE_BIN:-}" ]]; then
        node_bin="$NODE_BIN"
    else
        node_bin=""
        # Prefer the user's nvm Node so bundled/local Codex versions and auth
        # environment remain consistent after non-interactive restarts.
        for candidate in "$HOME"/.nvm/versions/node/*/bin/node; do
            [[ -x "$candidate" ]] && node_bin="$candidate"
        done
        [[ -n "$node_bin" ]] || node_bin="$(command -v node || true)"
    fi
}

set_runtime_dir() {
    runtime_dir="${RUNTIME_DIR:-/tmp/infinite-canvas-$UID}"
}

prepare_runtime_dir() {
    set_runtime_dir
    mkdir -p -m 700 "$runtime_dir"
    chmod 700 "$runtime_dir"
}

protect_agent_config() {
    if [[ -f "$HOME/.infinite-canvas/canvas-agent.json" ]]; then
        chmod 700 "$HOME/.infinite-canvas"
        chmod 600 "$HOME/.infinite-canvas/canvas-agent.json"
    fi
}

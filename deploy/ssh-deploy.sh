#!/usr/bin/env bash
set -Eeuo pipefail
set +x
: "${DEPLOY_HOST:?}" "${DEPLOY_USER:?}" "${DEPLOY_KEY:?}" "${KNOWN_HOSTS:?}"
: "${DEPLOY_DIR:?}" "${COMPOSE_PROJECT:?}" "${RELEASE_SHA:?}" "${BUILD_NUMBER:?}"
DEPLOY_PORT="${DEPLOY_PORT:-22}"
[[ "$DEPLOY_HOST" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || { echo 'Invalid SSH host' >&2; exit 2; }
[[ "$DEPLOY_USER" =~ ^[a-z_][a-zA-Z0-9_-]*$ ]] || exit 2
[[ "$DEPLOY_PORT" =~ ^[0-9]+$ ]] && ((10#$DEPLOY_PORT >= 1 && 10#$DEPLOY_PORT <= 65535)) || exit 2
[[ "$DEPLOY_DIR" =~ ^/opt/[a-zA-Z0-9][a-zA-Z0-9_-]*$ ]] || { echo 'Use a direct child of /opt' >&2; exit 2; }
[[ "$COMPOSE_PROJECT" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || exit 2
[[ "$RELEASE_SHA" =~ ^[a-f0-9]{40}$ && "$BUILD_NUMBER" =~ ^[0-9]+$ ]] || exit 2
release="$RELEASE_SHA-$BUILD_NUMBER"
target="$DEPLOY_USER@$DEPLOY_HOST"
ssh_opts=(-i "$DEPLOY_KEY" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$KNOWN_HOSTS" -o GlobalKnownHostsFile=/dev/null)
ssh "${ssh_opts[@]}" -p "$DEPLOY_PORT" "$target" "set -eu; umask 077; test -d '$DEPLOY_DIR/shared'; test -f '$DEPLOY_DIR/shared/production.env'; mkdir -p '$DEPLOY_DIR/incoming'; mkdir '$DEPLOY_DIR/incoming/$release'"
scp "${ssh_opts[@]}" -P "$DEPLOY_PORT" .ci/release.tar.gz "$target:$DEPLOY_DIR/incoming/$release/release.tar.gz"
# The script itself is sent over the authenticated channel, not executed from an unchecked archive.
ssh "${ssh_opts[@]}" -p "$DEPLOY_PORT" "$target" "bash -s -- '$DEPLOY_DIR' '$release' '$COMPOSE_PROJECT'" < deploy/remote-deploy.sh

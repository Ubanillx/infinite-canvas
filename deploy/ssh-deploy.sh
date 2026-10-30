#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077
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
# rsync invokes this fixed adapter so SSH credential paths never need shell-string quoting.
if [[ "${1:-}" == --rsync-ssh ]]; then
    shift
    exec ssh "${ssh_opts[@]}" -p "$DEPLOY_PORT" "$@"
fi
command -v rsync >/dev/null || { echo 'Install rsync on the Jenkins build node first' >&2; exit 1; }
stage='remote preflight'
trap 'status=$?; printf "SSH deployment failed during %s (exit %s)\n" "$stage" "$status" >&2' ERR
if [[ "${1:-}" == --retention ]]; then
    stage='image retention discovery'
    mkdir -p .ci
    rm -f .ci/retained-images .ci/retained-images.pending
    retained="$(ssh "${ssh_opts[@]}" -p "$DEPLOY_PORT" "$target" "set -eu
test -d '$DEPLOY_DIR/shared' || exit 0
test \"\$(realpath '$DEPLOY_DIR')\" = '$DEPLOY_DIR' || { echo 'Deployment directory cannot be a symlink' >&2; exit 1; }
test \"\$(realpath '$DEPLOY_DIR/shared')\" = '$DEPLOY_DIR/shared' || { echo 'Shared directory cannot be a symlink' >&2; exit 1; }
exec 9>'$DEPLOY_DIR/.deploy.lock'
flock -n 9 || { echo 'Another deployment is active' >&2; exit 1; }
test ! -L '$DEPLOY_DIR/shared/retained-images' || { echo 'Image retention record cannot be a symlink' >&2; exit 1; }
if test -f '$DEPLOY_DIR/shared/retained-images'; then
    test -L '$DEPLOY_DIR/current' || { echo 'No managed current release for image retention' >&2; exit 1; }
    grep -Fxq -- \"\$(cat '$DEPLOY_DIR/current/image-ref')\" '$DEPLOY_DIR/shared/retained-images' || { echo 'Image retention record does not include the current release' >&2; exit 1; }
    cat '$DEPLOY_DIR/shared/retained-images'
fi")"
    if [[ -n "$retained" ]]; then printf '%s\n' "$retained" > .ci/retained-images; fi
    exit 0
fi
(( $# == 0 )) || { echo 'Unknown deployment operation' >&2; exit 2; }
[[ "$(cat .ci/image-ref)" == "infinite-canvas:$release" && "$(cat .ci/revision)" == "$RELEASE_SHA" ]] || {
    echo "Release metadata does not match build $BUILD_NUMBER. Start a new build from Checkout deploy; restarting from a later stage is unsupported." >&2
    exit 2
}
preflight_output="$(ssh "${ssh_opts[@]}" -p "$DEPLOY_PORT" "$target" "set -eu
umask 077
test -d '$DEPLOY_DIR/shared' || { echo 'Missing deployment directory: $DEPLOY_DIR/shared' >&2; exit 1; }
test -f '$DEPLOY_DIR/shared/production.env' && test -r '$DEPLOY_DIR/shared/production.env' || { echo 'Initialize readable $DEPLOY_DIR/shared/production.env first (see deploy/README.md)' >&2; exit 1; }
test -w '$DEPLOY_DIR' && test -w '$DEPLOY_DIR/shared' || { echo 'Deployment directories must be writable by the SSH user' >&2; exit 1; }
test \"\$(realpath '$DEPLOY_DIR/shared')\" = '$DEPLOY_DIR/shared' || { echo 'Shared directory cannot be a symlink' >&2; exit 1; }
command -v rsync >/dev/null || { echo 'Install rsync on the deployment host first' >&2; exit 1; }
test ! -L '$DEPLOY_DIR/shared/image-transfer' && test ! -L '$DEPLOY_DIR/shared/image-transfer/image.tar' || { echo 'Image transfer cache cannot be a symlink' >&2; exit 1; }
test ! -e '$DEPLOY_DIR/shared/image-transfer/image.tar' || test -f '$DEPLOY_DIR/shared/image-transfer/image.tar' || { echo 'Image transfer cache must be a regular file' >&2; exit 1; }
mkdir -p '$DEPLOY_DIR/shared/image-transfer'
mkdir -p '$DEPLOY_DIR/incoming'
mkdir '$DEPLOY_DIR/incoming/$release'
for image in postgres:17-alpine rustfs/rustfs:latest amazon/aws-cli:latest; do
    docker image inspect --format '{{.Id}}' \"\$image\" >/dev/null 2>&1 || printf 'MISSING_IMAGE=%s\n' \"\$image\"
done")"
missing_images="$(printf '%s\n' "$preflight_output" | sed -n 's/^MISSING_IMAGE=//p')"
if [[ -n "$missing_images" ]]; then
    # 部署主机不访问镜像仓库，缺失的数据服务镜像由构建节点导出后经 SSH 传输。
    printf 'Transferring missing infrastructure images: %s\n' "$(printf '%s' "$missing_images" | tr '\n' ' ')" >&2
    stage='infrastructure image upload'
    mapfile -t images <<< "$missing_images"
    mkdir -p .ci
    docker save "${images[@]}" | gzip > .ci/infra-images.tar.gz
    scp "${ssh_opts[@]}" -P "$DEPLOY_PORT" .ci/infra-images.tar.gz "$target:$DEPLOY_DIR/incoming/$release/infra-images.tar.gz"
    ssh "${ssh_opts[@]}" -p "$DEPLOY_PORT" "$target" "gzip -dc '$DEPLOY_DIR/incoming/$release/infra-images.tar.gz' | docker load && rm -f '$DEPLOY_DIR/incoming/$release/infra-images.tar.gz'"
fi
stage='image delta upload'
rsync --times --perms --chmod=F600 --checksum --compress --no-whole-file --stats \
    --copy-dest="$DEPLOY_DIR/shared/image-transfer" \
    --rsh='bash deploy/ssh-deploy.sh --rsync-ssh' \
    .ci/image.tar "$target:$DEPLOY_DIR/incoming/$release/"
stage='release upload'
scp "${ssh_opts[@]}" -P "$DEPLOY_PORT" .ci/release.tar.gz "$target:$DEPLOY_DIR/incoming/$release/release.tar.gz"
# The script itself is sent over the authenticated channel, not executed from an unchecked archive.
stage='remote activation'
mkdir -p .ci
# An interrupted SSH activation has an unknown outcome; never prune from stale local history.
rm -f .ci/retained-images .ci/retained-images.pending
ssh "${ssh_opts[@]}" -p "$DEPLOY_PORT" "$target" "bash -s -- '$DEPLOY_DIR' '$release' '$COMPOSE_PROJECT'" < deploy/remote-deploy.sh
stage='image retention download'
scp "${ssh_opts[@]}" -P "$DEPLOY_PORT" "$target:$DEPLOY_DIR/shared/retained-images" .ci/retained-images.pending
read -r retained_current < .ci/retained-images.pending
[[ "$retained_current" == "infinite-canvas:$release" ]] || { echo 'Deployment image retention record does not match this release' >&2; exit 1; }
chmod 600 .ci/retained-images.pending
mv -fT .ci/retained-images.pending .ci/retained-images

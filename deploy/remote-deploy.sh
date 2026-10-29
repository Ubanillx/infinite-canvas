#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
root="${1:?deployment directory}"
release="${2:?release id}"
project="${3:?compose project}"
[[ "$root" =~ ^/opt/[a-zA-Z0-9][a-zA-Z0-9_-]*$ && "$release" =~ ^[a-f0-9]{40}-[0-9]+$ && "$project" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || exit 2
[[ -d "$root/shared" && -f "$root/shared/production.env" ]] || { echo 'Initialize shared/production.env first' >&2; exit 1; }
[[ "$(realpath "$root")" == "$root" ]] || { echo 'Deployment directory cannot be a symlink' >&2; exit 1; }
[[ "$(realpath "$root/shared")" == "$root/shared" ]] || { echo 'Shared directory cannot be a symlink' >&2; exit 1; }
exec 9>"$root/.deploy.lock"
flock -n 9 || { echo 'Another deployment is active' >&2; exit 1; }
cache="$root/shared/image-transfer"
[[ ! -L "$cache" && ! -L "$cache/image.tar" ]] || { echo 'Image transfer cache cannot be a symlink' >&2; exit 1; }
[[ ! -e "$cache/image.tar" || -f "$cache/image.tar" ]] || { echo 'Image transfer cache must be a regular file' >&2; exit 1; }
mkdir -p "$cache"
docker info >/dev/null
docker compose version
docker compose up --help | grep -q -- '--wait-timeout'
incoming="$root/incoming/$release"
destination="$root/releases/$release"
[[ ! -e "$destination" ]] || { echo 'Release already exists' >&2; exit 1; }
mkdir -p "$root/releases"
mkdir "$destination"
# Extract only the fixed, non-secret deployment payload, never arbitrary paths.
tar -xzf "$incoming/release.tar.gz" -C "$destination" --no-same-owner --no-same-permissions \
    compose.yml remote-deploy.sh import-codex-config.sh cleanup-docker.sh image-ref image-id revision SHA256SUMS
[[ -f "$incoming/image.tar" && ! -L "$incoming/image.tar" ]] || { echo 'Missing regular image.tar transfer' >&2; exit 1; }
mv "$incoming/image.tar" "$destination/image.tar"
chmod 600 "$destination/image.tar"
cd "$destination"
sha256sum -c SHA256SUMS
image="$(cat image-ref)"
image_id="$(cat image-id)"
revision="$(cat revision)"
[[ "$image" == "infinite-canvas:$release" && "$image_id" =~ ^sha256:[a-f0-9]{64}$ && "$revision" == "${release%-*}" ]] || exit 2
docker load < image.tar
[[ "$(docker image inspect --format '{{.Id}}' "$image")" == "$image_id" ]] || { echo 'Loaded image does not match build' >&2; exit 1; }
[[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" == "$revision" ]] || exit 1
printf 'APP_IMAGE=%s\n' "$image" > image.env
chmod 600 "$root/shared/production.env"
install -m 600 "$root/shared/production.env" runtime.env
# 数据服务（PostgreSQL / RustFS）是长期有状态组件：
#   - 只运行 deployment 的 app 服务，由 --no-deps 保证不会连带重置数据服务；
#   - 镜像与配置回滚只回滚 app，数据库和对象存储不随发布回滚。
compose() {
    local dir="$1"; shift
    APP_IMAGE="$(cat "$dir/image-ref")" docker compose --project-name "$project" --env-file "$dir/runtime.env" --env-file "$dir/image.env" -f "$dir/compose.yml" "$@"
}
sync_magpie_gateway() {
    local app
    app="$(compose "$1" ps -q app)" || return
    [[ -n "$app" ]] || { echo 'Cannot find app container for Magpie synchronization' >&2; return 1; }
    bash "$destination/import-codex-config.sh" --container "$app" --sync-magpie-gateway
}
compose "$destination" config --quiet
previous=""
previous_image=""
[[ ! -e "$root/current" || -L "$root/current" ]] || { echo 'current must be a managed symlink' >&2; exit 1; }
if [[ -L "$root/current" ]]; then
    previous="$(realpath "$root/current")"
    [[ "$previous" == "$root/releases/"* && -f "$previous/image.env" && -f "$previous/image-ref" && -f "$previous/runtime.env" && -f "$previous/compose.yml" ]] || { echo 'Invalid current release' >&2; exit 1; }
    previous_image="$(cat "$previous/image-ref")"
    [[ "$previous_image" =~ ^infinite-canvas:[a-f0-9]{40}-[0-9]+$ ]] || { echo 'Invalid previous image reference' >&2; exit 1; }
elif [[ -n "$(compose "$destination" ps -a -q app)" ]]; then
    echo 'Existing containers are not managed by this release directory; migrate explicitly first' >&2
    exit 1
fi
if [[ -f "$root/shared/project-name" ]]; then
    [[ "$(cat "$root/shared/project-name")" == "$project" ]] || { echo 'Changing project would detach persistent volumes' >&2; exit 1; }
else
    printf '%s\n' "$project" > "$root/shared/project-name"
fi
# ssh-deploy.sh 会在激活前传输缺失的数据服务镜像；这里再次校验，避免直接运行本脚本时静默失败。
# 缺少时给出明确提示，而不是让 compose 在此处静默拉取或长时间等待。
for infrastructure_image in postgres:17-alpine rustfs/rustfs:latest amazon/aws-cli:latest; do
    docker image inspect --format '{{.Id}}' "$infrastructure_image" >/dev/null 2>&1 \
        || { echo "Missing infrastructure image $infrastructure_image; preload it on the deploy host first" >&2; exit 1; }
done
retention="$root/shared/.retained-images-$release"
[[ ! -e "$retention" && ! -L "$retention" && ! -L "$root/shared/retained-images" ]] || { echo 'Unsafe image retention record path' >&2; exit 1; }
printf '%s\n' "$image" > "$retention"
if [[ -n "$previous_image" ]]; then printf '%s\n' "$previous_image" >> "$retention"; fi
rollback() {
    local status=$?
    trap - EXIT INT TERM
    if [[ -n "$previous" ]]; then
        echo 'Deployment failed; restoring the previous image (data is not rolled back)' >&2
        if compose "$previous" up -d --no-deps --no-build --pull never --wait --wait-timeout 120 app \
            && sync_magpie_gateway "$previous"; then
            echo 'Previous release restored' >&2
        else
            echo 'ROLLBACK FAILED: manual intervention required' >&2
        fi
    else
        echo 'First deployment failed: no previous release; preserving containers and files for investigation' >&2
    fi
    rm -f "$retention" || echo 'Warning: could not remove temporary image retention record' >&2
    exit "$status"
}
trap rollback EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
compose "$destination" up -d --no-build --pull never --wait --wait-timeout 120
container="$(compose "$destination" ps -q app)"
[[ -n "$container" && "$(docker inspect --format '{{.Image}}' "$container")" == "$image_id" ]]
[[ "$(docker inspect --format '{{.State.Health.Status}}' "$container")" == healthy ]]
sync_magpie_gateway "$destination"
ln -s "releases/$release" "$root/.current-$release"
mv -Tf "$root/.current-$release" "$root/current"
trap - EXIT INT TERM
if mv -fT "$retention" "$root/shared/retained-images"; then
    bash "$destination/cleanup-docker.sh" "$root/shared/retained-images" \
        || echo 'Warning: deployment image cleanup failed; the healthy release is retained' >&2
else
    # An old record must not authorize a later cleanup after the current pointer changed.
    rm -f "$root/shared/retained-images" "$retention" || true
    echo 'Warning: could not update image retention record; image cleanup skipped' >&2
fi
# Replace the delta basis only after health checks; rsync never edits it in place.
mv -fT "$destination/image.tar" "$cache/.image-$release.tar" \
    && mv -fT "$cache/.image-$release.tar" "$cache/image.tar" \
    || echo 'Warning: could not update image transfer cache' >&2
rm -f "$incoming/release.tar.gz" || echo 'Warning: could not remove release archive' >&2
echo "Deployment is healthy: $release ($image_id)"

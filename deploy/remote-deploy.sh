#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
root="${1:?deployment directory}"
release="${2:?release id}"
project="${3:?compose project}"
[[ "$root" =~ ^/opt/[a-zA-Z0-9][a-zA-Z0-9_-]*$ && "$release" =~ ^[a-f0-9]{40}-[0-9]+$ && "$project" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || exit 2
[[ -d "$root/shared" && -f "$root/shared/production.env" ]] || { echo 'Initialize shared/production.env first' >&2; exit 1; }
[[ "$(realpath "$root")" == "$root" ]] || { echo 'Deployment directory cannot be a symlink' >&2; exit 1; }
exec 9>"$root/.deploy.lock"
flock -n 9 || { echo 'Another deployment is active' >&2; exit 1; }
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
    image.tar.gz compose.yml remote-deploy.sh image-ref image-id revision SHA256SUMS
cd "$destination"
sha256sum -c SHA256SUMS
image="$(cat image-ref)"
image_id="$(cat image-id)"
revision="$(cat revision)"
[[ "$image" == "infinite-canvas:$release" && "$image_id" =~ ^sha256:[a-f0-9]{64}$ && "$revision" == "${release%-*}" ]] || exit 2
gzip -dc image.tar.gz | docker load
[[ "$(docker image inspect --format '{{.Id}}' "$image")" == "$image_id" ]] || { echo 'Loaded image does not match build' >&2; exit 1; }
[[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" == "$revision" ]] || exit 1
printf 'APP_IMAGE=%s\n' "$image" > image.env
chmod 600 "$root/shared/production.env"
install -m 600 "$root/shared/production.env" runtime.env
compose() {
    local dir="$1"; shift
    APP_IMAGE="$(cat "$dir/image-ref")" docker compose --project-name "$project" --env-file "$dir/runtime.env" --env-file "$dir/image.env" -f "$dir/compose.yml" "$@"
}
compose "$destination" config --quiet
previous=""
[[ ! -e "$root/current" || -L "$root/current" ]] || { echo 'current must be a managed symlink' >&2; exit 1; }
if [[ -L "$root/current" ]]; then
    previous="$(realpath "$root/current")"
    [[ "$previous" == "$root/releases/"* && -f "$previous/image.env" && -f "$previous/image-ref" && -f "$previous/runtime.env" && -f "$previous/compose.yml" ]] || { echo 'Invalid current release' >&2; exit 1; }
elif [[ -n "$(compose "$destination" ps -a -q app)" ]]; then
    echo 'Existing containers are not managed by this release directory; migrate explicitly first' >&2
    exit 1
fi
if [[ -f "$root/shared/project-name" ]]; then
    [[ "$(cat "$root/shared/project-name")" == "$project" ]] || { echo 'Changing project would detach persistent volumes' >&2; exit 1; }
else
    printf '%s\n' "$project" > "$root/shared/project-name"
fi
rollback() {
    local status=$?
    trap - EXIT INT TERM
    if [[ -n "$previous" ]]; then
        echo 'Deployment failed; restoring the previous image (data is not rolled back)' >&2
        if compose "$previous" up -d --no-build --pull never --wait --wait-timeout 120; then
            echo 'Previous release restored' >&2
        else
            echo 'ROLLBACK FAILED: manual intervention required' >&2
        fi
    else
        echo 'First deployment failed: no previous release; preserving containers and files for investigation' >&2
    fi
    exit "$status"
}
trap rollback EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
compose "$destination" up -d --no-build --pull never --wait --wait-timeout 120
container="$(compose "$destination" ps -q app)"
[[ -n "$container" && "$(docker inspect --format '{{.Image}}' "$container")" == "$image_id" ]]
[[ "$(docker inspect --format '{{.State.Health.Status}}' "$container")" == healthy ]]
ln -s "releases/$release" "$root/.current-$release"
mv -Tf "$root/.current-$release" "$root/current"
trap - EXIT INT TERM
rm -f "$destination/image.tar.gz" "$incoming/release.tar.gz" || echo 'Warning: could not remove transfer archives' >&2
echo "Deployment is healthy: $release ($image_id)"

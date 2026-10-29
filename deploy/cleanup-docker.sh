#!/usr/bin/env bash
set -Eeuo pipefail
if [[ $# == 1 && "$1" == --build-cache ]]; then
    docker builder prune --force
    exit 0
fi
state="${1:?retained image record}"
cache=false
if [[ "${2:-}" == --build-cache && $# == 2 ]]; then
    cache=true
elif (( $# != 1 )); then
    echo 'Usage: cleanup-docker.sh RETAINED_IMAGES [--build-cache]' >&2
    exit 2
fi
declare -a retained=()
declare -A keep_refs=() keep_ids=()
if [[ -e "$state" || -L "$state" ]]; then
    [[ -f "$state" && ! -L "$state" ]] || { echo 'Image retention record must be a regular file' >&2; exit 1; }
    mapfile -t retained < "$state"
    (( ${#retained[@]} >= 1 && ${#retained[@]} <= 2 )) || { echo 'Invalid image retention record' >&2; exit 1; }
    for ref in "${retained[@]}"; do
        [[ "$ref" =~ ^infinite-canvas:[a-f0-9]{40}-[0-9]+$ ]] || { echo 'Invalid retained image' >&2; exit 1; }
        [[ ! ${keep_refs[$ref]+present} ]] || { echo 'Duplicate retained image' >&2; exit 1; }
        keep_refs["$ref"]=1
    done

    images="$(docker image ls --no-trunc --filter 'reference=infinite-canvas:*' --format '{{.Repository}}:{{.Tag}} {{.ID}}')"
    while read -r ref id; do
        [[ -n "$ref" ]] || continue
        [[ "$id" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'Invalid Docker image snapshot; cleanup stopped' >&2; exit 1; }
        if [[ ${keep_refs[$ref]+present} ]]; then keep_ids["$id"]=1; fi
    done <<< "$images"
    containers="$(docker container ls --all --quiet)"
    if [[ -n "$containers" ]]; then
        mapfile -t ids <<< "$containers"
        used="$(docker container inspect --format '{{.Image}}' "${ids[@]}")"
        while read -r id; do
            [[ "$id" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'Invalid container image snapshot; cleanup stopped' >&2; exit 1; }
            keep_ids["$id"]=1
        done <<< "$used"
    fi
    while read -r ref id; do
        [[ "$ref" =~ ^infinite-canvas:[a-f0-9]{40}-[0-9]+$ ]] || continue
        [[ ${keep_ids[$id]+present} ]] && continue
        printf 'Removing old application image: %s\n' "$ref"
        docker image rm "$ref"
    done <<< "$images"
else
    echo 'Image cleanup skipped: no successful deployment record; existing images are preserved.'
fi
if "$cache"; then
    docker builder prune --force
fi

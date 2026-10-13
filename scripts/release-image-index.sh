#!/usr/bin/env bash
# Assembles and tags the multi-architecture image of a release. Run by the
# `publish` job of .github/workflows/release.yml, in two steps with the
# attestation between them, so that `latest` never names an unattested image:
#
#   release-image-index.sh create <image> <version> <digests-dir>
#       Creates <image>:<version> from the per-architecture digests (one empty
#       file per digest in <digests-dir>, named by its hex) and prints the
#       digest of the result; also written to $GITHUB_OUTPUT as `digest`.
#       A version tag never moves: when <image>:<version> already exists it is
#       kept if it holds exactly these platform images (a re-run of the same
#       release), refused otherwise.
#       OCI annotations are read from $DOCKER_METADATA_OUTPUT_JSON when set
#       (docker/metadata-action, `index:` level).
#
#   release-image-index.sh alias <image> <digest> <tag>...
#       Points each <image>:<tag> at <digest> (the aliases of a final release:
#       <major>.<minor>, latest) and checks that each one names that digest.
#
# Needs docker buildx and jq, and a registry login done by the caller.
set -euo pipefail
shopt -s inherit_errexit

fail() {
  echo "::error title=Image not published::$*" >&2
  exit 1
}

# Digest of the manifest (or index) a reference names.
digest_of() {
  docker buildx imagetools inspect "$1" --format '{{json .Manifest}}' | jq -r '.digest'
}

# Digests of the platform images under a reference, one per line, sorted.
# Attestation manifests (platform unknown/unknown) are not images.
platform_images_of() {
  docker buildx imagetools inspect "$1" --raw \
    | jq -r '.manifests[]? | select(.platform.architecture != "unknown") | .digest' \
    | sort
}

create() {
  local image="$1" version="$2" digests_dir="$3"
  local sources=() arguments=() name annotation expected existing digest

  for name in "$digests_dir"/*; do
    [ -e "$name" ] || fail "no architecture digest in ${digests_dir}"
    sources+=("${image}@sha256:$(basename "$name")")
  done
  [ "${#sources[@]}" -ge 2 ] || fail "expected one digest per architecture, found ${#sources[@]} in ${digests_dir}"

  expected="$(for name in "${sources[@]}"; do platform_images_of "$name"; done | sort)"
  [ -n "$expected" ] || fail "the pushed digests hold no platform image"

  if docker buildx imagetools inspect "${image}:${version}" >/dev/null 2>&1; then
    existing="$(platform_images_of "${image}:${version}")"
    [ "$existing" = "$expected" ] \
      || fail "${image}:${version} already exists and holds other images. A version tag never moves; a new build needs a new version."
    echo "${image}:${version} already holds these images; kept as it is." >&2
  else
    arguments+=(--tag "${image}:${version}")
    if [ -n "${DOCKER_METADATA_OUTPUT_JSON:-}" ]; then
      while IFS= read -r annotation; do
        if [ -n "$annotation" ]; then arguments+=(--annotation "$annotation"); fi
      done < <(jq -r '.annotations[]?' <<<"$DOCKER_METADATA_OUTPUT_JSON")
    fi
    docker buildx imagetools create "${arguments[@]}" "${sources[@]}" >&2
  fi

  docker buildx imagetools inspect "${image}:${version}" >&2
  digest="$(digest_of "${image}:${version}")"
  [[ "$digest" == sha256:* ]] || fail "could not read the digest of ${image}:${version}"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "digest=${digest}" >>"$GITHUB_OUTPUT"; fi
  echo "$digest"
}

alias_tags() {
  local image="$1" digest="$2" tag found
  shift 2
  for tag in "$@"; do
    docker buildx imagetools create --tag "${image}:${tag}" "${image}@${digest}" >&2
    found="$(digest_of "${image}:${tag}")"
    [ "$found" = "$digest" ] || fail "${image}:${tag} names ${found}, expected ${digest}"
    echo "${image}:${tag} -> ${digest}"
  done
}

case "${1:-}" in
  create)
    [ "$#" -eq 4 ] || fail "usage: release-image-index.sh create <image> <version> <digests-dir>"
    create "$2" "$3" "$4"
    ;;
  alias)
    [ "$#" -ge 3 ] || fail "usage: release-image-index.sh alias <image> <digest> <tag>..."
    shift
    alias_tags "$@"
    ;;
  *)
    fail "usage: release-image-index.sh (create <image> <version> <digests-dir> | alias <image> <digest> <tag>...)"
    ;;
esac

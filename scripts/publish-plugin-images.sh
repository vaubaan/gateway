#!/usr/bin/env bash
# Publishes the image of each plugin bundle under dist/plugins (written by
# scripts/build-plugin-bundle.mjs) as <prefix>/plugin-<id>:<version>, built from
# deploy/docker/plugin.Dockerfile for linux/amd64 and linux/arm64 (the image holds
# files only: no emulation). Run by .github/workflows/release.yml; ADR
# plugins-bundled-or-pinned-by-the-operator.
#
#   publish-plugin-images.sh <prefix> <source> <on-existing> [<id>...]
#
#   <prefix>        ghcr.io/<owner>
#   <source>        the repository URL, label org.opencontainers.image.source
#   <on-existing>   `skip` or `fail` when <prefix>/plugin-<id>:<version> already exists.
#                   A version tag never moves: a gateway release skips the plugins
#                   whose version is already published; a plugin release tag fails.
#   <id>...         the plugins to publish; default: every directory of dist/plugins
#
# Appends one line per plugin (image and digest, or why it was left) to
# $GITHUB_STEP_SUMMARY when set. Needs docker buildx, jq, and a registry login done
# by the caller.
set -euo pipefail
shopt -s inherit_errexit

[ "$#" -ge 3 ] || { echo "usage: $0 <prefix> <source> <skip|fail> [<id>...]" >&2; exit 2; }
prefix=$1
source=$2
on_existing=$3
shift 3
case "$on_existing" in skip | fail) ;; *) echo "on-existing: skip or fail" >&2; exit 2 ;; esac

ids=("$@")
if [ "${#ids[@]}" -eq 0 ]; then
  for dir in dist/plugins/*/; do ids+=("$(basename "$dir")"); done
fi
summary=${GITHUB_STEP_SUMMARY:-/dev/null}
metadata=$(mktemp -d)
trap 'rm -rf "$metadata"' EXIT

echo "### Plugin images" >>"$summary"
echo >>"$summary"
for id in "${ids[@]}"; do
  manifest="dist/plugins/${id}/package.json"
  [ -f "$manifest" ] || { echo "::error title=Plugin image not published::no bundle for ${id} (${manifest})" >&2; exit 1; }
  version=$(jq -er .version "$manifest")
  image="${prefix}/plugin-${id}"
  if docker buildx imagetools inspect "${image}:${version}" >/dev/null 2>&1; then
    if [ "$on_existing" = fail ]; then
      echo "::error title=Plugin image not published::${image}:${version} already exists; a version tag never moves" >&2
      exit 1
    fi
    echo "- \`${image}:${version}\` already published, left as is" >>"$summary"
    continue
  fi
  docker buildx build \
    --file deploy/docker/plugin.Dockerfile \
    --build-arg "PLUGIN=${id}" \
    --build-arg "VERSION=${version}" \
    --build-arg "SOURCE=${source}" \
    --platform linux/amd64,linux/arm64 \
    --provenance=mode=max \
    --sbom=true \
    --tag "${image}:${version}" \
    --metadata-file "${metadata}/${id}.json" \
    --push \
    .
  digest=$(jq -er '."containerimage.digest"' "${metadata}/${id}.json")
  echo "- \`${image}:${version}\` \`${digest}\`" >>"$summary"
  echo "published ${image}:${version} ${digest}"
done

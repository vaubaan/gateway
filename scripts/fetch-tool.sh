#!/usr/bin/env bash
# Downloads one pinned security tool and checks it against the SHA-256 written
# here before anything runs it. Used by the CI jobs `secrets` and `docker`
# (scripts/secret-scan.sh, scripts/image-scan.sh); usable locally the same way.
#
#   scripts/fetch-tool.sh <gitleaks|trivy|actionlint> <directory>
#
# Prints the path of the binary. A download whose checksum differs stops here:
# nothing from it is executed. The tools are fetched as release archives from
# their GitHub releases, never through a third-party action (the trivy-action
# and setup-trivy tags were hijacked in March 2026; an archive pinned by its
# hash cannot be swapped under us).
#
# Updating a tool (docs/workflow/coding-workflow.md, "Refreshing the security
# tools"): take a release at least a week old, read its checksums file, and
# change the version and the hashes together.
set -euo pipefail

tool=${1:?usage: scripts/fetch-tool.sh <gitleaks|trivy|actionlint> <directory>}
dir=${2:?usage: scripts/fetch-tool.sh <tool> <directory>}

case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "fetch-tool: unsupported architecture $(uname -m)" >&2; exit 2 ;;
esac

case "$tool/$arch" in
  gitleaks/x64)
    version=8.30.1
    url="https://github.com/gitleaks/gitleaks/releases/download/v${version}/gitleaks_${version}_linux_x64.tar.gz"
    sha256=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb ;;
  gitleaks/arm64)
    version=8.30.1
    url="https://github.com/gitleaks/gitleaks/releases/download/v${version}/gitleaks_${version}_linux_arm64.tar.gz"
    sha256=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080 ;;
  trivy/x64)
    version=0.75.0
    url="https://github.com/aquasecurity/trivy/releases/download/v${version}/trivy_${version}_Linux-64bit.tar.gz"
    sha256=c6e65abddb348e25f10549df887045629cf28cc72453cd1c63acb717316b3f3f ;;
  trivy/arm64)
    version=0.75.0
    url="https://github.com/aquasecurity/trivy/releases/download/v${version}/trivy_${version}_Linux-ARM64.tar.gz"
    sha256=a1ee9f6ffb7d112b64ff726a2a0717c21175c1114361391f4a132956751a13b3 ;;
  actionlint/x64)
    version=1.7.12
    url="https://github.com/rhysd/actionlint/releases/download/v${version}/actionlint_${version}_linux_amd64.tar.gz"
    sha256=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8 ;;
  *) echo "fetch-tool: no pinned build of $tool for $arch" >&2; exit 2 ;;
esac

mkdir -p "$dir"
archive="$dir/$tool-$version.tar.gz"
if [ ! -x "$dir/$tool" ]; then
  curl --fail --silent --show-error --location --retry 3 --proto '=https' --tlsv1.2 -o "$archive" "$url"
  if ! echo "$sha256  $archive" | sha256sum --check --status; then
    echo "fetch-tool: checksum mismatch for $url (expected $sha256); nothing was run" >&2
    rm -f "$archive"
    exit 1
  fi
  tar -xzf "$archive" -C "$dir" "$tool"
  rm -f "$archive"
fi
echo "$dir/$tool"

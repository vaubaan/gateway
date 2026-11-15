#!/usr/bin/env bash
# Static analysis of the repository with Semgrep (CI job `sast`; locally the
# same command). Usage:
#
#   scripts/sast.sh <semgrep-rules checkout> [extra semgrep arguments]
#
# The community rules are read from a checkout of github.com/semgrep/semgrep-rules
# at the commit ci.yml pins (SEMGREP_RULES_REF), never fetched from the registry
# at run time: a rule set that changes under us would fail an unrelated pull
# request. The custom rules of this codebase are .semgrep/vaubaan.yml; their
# test cases run first (`semgrep --test`), so a rule that stopped matching
# fails here rather than passing silently. Paths left out: .semgrepignore.
#
# Exit code: 0 clean, 1 findings, anything else a broken run.
set -euo pipefail

rules_repo=${1:?usage: scripts/sast.sh <semgrep-rules checkout> [semgrep arguments]}
shift

# The community rule folders that apply to this code: security rules for
# JavaScript/TypeScript, React, Node crypto, JWT/JOSE, sandboxes, MCP servers,
# and the Dockerfile.
folders=(
  javascript/lang/security
  javascript/audit
  javascript/node-crypto
  javascript/jose
  javascript/jsonwebtoken
  javascript/argon2
  javascript/sandbox
  javascript/vm2
  javascript/shelljs
  typescript/lang/security
  typescript/react/security
  typescript/mcp
  dockerfile/security
  dockerfile/correctness
)

# Rules left out, by file name, each with the reason (docs/workflow/coding-workflow.md,
# "Security checks"). Prefer an inline `nosemgrep` with its reason: a rule
# leaves this list only when it can only be wrong on this code base.
excluded=(
  # Flags every template string that contains `<`: error messages quoting
  # "<service>.<name>", and the two server-rendered documents, which build
  # their HTML from escapeHtml() (apps/gateway/src/server/http/document.ts).
  # The rest of the interface is React, which escapes by construction.
  html-in-template-string.yaml
)

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ruleset=$(mktemp -d)
trap 'rm -rf "$ruleset"' EXIT

for folder in "${folders[@]}"; do
  if [ ! -d "$rules_repo/$folder" ]; then
    echo "sast: $folder is missing from $rules_repo (was the pinned commit changed?)" >&2
    exit 2
  fi
  while IFS= read -r -d '' file; do
    name=$(basename "$file")
    skip=false
    for ex in "${excluded[@]}"; do [ "$name" = "$ex" ] && skip=true; done
    # Test targets and fixed versions sit next to the rules; only rules are copied.
    case "$name" in *.test.yaml | *.fixed.*) skip=true ;; esac
    if [ "$skip" = false ]; then
      mkdir -p "$ruleset/$(dirname "${file#"$rules_repo"/}")"
      cp "$file" "$ruleset/${file#"$rules_repo"/}"
    fi
  done < <(find "$rules_repo/$folder" -type f \( -name '*.yaml' -o -name '*.yml' \) -print0)
done

cd "$repo_root"
semgrep --test --metrics=off --config .semgrep/vaubaan.yml .semgrep/vaubaan.ts

semgrep scan \
  --metrics=off \
  --disable-version-check \
  --error \
  --config "$ruleset" \
  --config .semgrep/vaubaan.yml \
  "$@"

#!/usr/bin/env bash
# The GitHub settings of the project's repositories, as code: .github/settings/<repo>/.
#
#   scripts/github-settings.sh check [repo...]   # what differs between GitHub and the files
#   scripts/github-settings.sh apply [repo...]   # make GitHub match the files
#
# repo: gateway, gateway-plugins (both by default), under the organisation vaubaan.
# Needs `gh` signed in as an administrator of the repositories (`gh auth login`): most of
# these settings are not readable anonymously. `check` changes nothing and exits 1 on a
# difference. What GitHub keeps no API for (the organisation's two-factor requirement)
# is listed in docs/handbook/github-settings.md, with the manual procedure.
#
# Per repository folder:
#   ruleset-*.json      a repository ruleset, matched on GitHub by its `name`
#   main-protection.json  the classic protection of `main` (body of PUT .../protection)
#   repository.json     fields of PATCH /repos/{owner}/{repo}
#   security.json       vulnerability reporting, Dependabot alerts, secret scanning, the
#                       approval asked before a fork's pull request runs workflows
set -euo pipefail

OWNER=vaubaan
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.github/settings"
mode="${1:-}"
shift || true
[[ "$mode" == check || "$mode" == apply ]] || {
  echo "usage: scripts/github-settings.sh check|apply [repo...]" >&2
  exit 2
}
repos=("$@")
[[ ${#repos[@]} -gt 0 ]] || repos=(gateway gateway-plugins)

differences=0

# Prints the difference between the expected and the live JSON, both normalised by `jq -S`.
compare() {
  local what="$1" expected="$2" live="$3"
  local delta
  if delta="$(diff -u <(jq -S . <<<"$expected") <(jq -S . <<<"$live"))"; then
    echo "= $what"
  else
    echo "≠ $what (- the files, + GitHub)"
    sed '1,2d; s/^/    /' <<<"$delta"
    differences=$((differences + 1))
  fi
}

# A ruleset as the files write it: rules sorted, the fields GitHub adds dropped.
# GitHub answers every parameter of a rule, defaulted ones included: only those the file
# writes are compared.
# shellcheck disable=SC2016 # a jq program: $r, $k and $want are jq's variables, not the shell's
FILE_PARAMETERS_ONLY='.rules |= map(. as $r | if .parameters then .parameters |= with_entries(select(.key as $k | [$want.rules[] | select(.type == $r.type) | .parameters // {} | has($k)] | any)) else . end)'
NORMALISE_RULESET='{name, target, enforcement, bypass_actors: (.bypass_actors // [] | map({actor_id, actor_type, bypass_mode})), conditions, rules: (.rules | sort_by(.type))}'

ruleset() {
  local repo="$1" file="$2" name id live
  name="$(jq -r .name "$file")"
  id="$(gh api "repos/$OWNER/$repo/rulesets" --jq ".[] | select(.name == \"$name\") | .id")"
  if [[ "$mode" == apply ]]; then
    if [[ -n "$id" ]]; then
      gh api -X PUT "repos/$OWNER/$repo/rulesets/$id" --input "$file" >/dev/null
    else
      gh api -X POST "repos/$OWNER/$repo/rulesets" --input "$file" >/dev/null
    fi
    echo "→ $repo: ruleset \"$name\""
    return
  fi
  if [[ -z "$id" ]]; then
    echo "≠ $repo: ruleset \"$name\" missing"
    differences=$((differences + 1))
    return
  fi
  live="$(gh api "repos/$OWNER/$repo/rulesets/$id")"
  compare "$repo: ruleset \"$name\"" "$(jq "$NORMALISE_RULESET" "$file")" \
    "$(jq --argjson want "$(cat "$file")" "$NORMALISE_RULESET | $FILE_PARAMETERS_ONLY" <<<"$live")"
}

main_protection() {
  local repo="$1" file="$2" live
  if [[ "$mode" == apply ]]; then
    gh api -X PUT "repos/$OWNER/$repo/branches/main/protection" --input "$file" >/dev/null
    echo "→ $repo: protection of main"
    return
  fi
  live="$(gh api "repos/$OWNER/$repo/branches/main/protection" 2>/dev/null || echo '{}')"
  compare "$repo: protection of main" "$(cat "$file")" "$(jq '{
    required_status_checks: (.required_status_checks // null),
    enforce_admins: (.enforce_admins.enabled // false),
    required_pull_request_reviews: (.required_pull_request_reviews // null),
    restrictions: (.restrictions // null),
    required_linear_history: (.required_linear_history.enabled // false),
    allow_force_pushes: (.allow_force_pushes.enabled // false),
    allow_deletions: (.allow_deletions.enabled // false)}' <<<"$live")"
}

repository() {
  local repo="$1" file="$2" keys live
  if [[ "$mode" == apply ]]; then
    gh api -X PATCH "repos/$OWNER/$repo" --input "$file" >/dev/null
    echo "→ $repo: repository settings"
    return
  fi
  keys="$(jq -c 'keys' "$file")"
  live="$(gh api "repos/$OWNER/$repo" | jq --argjson k "$keys" 'with_entries(select(.key as $x | $k | index($x)))')"
  compare "$repo: repository settings" "$(cat "$file")" "$live"
}

# The answer of an endpoint that says yes with 204 and no with 404.
enabled_by_status() {
  gh api "$1" --silent >/dev/null 2>&1 && echo true || echo false
}

security() {
  local repo="$1" file="$2" base="repos/$OWNER/$1" live
  wanted() { jq -r ".$1" "$file"; }
  if [[ "$mode" == apply ]]; then
    local verb
    verb=$([[ "$(wanted private_vulnerability_reporting)" == true ]] && echo PUT || echo DELETE)
    gh api -X "$verb" "$base/private-vulnerability-reporting" --silent
    verb=$([[ "$(wanted dependabot_alerts)" == true ]] && echo PUT || echo DELETE)
    gh api -X "$verb" "$base/vulnerability-alerts" --silent
    jq '{security_and_analysis: {
          secret_scanning: {status: (if .secret_scanning then "enabled" else "disabled" end)},
          secret_scanning_push_protection: {status: (if .secret_scanning_push_protection then "enabled" else "disabled" end)}}}' \
      "$file" | gh api -X PATCH "$base" --input - >/dev/null
    gh api -X PUT "$base/actions/permissions/fork-pr-contributor-approval" \
      -f approval_policy="$(wanted fork_pr_approval)" --silent
    echo "→ $repo: security"
    return
  fi
  local analysis
  analysis="$(gh api "$base" --jq '.security_and_analysis')"
  live="$(jq -n \
    --argjson pvr "$(gh api "$base/private-vulnerability-reporting" --jq .enabled)" \
    --argjson alerts "$(enabled_by_status "$base/vulnerability-alerts")" \
    --argjson analysis "$analysis" \
    --arg fork "$(gh api "$base/actions/permissions/fork-pr-contributor-approval" --jq .approval_policy)" \
    '{private_vulnerability_reporting: $pvr, dependabot_alerts: $alerts,
      secret_scanning: ($analysis.secret_scanning.status == "enabled"),
      secret_scanning_push_protection: ($analysis.secret_scanning_push_protection.status == "enabled"),
      fork_pr_approval: $fork}')"
  compare "$repo: security" "$(cat "$file")" "$live"
}

for repo in "${repos[@]}"; do
  dir="$ROOT/$repo"
  [[ -d "$dir" ]] || {
    echo "no settings for $repo under .github/settings/" >&2
    exit 2
  }
  for file in "$dir"/ruleset-*.json; do
    [[ -e "$file" ]] && ruleset "$repo" "$file"
  done
  [[ -e "$dir/main-protection.json" ]] && main_protection "$repo" "$dir/main-protection.json"
  [[ -e "$dir/repository.json" ]] && repository "$repo" "$dir/repository.json"
  [[ -e "$dir/security.json" ]] && security "$repo" "$dir/security.json"
done

if [[ "$mode" == check && $differences -gt 0 ]]; then
  echo "$differences setting(s) differ from .github/settings/: scripts/github-settings.sh apply" >&2
  exit 1
fi

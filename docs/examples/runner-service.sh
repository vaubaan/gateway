#!/usr/bin/env bash
# =============================================================================
# Vaubaan runner — annotated bash example for the bash provider.
#
# Each `# @vaubaan` block above a function declares the capability the gateway
# requires before invoking it. Functions without an annotation are private
# helpers and never exposed as MCP tools.
#
# Post-refactor format (PRs #23 + #24 + #25) :
#   - Provider is `bash` (was `ssh` / per-script `runner`).
#   - Plane is `host` (was `service`). The bash provider has a single plane,
#     so capability notation uses the SHORT form (no `plane/` segment).
#   - The binding *is* the script — no `@vaubaan-service:` / `@vaubaan-description:`
#     header line ; the binding's slug + display_name carry that identity.
#
# Capability notation produced by the parser :
#   bash:<ring>:<action>@<host_slug>
#
# For this file :
#   bash:process:read@<host>   — status, alive checks
#   bash:logs:read@<host>      — journald output
#   bash:process:write@<host>  — start/stop/restart
#   bash:binary:write@<host>   — replace the runner binary
#
# `host` is the single registered default plane (cf.
# `packages/shared/src/capability.ts:DEFAULT_PLANE`) → the short form drops it.
# The long form `bash:host/process:read@<host>` is also accepted by the parser
# but `formatCapability` prefers the short form on display.
# =============================================================================

# @vaubaan-plane: host
# @vaubaan-rings: process binary logs

# ───── ring 1 / process ───────────────────────────────────────────────────────

# @vaubaan: ring=process action=read
# @vaubaan-doc: systemctl status of the runner daemon (one-shot, no pager).
runner_status() {
  systemctl status vaubaan-runner.service --no-pager
}

# @vaubaan: ring=process action=write
# @vaubaan-doc: Stop the runner daemon.
runner_stop() {
  sudo systemctl stop vaubaan-runner.service
}

# @vaubaan: ring=process action=write
# @vaubaan-doc: Start the runner daemon.
runner_start() {
  sudo systemctl start vaubaan-runner.service
}

# @vaubaan: ring=process action=write
# @vaubaan-doc: Restart the runner daemon (stop + start).
runner_restart() {
  sudo systemctl restart vaubaan-runner.service
}

# ───── ring 1 / logs ──────────────────────────────────────────────────────────

# @vaubaan: ring=logs action=read
# @vaubaan-doc: Tail the runner's journald log (default 200 lines).
# @vaubaan-arg: lines integer optional default=200
runner_logs() {
  local lines="${1:-200}"
  journalctl -u vaubaan-runner.service -n "$lines" --no-pager
}

# ───── ring 2 / binary ────────────────────────────────────────────────────────

# @vaubaan: ring=binary action=write
# @vaubaan-doc: Replace the runner binary with a specific GitHub release and restart.
# @vaubaan-arg: version string required
runner_update() {
  local version="$1"
  [ -z "$version" ] && { echo "version required" >&2; return 1; }

  local url="https://github.com/sbw-vaubaan/runner/releases/download/${version}/runner.tar.gz"
  echo "▸ fetching $url"
  curl -sSLf "$url" | sudo tar xz -C /opt/vaubaan-runner
  echo "▸ restarting"
  sudo systemctl restart vaubaan-runner.service
  echo "▸ done — runner is now at $version"
}

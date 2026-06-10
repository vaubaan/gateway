-- =============================================================================
-- 0020_bash_provider.sql
--
-- Pivot : the SSH provider becomes the BASH provider. SSH is a transport ;
-- what we expose is the bash dispatcher driven by an annotated script
-- attached to each binding.
--
-- Schema change : keep the existing `ssh_bindings` table (renaming would
-- touch every reference and bring no value — the name is internal) but add
-- the new columns :
--
--   bash_content  — the annotated bash script (nullable until the operator
--                   provides one ; a binding without a script is a dormant
--                   endpoint that still works for the legacy /test smoke).
--   parsed_meta   — cache of the parser output (rings, tools, args). Will
--                   be backfilled by a post-migration Node sweep ; the API
--                   keeps it in sync on every write.
--   parse_error   — set when the file is structurally invalid so the UI
--                   can render a friendly error without re-parsing.
--
-- Backfill : the two existing bindings (vaubaan project, runner hosts) get
-- the runner-service.sh content embedded below. parsed_meta is left NULL
-- and populated by a small Node script run after this migration applies.
--
-- Drop : the short-lived runner_services table introduced in 0019. It was
-- the wrong abstraction — the binding IS the service. No data loss : it
-- was empty (never reached prod UI usage between the 2 PRs).
-- =============================================================================

alter table ssh_bindings
  add column if not exists bash_content text,
  add column if not exists parsed_meta jsonb,
  add column if not exists parse_error text;

-- Backfill every existing binding with the runner service script. Single
-- statement, applies to all rows ; the script body lives between $bash$
-- delimiters to keep PostgreSQL parser happy with the embedded $1, ${1:-N}
-- and other shell syntax.
update ssh_bindings
set bash_content = $bash$#!/usr/bin/env bash
# Vaubaan runner — annotated bash for the bash provider.
# Each `# @vaubaan` block above a function declares the capability the gateway
# requires before invoking it. Functions without an annotation are private
# helpers and never exposed as MCP tools.
#
# Capabilities produced :
#   bash:process:read@<host_slug>   — status, alive checks
#   bash:logs:read@<host_slug>      — journald output
#   bash:process:write@<host_slug>  — start/stop/restart
#   bash:binary:write@<host_slug>   — replace the runner binary

# @vaubaan-plane: host
# @vaubaan-rings: process binary logs

# @vaubaan: ring=process action=read
# @vaubaan-doc: systemctl status of the runner daemon.
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

# @vaubaan: ring=logs action=read
# @vaubaan-doc: Tail the runner's journald log (default 200 lines).
# @vaubaan-arg: lines integer optional default=200
runner_logs() {
  local lines="${1:-200}"
  journalctl -u vaubaan-runner.service -n "$lines" --no-pager
}

# @vaubaan: ring=binary action=write
# @vaubaan-doc: Replace the runner binary with a specific GitHub release and restart.
# @vaubaan-arg: version string required
runner_update() {
  local version="$1"
  [ -z "$version" ] && { echo "version required" >&2; return 1; }
  curl -sSLf "https://github.com/sbw-vaubaan/runner/releases/download/${version}/runner.tar.gz" \
    | sudo tar xz -C /opt/vaubaan-runner
  sudo systemctl restart vaubaan-runner.service
}
$bash$
where bash_content is null;

-- Drop the short-lived runner_services table from 0019.
drop table if exists runner_services;

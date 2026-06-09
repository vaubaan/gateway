/**
 * Starter template offered when creating a new service. Mirrors
 * docs/examples/runner-service.sh — kept in code so the client component
 * (form) can prefill the textarea without a server round-trip.
 */
export const RUNNER_TEMPLATE = `#!/usr/bin/env bash
# @vaubaan-service: runner
# @vaubaan-description: Manage the Vaubaan runner daemon over SSH.
# @vaubaan-plane: service
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
# @vaubaan-doc: Tail the runner's journald log.
# @vaubaan-arg: lines integer optional default=200
runner_logs() {
  local lines="\${1:-200}"
  journalctl -u vaubaan-runner.service -n "$lines" --no-pager
}

# @vaubaan: ring=binary action=write
# @vaubaan-doc: Replace the runner binary with a specific GitHub release and restart.
# @vaubaan-arg: version string required
runner_update() {
  local version="$1"
  [ -z "$version" ] && { echo "version required" >&2; return 1; }
  curl -sSLf "https://github.com/sbw-vaubaan/runner/releases/download/\${version}/runner.tar.gz" \\
    | sudo tar xz -C /opt/vaubaan-runner
  sudo systemctl restart vaubaan-runner.service
}
`;

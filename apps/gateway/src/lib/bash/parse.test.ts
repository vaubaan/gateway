import { describe, expect, test } from 'vitest';
import { parseAnnotatedBash } from './parse';

const RUNNER_SH = `#!/usr/bin/env bash
# @vaubaan-plane: host
# @vaubaan-rings: process binary logs

# @vaubaan: ring=process action=read
# @vaubaan-doc: systemctl status of the runner.
runner_status() {
  systemctl status vaubaan-runner.service --no-pager
}

# @vaubaan: ring=logs action=read
# @vaubaan-doc: Tail the runner's journald log.
# @vaubaan-arg: lines integer optional default=200
runner_logs() {
  journalctl -u vaubaan-runner.service -n "\${1:-200}" --no-pager
}

# @vaubaan: ring=process action=write
# @vaubaan-doc: Stop the runner daemon.
runner_stop() {
  sudo systemctl stop vaubaan-runner.service
}

# @vaubaan: ring=binary action=write
# @vaubaan-doc: Replace the binary then restart.
# @vaubaan-arg: version string required
runner_update() {
  local version="$1"
  echo "updating to $version"
}

# Private helper — no annotation.
_log() {
  echo "[$(date)] $1"
}
`;

describe('parseAnnotatedBash', () => {
  test('parses script-level annotations', () => {
    const svc = parseAnnotatedBash(RUNNER_SH);
    expect(svc.plane).toBe('host');
    expect(svc.rings).toEqual(['process', 'binary', 'logs']);
  });

  test('defaults plane to "host" when @vaubaan-plane omitted', () => {
    const svc = parseAnnotatedBash(`# @vaubaan-rings: a\n# @vaubaan: ring=a action=read\nx() {}\n`);
    expect(svc.plane).toBe('host');
  });

  test('extracts annotated tools in source order', () => {
    const svc = parseAnnotatedBash(RUNNER_SH);
    const names = svc.tools.map((t) => t.functionName);
    expect(names).toEqual(['runner_status', 'runner_logs', 'runner_stop', 'runner_update']);
  });

  test('maps ring + action correctly', () => {
    const svc = parseAnnotatedBash(RUNNER_SH);
    const byName = Object.fromEntries(svc.tools.map((t) => [t.functionName, t]));
    expect(byName.runner_status).toMatchObject({ ring: 'process', action: 'read' });
    expect(byName.runner_logs).toMatchObject({ ring: 'logs', action: 'read' });
    expect(byName.runner_stop).toMatchObject({ ring: 'process', action: 'write' });
    expect(byName.runner_update).toMatchObject({ ring: 'binary', action: 'write' });
  });

  test('parses args with type/required/default', () => {
    const svc = parseAnnotatedBash(RUNNER_SH);
    const logs = svc.tools.find((t) => t.functionName === 'runner_logs')!;
    expect(logs.args).toEqual([
      { name: 'lines', type: 'integer', required: false, defaultValue: '200' },
    ]);
    const update = svc.tools.find((t) => t.functionName === 'runner_update')!;
    expect(update.args).toEqual([{ name: 'version', type: 'string', required: true }]);
  });

  test('skips functions without annotations (private helpers)', () => {
    const svc = parseAnnotatedBash(RUNNER_SH);
    expect(svc.tools.find((t) => t.functionName === '_log')).toBeUndefined();
  });

  test('ignores @vaubaan-service: directives (legacy, harmless)', () => {
    const svc = parseAnnotatedBash(
      `# @vaubaan-service: ignored\n# @vaubaan-rings: a\n# @vaubaan: ring=a action=read\nx() {}\n`,
    );
    expect(svc.rings).toEqual(['a']);
    expect(svc.tools).toHaveLength(1);
  });

  test('rejects missing @vaubaan-rings', () => {
    expect(() => parseAnnotatedBash(`# @vaubaan: ring=a action=read\nx() {}\n`)).toThrow(
      /missing.*@vaubaan-rings/,
    );
  });

  test('rejects tool whose ring is not declared in @vaubaan-rings', () => {
    expect(() =>
      parseAnnotatedBash(`# @vaubaan-rings: a\n# @vaubaan: ring=z action=read\nx() {}\n`),
    ).toThrow(/isn't in @vaubaan-rings/);
  });

  test('rejects invalid action', () => {
    expect(() =>
      parseAnnotatedBash(`# @vaubaan-rings: a\n# @vaubaan: ring=a action=delete\nx() {}\n`),
    ).toThrow(/action must be/);
  });

  test('rejects empty tool list', () => {
    expect(() => parseAnnotatedBash(`# @vaubaan-rings: a\nx() {}\n`)).toThrow(
      /no annotated tool functions/,
    );
  });
});

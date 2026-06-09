import { describe, expect, test } from 'vitest';
import { buildToolInvocation } from './exec';

describe('buildToolInvocation', () => {
  test('builds a base64-piped bash invocation with no args', () => {
    const { cmd } = buildToolInvocation('runner_status() { echo ok; }', 'runner_status', []);
    expect(cmd).toMatch(/^echo '[A-Za-z0-9+/=]+' \| base64 -d \| bash -s --$/);
  });

  test('appends single-quoted args', () => {
    const { cmd } = buildToolInvocation('f() { echo $1 $2; }', 'f', ['v1.2.3', 'prod']);
    expect(cmd).toMatch(/bash -s -- 'v1\.2\.3' 'prod'$/);
  });

  test('escapes embedded single quotes in args (POSIX-safe)', () => {
    const { cmd } = buildToolInvocation('f() { echo $1; }', 'f', ["it's"]);
    expect(cmd).toMatch(/bash -s -- 'it'\\''s'$/);
  });

  test('round-trips a script through base64', () => {
    const script = 'echo "hello\nworld"';
    const { cmd } = buildToolInvocation(script, 'noop', []);
    const b64 = /^echo '([A-Za-z0-9+/=]+)'/.exec(cmd)?.[1] ?? '';
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    expect(decoded).toContain(script);
    expect(decoded).toContain('noop "$@"');
  });
});

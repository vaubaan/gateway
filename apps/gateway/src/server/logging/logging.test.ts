import { describe, expect, it } from 'vitest';

import type { LogLevel } from '../config/types';
import { createLogger } from './logger';
import { createRedactor, REDACTED } from './redact';

const TOKEN = 'vbn_live_Ab12Cd34_' + 'x'.repeat(32);

describe('createRedactor', () => {
  it('keeps the prefix of a mission token and drops its secret', () => {
    const redact = createRedactor([]);
    expect(redact(`bearer ${TOKEN} refused`)).toBe(`bearer vbn_live_Ab12Cd34_${REDACTED} refused`);
    expect(redact('vbn_test_Zz99Yy88_' + 'q'.repeat(32))).toBe(`vbn_test_Zz99Yy88_${REDACTED}`);
  });

  it('replaces every configured secret, longest first, also when JSON-escaped', () => {
    const pem = '-----BEGIN KEY-----\nabc\n-----END KEY-----';
    const redact = createRedactor(['abc', pem, 'client-secret-1']);
    expect(redact(JSON.stringify({ k: pem, s: 'client-secret-1', ok: 'visible' }))).toBe(
      JSON.stringify({ k: REDACTED, s: REDACTED, ok: 'visible' }),
    );
  });

  it('ignores empty secrets and leaves other text untouched', () => {
    const redact = createRedactor(['', 'zzz']);
    expect(redact('nothing to hide')).toBe('nothing to hide');
  });
});

describe('createLogger', () => {
  function capture(level: LogLevel = 'info') {
    const lines: Array<{ level: LogLevel; line: string }> = [];
    const logger = createLogger({
      level,
      redact: createRedactor(['s3cret']),
      write: (lvl, line) => lines.push({ level: lvl, line }),
      now: () => new Date('2026-10-13T12:00:00.000Z'),
    });
    return { logger, lines };
  }

  it('writes one redacted JSON line per call with bindings and fields', () => {
    const { logger, lines } = capture();
    logger.child({ component: 'test' }).info('hello', { token: TOKEN, secret: 's3cret' });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!.line)).toEqual({
      time: '2026-10-13T12:00:00.000Z',
      level: 'info',
      msg: 'hello',
      component: 'test',
      token: `vbn_live_Ab12Cd34_${REDACTED}`,
      secret: REDACTED,
    });
    expect(lines[0]!.line.endsWith('\n')).toBe(true);
  });

  it('honours the threshold and routes errors separately', () => {
    const { logger, lines } = capture('warn');
    logger.debug('no');
    logger.info('no');
    logger.warn('yes');
    logger.error('boom', { err: new Error('kaboom') });
    expect(lines.map((l) => l.level)).toEqual(['warn', 'error']);
    const parsed = JSON.parse(lines[1]!.line) as { err: { name: string; message: string } };
    expect(parsed.err).toMatchObject({ name: 'Error', message: 'kaboom' });
  });
});

/**
 * The guards the host asks instead of `instanceof` (ADR
 * plugins-bundled-or-pinned-by-the-operator): an error made by another copy of
 * the SDK — the one a pinned plugin carries — is recognised by its brand, and
 * a look-alike without the brand is not.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CredentialRefusal,
  ExecutorRefusal,
  isCredentialRefusal,
  isExecutorRefusal,
  isUpstreamAuthError,
  isUpstreamHttpError,
  isUpstreamProtocolError,
  SDK_VERSION,
  UpstreamAnswerTooLarge,
  UpstreamAuthError,
  UpstreamHttpError,
  UpstreamProtocolError,
} from '../../src/index.ts';
import {
  GitProtocolError,
  isGitProtocolError,
  isPktLineError,
  PktLineError,
} from '../../src/git/index.ts';

/** What another copy of the SDK makes: a plain error carrying the brands of its classes. */
function fromAnotherCopy(classNames: readonly string[], fields: Record<string, unknown>): Error {
  const error = Object.assign(new Error('from another copy'), fields);
  for (const name of classNames) {
    Object.defineProperty(error, Symbol.for(`@vaubaan/plugin-sdk/${name}`), { value: true });
  }
  return error;
}

describe('error brands', () => {
  it('recognise the instances of this copy, subclasses included', () => {
    expect(isUpstreamAuthError(new UpstreamAuthError('no', 401))).toBe(true);
    expect(isUpstreamAuthError(new CredentialRefusal('no scope'))).toBe(true);
    expect(isCredentialRefusal(new CredentialRefusal('no scope'))).toBe(true);
    expect(isCredentialRefusal(new UpstreamAuthError('no', 401))).toBe(false);
    expect(isUpstreamHttpError(new UpstreamHttpError('gone', 404))).toBe(true);
    expect(isUpstreamHttpError(new UpstreamProtocolError('bad frame'))).toBe(true);
    expect(isUpstreamProtocolError(new UpstreamAnswerTooLarge('list', 10))).toBe(true);
    expect(isUpstreamProtocolError(new UpstreamHttpError('gone', 404))).toBe(false);
    expect(isExecutorRefusal(new ExecutorRefusal('outside the mission'))).toBe(true);
    expect(isGitProtocolError(new GitProtocolError('bad'))).toBe(true);
    expect(isPktLineError(new PktLineError('bad'))).toBe(true);
  });

  it('recognise an error of another copy of the SDK, which instanceof does not', () => {
    const auth = fromAnotherCopy(['UpstreamAuthError'], { upstreamStatus: 403 });
    expect(auth instanceof UpstreamAuthError).toBe(false);
    expect(isUpstreamAuthError(auth)).toBe(true);
    expect(isUpstreamAuthError(auth) && auth.upstreamStatus).toBe(403);
    const refusal = fromAnotherCopy(['UpstreamAuthError', 'CredentialRefusal'], {
      upstreamStatus: 401,
    });
    expect(isCredentialRefusal(refusal)).toBe(true);
    const protocol = fromAnotherCopy(['UpstreamHttpError', 'UpstreamProtocolError'], {
      status: 502,
    });
    expect(isUpstreamHttpError(protocol)).toBe(true);
    expect(isUpstreamProtocolError(protocol)).toBe(true);
    expect(isExecutorRefusal(fromAnotherCopy(['ExecutorRefusal'], {}))).toBe(true);
    expect(isGitProtocolError(fromAnotherCopy(['GitProtocolError'], {}))).toBe(true);
    expect(isPktLineError(fromAnotherCopy(['PktLineError'], {}))).toBe(true);
  });

  it('refuse a look-alike: no brand, or the brand without the fields the host reads', () => {
    const lookAlike = Object.assign(new Error('x'), {
      name: 'UpstreamAuthError',
      upstreamStatus: 401,
    });
    expect(isUpstreamAuthError(lookAlike)).toBe(false);
    expect(isUpstreamAuthError(fromAnotherCopy(['UpstreamAuthError'], {}))).toBe(false);
    expect(isUpstreamHttpError(fromAnotherCopy(['UpstreamHttpError'], { status: '502' }))).toBe(
      false,
    );
    for (const value of [null, undefined, 'UpstreamAuthError', 401, {}]) {
      expect(isUpstreamAuthError(value)).toBe(false);
    }
  });

  it('keep the brand out of what is serialised', () => {
    const error = new UpstreamAuthError('no', 401);
    expect(Object.keys(error)).not.toContain(Symbol.for('@vaubaan/plugin-sdk/UpstreamAuthError'));
    expect(JSON.stringify({ ...error })).toBe('{"upstreamStatus":401,"name":"UpstreamAuthError"}');
  });
});

describe('SDK_VERSION', () => {
  it('is the version of packages/plugin-sdk/package.json', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const manifest = JSON.parse(readFileSync(resolve(here, '../../package.json'), 'utf8')) as {
      version: string;
    };
    expect(SDK_VERSION).toBe(manifest.version);
  });
});

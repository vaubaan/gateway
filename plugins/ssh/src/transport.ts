/**
 * SSH transport of the `ssh` provider : one command, one connection, over
 * `ssh2`, with the host key verified against the pinned fingerprint.
 *
 * Spec : docs/spec/vaubaan-gateway.md §2.4 (the credential is used for one
 *        call and never returned), §6.
 *
 * The transport is an interface so `execute` and `discoverResources` can be
 * tested without a network : `createSshPlugin({ transport })` takes a fake.
 * `ssh2Transport` is the real one. Rules :
 *   - a target without a well-formed `SHA256:` pin is refused before any
 *     socket is opened (`SshHostKeyNotPinnedError`) ;
 *   - the host key is checked **before** authentication : a mismatch ends the
 *     handshake and surfaces as `SshHostKeyMismatchError`, never as a retry ;
 *   - an authentication failure is an `UpstreamAuthError` (the host marks the
 *     account `expired` ; the owner reconnects with a new key pair) ;
 *   - a timeout, an unreachable host or a reset is a plain `Error` with an
 *     operator-readable message ;
 *   - stdout is capped at `MAX_STDOUT_BYTES`, stderr at `MAX_STDERR_BYTES` ;
 *   - the caller's `AbortSignal` destroys the connection.
 */

import { Client } from 'ssh2';

import { UpstreamAuthError, type PluginLogger } from '@vaubaan/plugin-sdk';

import {
  fingerprintOf,
  hostKeyMatches,
  normalizeFingerprint,
  type SshTarget,
} from './credential.ts';

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exit_code: number;
  readonly duration_ms: number;
  readonly truncated: boolean;
}

export interface SshExecOptions {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly logger?: PluginLogger;
}

export interface SshTransport {
  exec(target: SshTarget, cmd: string, options: SshExecOptions): Promise<ExecResult>;
}

export const MAX_STDOUT_BYTES = 1024 * 1024;
export const MAX_STDERR_BYTES = 4096;
/** Handshake budget, bounded by the command timeout. */
export const MAX_READY_TIMEOUT_MS = 10_000;

/** The host presented a key other than the one pinned in the credential. */
export class SshHostKeyMismatchError extends Error {
  constructor(
    readonly host: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `ssh host '${host}' presented host key ${actual}, the account pins ${expected} — refusing. ` +
        'If the host was legitimately re-keyed, the owner must update the account.',
    );
    this.name = 'SshHostKeyMismatchError';
  }
}

/** The target carries no usable pin : nothing is sent to the host, not even a TCP connection. */
export class SshHostKeyNotPinnedError extends Error {
  constructor(readonly host: string) {
    super(
      `ssh host '${host}' has no pinned 'SHA256:…' host key fingerprint — refusing to connect. ` +
        'The owner must reconnect the host with its fingerprint.',
    );
    this.name = 'SshHostKeyNotPinnedError';
  }
}

interface Ssh2Error extends Error {
  readonly level?: string;
  readonly code?: string;
}

function humanizeConnError(err: Ssh2Error, target: SshTarget): Error {
  const msg = err.message ?? '';
  if (err.level === 'client-authentication' || /authentication/i.test(msg)) {
    return new UpstreamAuthError(
      `ssh authentication failed on ${target.user}@${target.host}:${target.port} — the public key is not in authorized_keys, or the account is locked.`,
      401,
    );
  }
  if (msg.includes('ECONNREFUSED') || msg.includes('ECONNRESET')) {
    return new Error(
      `ssh connection to ${target.host}:${target.port} refused — host unreachable or no SSH daemon on that port.`,
    );
  }
  if (msg.includes('ETIMEDOUT') || /timed out/i.test(msg)) {
    return new Error(`ssh connection to ${target.host}:${target.port} timed out.`);
  }
  if (msg.includes('ENOTFOUND') || msg.includes('EAI_AGAIN')) {
    return new Error(`ssh host '${target.host}' cannot be resolved.`);
  }
  return err;
}

/** The real transport : one `ssh2` client per command. */
export const ssh2Transport: SshTransport = {
  exec(target, cmd, options) {
    // `sshTarget()` never builds an unpinned target ; this guards any other caller.
    if (normalizeFingerprint(target.hostKeyFingerprint) === null) {
      return Promise.reject(new SshHostKeyNotPinnedError(target.host));
    }
    const start = Date.now();
    return new Promise<ExecResult>((resolve, reject) => {
      const conn = new Client();
      let stdout = '';
      let stderr = '';
      let truncated = false;
      let settled = false;
      let hostKeyMismatch: SshHostKeyMismatchError | null = null;

      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        fn();
      };
      const fail = (err: Error): void => {
        finish(() => {
          conn.destroy();
          reject(err);
        });
      };
      const onAbort = (): void => fail(new Error('ssh command aborted by the gateway.'));

      const timer = setTimeout(
        () =>
          fail(new Error(`ssh command timed out after ${Math.round(options.timeoutMs / 1000)}s.`)),
        options.timeoutMs,
      );
      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      options.signal?.addEventListener('abort', onAbort, { once: true });

      conn.on('ready', () => {
        conn.exec(cmd, (err, stream) => {
          if (err) {
            fail(humanizeConnError(err, target));
            return;
          }
          stream.on('data', (chunk: Buffer) => {
            if (stdout.length >= MAX_STDOUT_BYTES) {
              truncated = true;
              return;
            }
            stdout += chunk.toString('utf8');
            if (stdout.length > MAX_STDOUT_BYTES) {
              truncated = true;
              stdout = `${stdout.slice(0, MAX_STDOUT_BYTES)}\n[…truncated]`;
            }
          });
          stream.stderr.on('data', (chunk: Buffer) => {
            if (stderr.length < MAX_STDERR_BYTES) {
              stderr = (stderr + chunk.toString('utf8')).slice(0, MAX_STDERR_BYTES);
            }
          });
          stream.on('close', (code: number | null) => {
            finish(() => {
              conn.end();
              resolve({
                stdout,
                stderr,
                exit_code: typeof code === 'number' ? code : -1,
                duration_ms: Date.now() - start,
                truncated,
              });
            });
          });
        });
      });

      conn.on('error', (err: Ssh2Error) => {
        if (hostKeyMismatch) {
          fail(hostKeyMismatch);
          return;
        }
        fail(humanizeConnError(err, target));
      });

      conn.connect({
        host: target.host,
        port: target.port,
        username: target.user,
        privateKey: target.privateKeyPem,
        readyTimeout: Math.min(options.timeoutMs, MAX_READY_TIMEOUT_MS),
        hostVerifier: (key: Buffer): boolean => {
          if (hostKeyMatches(target.hostKeyFingerprint, key)) return true;
          hostKeyMismatch = new SshHostKeyMismatchError(
            target.host,
            target.hostKeyFingerprint,
            fingerprintOf(key),
          );
          options.logger?.error('ssh host key mismatch', {
            host: target.host,
            expected: target.hostKeyFingerprint,
            actual: hostKeyMismatch.actual,
          });
          return false;
        },
      });
    });
  },
};

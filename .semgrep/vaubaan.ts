// Test cases of the rules in vaubaan.yml: `semgrep --test .semgrep/`.
// Not compiled, not linted (eslint.config.js ignores .semgrep/). Every rule
// has at least one case it must report (`ruleid:`) and one it must not (`ok:`).
/* eslint-disable */
// @ts-nocheck
import { createHash, createCipheriv, randomBytes } from 'node:crypto';
// ruleid: vaubaan-child-process-outside-allowed-modules
import { execFile } from 'node:child_process';
// ruleid: vaubaan-no-dynamic-code
import { runInNewContext } from 'node:vm';

export function dynamic(source: string): unknown {
  // ruleid: vaubaan-no-dynamic-code
  eval(source);
  // ruleid: vaubaan-no-dynamic-code
  return new Function('x', source);
}

export function child(): void {
  // ruleid: vaubaan-child-process-outside-allowed-modules
  const cp = require('child_process');
}

export function encryption(key: Buffer): void {
  // ruleid: vaubaan-encryption-only-in-the-crypto-module
  createCipheriv('aes-256-gcm', key, randomBytes(12));
  // ok: vaubaan-encryption-only-in-the-crypto-module
  createHash('sha256').update('x').digest('hex');
  // ruleid: vaubaan-weak-hash
  createHash('md5');
  // ruleid: vaubaan-weak-hash
  crypto.createHash('sha1');
}

export function logging(logger: Logger, token: IssuedToken, accessToken: string): void {
  // ruleid: vaubaan-secret-bearing-value-logged
  logger.info('token issued', { access_token: accessToken });
  // ruleid: vaubaan-secret-bearing-value-logged
  logger.info('token issued', { accessToken });
  // ruleid: vaubaan-secret-bearing-value-logged
  console.log(`issued ${accessToken}`);
  // ruleid: vaubaan-secret-bearing-value-logged
  this.deps.logger.warn('refresh failed', { refresh_token: token.value });
  // ok: vaubaan-secret-bearing-value-logged
  logger.info('mission token rotated', { mission_id: 'm', token_prefix: token.prefix });
  // ok: vaubaan-secret-bearing-value-logged
  logger.warn('user deactivated', { member_tokens_revoked: 3, token_kind: 'member' });
}

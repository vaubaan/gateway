/**
 * One source for the gateway version: the root `package.json`.
 *
 * `next.config.ts` freezes it into the bundle, `build-info.ts` reads that
 * stamp, and `/healthz`, the UI footer, the MCP server info and the telemetry
 * `gateway_version` all take it from there. This file checks the ends that no
 * type links: what the build stamps is the manifest's version, and that
 * version is one telemetry and the release scripts accept.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { REPORT_FIELD_PATTERNS } from '@vaubaan/telemetry';
import { describe, expect, it } from 'vitest';

import nextConfig from '../../../next.config';

const REPOSITORY_ROOT = resolve(__dirname, '../../../../..');

function versionOf(manifestPath: string): unknown {
  const manifest: unknown = JSON.parse(
    readFileSync(resolve(REPOSITORY_ROOT, manifestPath), 'utf8'),
  );
  return typeof manifest === 'object' && manifest !== null && 'version' in manifest
    ? manifest.version
    : undefined;
}

describe('gateway version', () => {
  const rootVersion = versionOf('package.json');

  it('is stamped into the build from the root package.json', () => {
    expect(typeof rootVersion).toBe('string');
    expect(nextConfig.env?.NEXT_PUBLIC_GATEWAY_VERSION).toBe(rootVersion);
  });

  it('is a version telemetry reports as gateway_version', () => {
    expect(String(rootVersion)).toMatch(REPORT_FIELD_PATTERNS.version);
  });

  it('is a version the release scripts accept (final, or alpha / beta / rc with a number)', () => {
    expect(String(rootVersion)).toMatch(/^\d+\.\d+\.\d+(-(alpha|beta|rc)\.\d+)?$/);
  });

  it('has the same value in the lockfile', () => {
    expect(versionOf('package-lock.json')).toBe(rootVersion);
  });
});

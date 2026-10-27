/**
 * The release image is what Confidential Space measures and what an operator
 * may not change: these properties of apps/oauth-broker/Dockerfile hold the
 * trust model (spec oauth-broker §4), so a change to them fails here first.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dockerfile = readFileSync(resolve(APP, 'Dockerfile'), 'utf8');
const gatewayDockerfile = readFileSync(resolve(APP, '../../deploy/docker/Dockerfile'), 'utf8');
const PINNED = /^node:\d+\.\d+\.\d+-bookworm-slim@sha256:[0-9a-f]{64}$/;

function labels(): Map<string, string> {
  return new Map(
    [...dockerfile.matchAll(/"([^"]+)"="([^"]*)"/g)].map((m): [string, string] => [
      m[1] ?? '',
      m[2] ?? '',
    ]),
  );
}

describe('the broker image', () => {
  it('starts from one base pinned by version and digest, the gateway’s, and pulls no frontend', () => {
    const froms = [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1]);
    expect(froms).toHaveLength(1);
    expect(froms[0]).toMatch(PINNED);
    expect(gatewayDockerfile).toContain(`FROM ${froms[0]} AS base`);
    expect(dockerfile).not.toMatch(/^#\s*syntax\s*=/m);
    expect(dockerfile).not.toMatch(/^ARG\s/m);
  });

  it('installs nothing and copies the sources only, read-only', () => {
    expect(dockerfile).not.toMatch(/npm (ci|install)|apt-get|curl|wget/);
    const copies = [...dockerfile.matchAll(/^COPY\s+(.*)$/gm)].map((m) => m[1]);
    expect(copies).toEqual([
      '--chmod=0444 package.json ./',
      '--chmod=0444 src/*.ts ./src/',
      '--chmod=0444 src/platform/*.ts ./src/platform/',
    ]);
    expect(dockerfile).toMatch(/^USER node$/m);
  });

  it('fixes the platform and lets the operator set the configuration only', () => {
    expect(dockerfile).toMatch(/OAUTH_BROKER_PLATFORM=gcp-confidential-space/);
    const policy = labels();
    expect(policy.get('tee.launch_policy.allow_env_override')).toBe('OAUTH_BROKER_CONFIG');
    expect(policy.get('tee.launch_policy.allow_cmd_override')).toBe('false');
    expect(policy.get('tee.launch_policy.allow_capabilities')).toBe('false');
    expect(policy.get('tee.launch_policy.allow_cgroups')).toBe('false');
    expect(policy.get('tee.launch_policy.monitoring_memory_allow')).toBe('never');
    expect(policy.has('tee.launch_policy.allow_mount_destinations')).toBe(false);
    expect(dockerfile).toMatch(/^EXPOSE 8443\/tcp 8080\/tcp$/m);
  });
});

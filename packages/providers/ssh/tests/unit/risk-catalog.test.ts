import { describe, expect, test } from 'vitest';
import {
  indexCatalog,
  prepareCatalog,
  risksTouchedBy,
  risksTouchedByAll,
} from '@vaubaan/policy-engine';
import type { Slice } from '@vaubaan/shared';

import { sshRiskCatalog } from '../../src/risk-catalog.ts';

function commandSlice(hostSlug: string, action: 'R' | 'W'): Slice {
  return {
    provider: 'ssh',
    path: [
      { kind: 'name', value: 'host' },
      { kind: 'ident', value: hostSlug },
      { kind: 'name', value: 'command' },
    ],
    action,
  };
}

describe('sshRiskCatalog — shape', () => {
  test('provider is ssh', () => {
    expect(sshRiskCatalog.provider).toBe('ssh');
  });

  test('declares the 5 risks + fallback expected by the research doc', () => {
    const ids = sshRiskCatalog.risks.map((r) => r.id);
    expect(ids).toEqual([
      'ssh.exec-read',
      'ssh.exec-read-secret-files',
      'ssh.exec-write-staging',
      'ssh.exec-write-prod',
      'ssh.uncategorized-write',
    ]);
  });

  test('every entry has the required RiskEntry fields', () => {
    for (const entry of sshRiskCatalog.risks) {
      expect(entry.id).toMatch(/^ssh(\[[a-z][a-z0-9-]*\])?\.[a-z][a-z0-9-]+$/);
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(entry.matches.length).toBeGreaterThan(0);
      expect(['allow', 'confirm', 'deny']).toContain(entry.default_gate);
      expect(entry.vector).toBeDefined();
    }
  });

  test('exec-write-staging restricts to staging-vps / dev-vps via acceptable_in_envs', () => {
    const entry = sshRiskCatalog.risks.find((r) => r.id === 'ssh.exec-write-staging');
    expect(entry?.acceptable_in_envs).toEqual(['staging-vps', 'dev-vps']);
  });

  test('exec-read default_gate is allow', () => {
    const entry = sshRiskCatalog.risks.find((r) => r.id === 'ssh.exec-read');
    expect(entry?.default_gate).toBe('allow');
  });

  test('exec-write-prod default_gate is deny', () => {
    const entry = sshRiskCatalog.risks.find((r) => r.id === 'ssh.exec-write-prod');
    expect(entry?.default_gate).toBe('deny');
  });

  test('exec-read-secret-files default_gate is confirm', () => {
    const entry = sshRiskCatalog.risks.find((r) => r.id === 'ssh.exec-read-secret-files');
    expect(entry?.default_gate).toBe('confirm');
  });

  test('uncategorized-write is the fallback (matches ssh.**.W)', () => {
    const entry = sshRiskCatalog.risks.find((r) => r.id === 'ssh.uncategorized-write');
    expect(entry?.matches).toBe('ssh.**.W');
    expect(entry?.default_gate).toBe('confirm');
  });
});

describe('sshRiskCatalog — passes policy-engine prepareCatalog', () => {
  test('prepareCatalog accepts the YAML output (RiskId regex, unique ids, fallback present)', () => {
    expect(() => prepareCatalog(sshRiskCatalog)).not.toThrow();
  });

  test('every `matches` pattern parses as a valid slice (indexCatalog succeeds)', () => {
    expect(() => indexCatalog(sshRiskCatalog)).not.toThrow();
  });
});

describe('sshRiskCatalog — runtime risksTouchedBy', () => {
  const indexed = indexCatalog(sshRiskCatalog);

  test('a benign read slice touches both `exec-read` and `exec-read-secret-files`', () => {
    // Both risks share the same pattern `ssh.host[**].command.R`, so
    // every read intersects both. The discrimination happens at mint
    // time : the manager who accepts `exec-read` but NOT
    // `exec-read-secret-files` will see a 403 on every read — that's
    // by design (forces explicit consent to the credential-exfil
    // surface). Order follows catalog declaration order.
    const touched = risksTouchedBy(commandSlice('staging-vps', 'R'), indexed);
    expect(touched).toEqual(['ssh.exec-read', 'ssh.exec-read-secret-files']);
  });

  test('a write slice touches exec-write-staging + exec-write-prod + uncategorized-write fallback', () => {
    // All three W-shaped catalog entries have overlapping `matches`
    // patterns (the env qualification happens at mint, not runtime).
    const touched = risksTouchedBy(commandSlice('prod-host', 'W'), indexed);
    expect(touched).toEqual([
      'ssh.exec-write-staging',
      'ssh.exec-write-prod',
      'ssh.uncategorized-write',
    ]);
  });

  test('multi-slice read (secret-file co-touch) deduplicates risks across slices', () => {
    const slices = [commandSlice('staging-vps', 'R'), commandSlice('staging-vps', 'R')];
    const touched = risksTouchedByAll(slices, indexed);
    expect(touched).toEqual(['ssh.exec-read', 'ssh.exec-read-secret-files']);
  });
});

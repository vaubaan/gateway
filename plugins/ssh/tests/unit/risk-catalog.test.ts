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

  test('declares the 4 risks + fallback expected by the research doc', () => {
    const ids = sshRiskCatalog.risks.map((r) => r.id);
    expect(ids).toEqual([
      'ssh.exec-read',
      'ssh.exec-read-secret-files',
      'ssh.exec-write',
      'ssh.uncategorized-write',
    ]);
  });

  test('every entry has the required RiskEntry fields', () => {
    for (const entry of sshRiskCatalog.risks) {
      expect(entry.id).toMatch(/^ssh(\[[a-z][a-z0-9-]*\])?\.[a-z][a-z0-9-]+$/);
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(entry.matches.length).toBeGreaterThan(0);
      expect(entry.vector).toBeDefined();
    }
  });

  test('exec-write lists all known host slugs via acceptable_in_envs', () => {
    const entry = sshRiskCatalog.risks.find((r) => r.id === 'ssh.exec-write');
    expect(entry?.acceptable_in_envs).toEqual(['staging-vps', 'dev-vps', 'prod-vps']);
  });

  test('exec-write carries vector_overrides for prod-vps', () => {
    const entry = sshRiskCatalog.risks.find((r) => r.id === 'ssh.exec-write');
    expect(entry?.vector_overrides).toEqual({
      'prod-vps': {
        reversibility: 'irreversible',
        data: 'secret',
        cost: 'unbounded',
      },
    });
  });

  test('uncategorized-write is the fallback (matches ssh.**.W)', () => {
    const entry = sshRiskCatalog.risks.find((r) => r.id === 'ssh.uncategorized-write');
    expect(entry?.matches).toBe('ssh.**.W');
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

  test('a write slice touches exec-write alone (the fallback is not co-touched)', () => {
    // Inverted on purpose (ADR fallback-risk-only-when-uncategorized) : the fallback
    // counts only when no dedicated entry matched the slice.
    const touched = risksTouchedBy(commandSlice('prod-vps', 'W'), indexed);
    expect(touched).toEqual(['ssh.exec-write']);
  });

  test('multi-slice read (secret-file co-touch) deduplicates risks across slices', () => {
    const slices = [commandSlice('staging-vps', 'R'), commandSlice('staging-vps', 'R')];
    const touched = risksTouchedByAll(slices, indexed);
    expect(touched).toEqual(['ssh.exec-read', 'ssh.exec-read-secret-files']);
  });
});

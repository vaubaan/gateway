/**
 * Tests — Railway risk catalog.
 *
 * Source : .vaubaan/research/providers/railway-ssh.md §1.4 + §1.5.
 *
 * Verifies the catalog :
 *   - declares the 11 expected risks + 1 fallback (research §1.4).
 *   - every entry has the required shape (`RiskEntry` invariants).
 *   - every `matches` pattern parses as a valid slice.
 *   - the catalog round-trips through `prepareCatalog` (RiskId regex,
 *     unique ids, fallback present).
 *   - `risksTouchedBy` on representative concrete slices returns the
 *     expected `RiskId` set (sanity check of the catalog × matcher
 *     contract — same shape as ssh's catalog test).
 */
import { describe, expect, test } from 'vitest';
import { indexCatalog, prepareCatalog, risksTouchedBy } from '@vaubaan/policy-engine';
import type { Slice } from '@vaubaan/shared';

import { railwayRiskCatalog } from '../../src/risk-catalog.ts';

// ─── Helpers ───────────────────────────────────────────────────────────────

function readAccountSlice(): Slice {
  return {
    provider: 'railway',
    path: [{ kind: 'name', value: 'account' }, { kind: 'wild-one' }],
    action: 'R',
  };
}

function createProjectSlice(): Slice {
  return {
    provider: 'railway',
    path: [
      { kind: 'name', value: 'account' },
      { kind: 'wild-one' },
      { kind: 'name', value: 'project' },
    ],
    action: 'W',
  };
}

function agentSessionSlice(): Slice {
  return {
    provider: 'railway',
    path: [
      { kind: 'name', value: 'account' },
      { kind: 'wild-one' },
      { kind: 'name', value: 'agent-session' },
    ],
    action: 'W',
  };
}

function deploymentWriteSlice(env: string): Slice {
  return {
    provider: 'railway',
    path: [
      { kind: 'name', value: 'project' },
      { kind: 'ident', value: 'p-xyz' },
      { kind: 'name', value: 'environment' },
      { kind: 'ident', value: env },
      { kind: 'name', value: 'service' },
      { kind: 'ident', value: 'svc-1' },
      { kind: 'name', value: 'deployment' },
    ],
    action: 'W',
  };
}

function varReadSlice(env: string): Slice {
  return {
    provider: 'railway',
    path: [
      { kind: 'name', value: 'project' },
      { kind: 'ident', value: 'p-xyz' },
      { kind: 'name', value: 'environment' },
      { kind: 'ident', value: env },
      { kind: 'name', value: 'service-var' },
      { kind: 'wild-one' },
    ],
    action: 'R',
  };
}

function logsReadSlice(): Slice {
  return {
    provider: 'railway',
    path: [
      { kind: 'name', value: 'project' },
      { kind: 'ident', value: 'p-xyz' },
      { kind: 'name', value: 'environment' },
      { kind: 'ident', value: 'staging' },
      { kind: 'name', value: 'service' },
      { kind: 'ident', value: 'svc-1' },
      { kind: 'name', value: 'deployment' },
      { kind: 'wild-one' },
      { kind: 'name', value: 'logs' },
    ],
    action: 'R',
  };
}

// ─── Shape ─────────────────────────────────────────────────────────────────

describe('railwayRiskCatalog — shape', () => {
  test('provider is railway', () => {
    expect(railwayRiskCatalog.provider).toBe('railway');
  });

  test('declares the 11 risks + 1 fallback expected by the research doc (§1.4)', () => {
    const ids = railwayRiskCatalog.risks.map((r) => r.id);
    expect(ids).toEqual([
      'railway.read-account',
      'railway.read-runtime',
      'railway.read-logs',
      'railway.read-variables',
      'railway.deploy-staging',
      'railway.deploy-prod',
      'railway.upsert-variable-staging',
      'railway.upsert-variable-prod',
      'railway.bulk-variables-replace',
      'railway.create-project',
      'railway.agent-action',
      'railway.uncategorized-write',
    ]);
  });

  test('every entry has the required RiskEntry fields', () => {
    for (const entry of railwayRiskCatalog.risks) {
      expect(entry.id).toMatch(/^railway(\[[a-z][a-z0-9-]*\])?\.[a-z][a-z0-9-]+$/);
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(entry.matches.length).toBeGreaterThan(0);
      expect(entry.vector).toBeDefined();
    }
  });

  test('deploy-staging restricts to non-prod via acceptable_in_envs', () => {
    const entry = railwayRiskCatalog.risks.find((r) => r.id === 'railway.deploy-staging');
    expect(entry?.acceptable_in_envs).toEqual(['staging', 'preview', 'dev']);
  });

  test('upsert-variable-staging restricts to non-prod via acceptable_in_envs', () => {
    const entry = railwayRiskCatalog.risks.find((r) => r.id === 'railway.upsert-variable-staging');
    expect(entry?.acceptable_in_envs).toEqual(['staging', 'preview', 'dev']);
  });

  test('uncategorized-write is the fallback (matches railway.**.W)', () => {
    const entry = railwayRiskCatalog.risks.find((r) => r.id === 'railway.uncategorized-write');
    expect(entry?.matches).toBe('railway.**.W');
  });
});

// ─── Engine plumbing — parses + indexable ──────────────────────────────────

describe('railwayRiskCatalog — passes policy-engine prepareCatalog', () => {
  test('prepareCatalog accepts the catalog (RiskId regex, unique ids, fallback present)', () => {
    expect(() => prepareCatalog(railwayRiskCatalog)).not.toThrow();
  });

  test('every `matches` pattern parses as a valid slice (indexCatalog succeeds)', () => {
    expect(() => indexCatalog(railwayRiskCatalog)).not.toThrow();
  });
});

// ─── Runtime risksTouchedBy : sanity checks on representative slices ───────

describe('railwayRiskCatalog — runtime risksTouchedBy', () => {
  const indexed = indexCatalog(railwayRiskCatalog);

  test('account-level read touches read-account only (account[**].R)', () => {
    const touched = risksTouchedBy(readAccountSlice(), indexed);
    expect(touched).toEqual(['railway.read-account']);
  });

  test('create-project touches create-project + uncategorized-write fallback', () => {
    const touched = risksTouchedBy(createProjectSlice(), indexed);
    expect(touched).toEqual(['railway.create-project', 'railway.uncategorized-write']);
  });

  test('agent-session slice touches agent-action + uncategorized-write fallback', () => {
    // The fallback `railway.**.W` is broad enough to cover account-rooted W.
    const touched = risksTouchedBy(agentSessionSlice(), indexed);
    expect(touched).toEqual(['railway.agent-action', 'railway.uncategorized-write']);
  });

  test('deployment.W (staging env) touches deploy-staging + deploy-prod + uncategorized-write', () => {
    // Both deploy-{staging,prod} share the same matches pattern ; the env
    // qualification happens at mint time (acceptable_in_envs gate).
    const touched = risksTouchedBy(deploymentWriteSlice('staging'), indexed);
    expect(touched).toEqual([
      'railway.deploy-staging',
      'railway.deploy-prod',
      'railway.uncategorized-write',
    ]);
  });

  test('variable read on prod env touches read-runtime (broad) + read-variables (specific)', () => {
    // The `read-runtime` pattern `railway.project[**].R` is intentionally
    // broad and co-touches every project-scoped read ; the more specific
    // `read-variables` adds the secret-data dimension on top. A token
    // accepting `read-runtime` but NOT `read-variables` will be denied on
    // list-variables — by design, the manager must opt in to the
    // credential-exfil surface explicitly.
    const touched = risksTouchedBy(varReadSlice('prod'), indexed);
    expect(touched).toEqual(['railway.read-runtime', 'railway.read-variables']);
  });

  test('logs read touches read-runtime (broad) + read-logs (specific)', () => {
    const touched = risksTouchedBy(logsReadSlice(), indexed);
    expect(touched).toEqual(['railway.read-runtime', 'railway.read-logs']);
  });
});

// ─── Lint coverage : every tool covered by ≥ 1 risk (research §1.5) ────────

describe('railwayRiskCatalog — lint coverage', () => {
  test('every Railway tool name (research §1.5) has a corresponding risk', () => {
    // This test reads the catalog and checks that the union of ids covers
    // the conceptual surface declared in research §1.5. We do NOT test the
    // classifier↔catalog round-trip here (that's risk-classifier.test.ts) ;
    // we only check that the catalog has the *names* the coverage matrix
    // references.
    const ids = new Set(railwayRiskCatalog.risks.map((r) => r.id));
    const requiredCoverage = [
      'railway.read-account', // whoami, list-projects
      'railway.read-runtime', // list-services, list-deployments, get-status, get-logs
      'railway.read-logs', // get-logs (additionally)
      'railway.read-variables', // list-variables
      'railway.deploy-staging', // redeploy (staging), accept-deploy (staging)
      'railway.deploy-prod', // redeploy (prod), accept-deploy (prod)
      'railway.upsert-variable-staging', // upsert-variable (staging)
      'railway.upsert-variable-prod', // upsert-variable (prod)
      'railway.bulk-variables-replace', // upsert-variables replace=true
      'railway.create-project', // create-project
      'railway.agent-action', // railway-agent
      'railway.uncategorized-write', // fallback for any W not specifically covered
    ];
    for (const id of requiredCoverage) {
      expect(ids.has(id)).toBe(true);
    }
  });
});

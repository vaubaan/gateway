/**
 * Tests — Railway risk catalog (shape and runtime matching of the loaded YAML).
 *
 * Catalog : plugins/railway/src/risk-catalog.yaml (loaded by the SDK) ; handbook : docs/handbook/providers/railway.md.
 *
 * Verifies the catalog :
 *   - declares the 9 expected risks + 1 fallback (handbook).
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

import { railwayPlugin } from '../../src/index.ts';

const catalog = railwayPlugin.catalog;

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

describe('railway risk catalog — shape', () => {
  test('provider is railway', () => {
    expect(catalog.provider).toBe('railway');
  });

  test('declares the 9 risks + 1 fallback of the handbook', () => {
    const ids = catalog.risks.map((r) => r.id);
    expect(ids).toEqual([
      'railway.read-account',
      'railway.read-runtime',
      'railway.read-logs',
      'railway.read-variables',
      'railway.deploy',
      'railway.upsert-variable',
      'railway.bulk-variables-replace',
      'railway.create-project',
      'railway.agent-action',
      'railway.uncategorized-write',
    ]);
  });

  test('every entry has the required RiskEntry fields', () => {
    for (const entry of catalog.risks) {
      expect(entry.id).toMatch(/^railway(\[[a-z][a-z0-9-]*\])?\.[a-z][a-z0-9-]+$/);
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(entry.matches.length).toBeGreaterThan(0);
      expect(entry.vector).toBeDefined();
    }
  });

  test('deploy covers all envs via acceptable_in_envs and overrides prod vector', () => {
    const entry = catalog.risks.find((r) => r.id === 'railway.deploy');
    expect(entry?.acceptable_in_envs).toEqual(['staging', 'preview', 'dev', 'prod']);
    expect(entry?.vector.reversibility).toBe('reversible');
    expect(entry?.vector_overrides).toEqual({
      prod: { reversibility: 'costly', visibility: 'public' },
    });
  });

  test('upsert-variable covers all envs via acceptable_in_envs and overrides prod vector', () => {
    const entry = catalog.risks.find((r) => r.id === 'railway.upsert-variable');
    expect(entry?.acceptable_in_envs).toEqual(['staging', 'preview', 'dev', 'prod']);
    expect(entry?.vector.reversibility).toBe('reversible');
    expect(entry?.vector_overrides).toEqual({ prod: { reversibility: 'costly' } });
  });

  test('catalog_version is 5 (4 brought the replace marker, 5 the macro-actions) : bulk-variables-replace matches the replace marker only', () => {
    expect(catalog.catalog_version).toBe(5);
    const entry = catalog.risks.find((r) => r.id === 'railway.bulk-variables-replace');
    expect(entry?.matches).toBe('railway.project[**].environment[**].service-var-replace.W');
    // Destructive anywhere : not env-scoped, so no label can make it acceptable by default.
    expect(entry?.acceptable_in_envs).toBeUndefined();
  });

  test('uncategorized-write is the fallback (matches railway.**.W)', () => {
    const entry = catalog.risks.find((r) => r.id === 'railway.uncategorized-write');
    expect(entry?.matches).toBe('railway.**.W');
  });
});

// ─── Engine plumbing — parses + indexable ──────────────────────────────────

describe('railway risk catalog — passes policy-engine prepareCatalog', () => {
  test('prepareCatalog accepts the catalog (RiskId regex, unique ids, fallback present)', () => {
    expect(() => prepareCatalog(catalog)).not.toThrow();
  });

  test('every `matches` pattern parses as a valid slice (indexCatalog succeeds)', () => {
    expect(() => indexCatalog(catalog)).not.toThrow();
  });
});

// ─── Runtime risksTouchedBy : sanity checks on representative slices ───────

describe('railway risk catalog — runtime risksTouchedBy', () => {
  const indexed = indexCatalog(catalog);

  test('account-level read touches read-account only (account[**].R)', () => {
    const touched = risksTouchedBy(readAccountSlice(), indexed);
    expect(touched).toEqual(['railway.read-account']);
  });

  // The next three cases were inverted on purpose (ADR fallback-risk-only-when-uncategorized) :
  // the fallback counts only when no dedicated entry matched the slice.
  test('create-project touches create-project alone', () => {
    const touched = risksTouchedBy(createProjectSlice(), indexed);
    expect(touched).toEqual(['railway.create-project']);
  });

  test('agent-session slice touches agent-action alone', () => {
    const touched = risksTouchedBy(agentSessionSlice(), indexed);
    expect(touched).toEqual(['railway.agent-action']);
  });

  test('deployment.W (staging env) touches deploy alone', () => {
    // Single deploy entry with vector_overrides covers all envs ;
    // env qualification happens at mint time (acceptable_in_envs gate).
    const touched = risksTouchedBy(deploymentWriteSlice('staging'), indexed);
    expect(touched).toEqual(['railway.deploy']);
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

// ─── Classifier × catalog : which risks each variable write touches ────────

describe('railway risk catalog — variable writes as classified', () => {
  const indexed = indexCatalog(catalog);
  const PROJECT = 'p-xyz';
  const ENV_ID = 'env-1';
  const resources = [
    {
      provider: 'railway',
      ref: PROJECT,
      displayName: 'api',
      env: 'staging',
      metadata: { environments: [{ id: ENV_ID, name: 'staging' }] },
    },
  ];

  function touchedBy(tool: string, extra: Record<string, unknown>): string[] {
    const args = { projectId: PROJECT, environmentId: ENV_ID, ...extra };
    const outcome = railwayPlugin.classify(tool, args, resources);
    if ('denied' in outcome) throw new Error(outcome.denied);
    return [...new Set(outcome.slices.flatMap((s) => risksTouchedBy(s, indexed)))];
  }

  test('a write of named variables touches upsert-variable alone', () => {
    const only = ['railway.upsert-variable'];
    expect(touchedBy('railway__upsert-variable', { name: 'A', value: '1' })).toEqual(only);
    expect(touchedBy('railway__delete-variable', { name: 'A' })).toEqual(only);
    expect(touchedBy('railway__upsert-variables', { variables: { A: '1', B: '2' } })).toEqual(only);
    expect(
      touchedBy('railway__upsert-variables', { variables: { A: '1' }, replace: false }),
    ).toEqual(only);
  });

  test('a replace of every variable touches upsert-variable and bulk-variables-replace', () => {
    const both = ['railway.upsert-variable', 'railway.bulk-variables-replace'];
    expect(
      touchedBy('railway__upsert-variables', { variables: { A: '1' }, replace: true }),
    ).toEqual(both);
    expect(touchedBy('railway__upsert-variables', { variables: {} })).toEqual(both);
  });

  test('railway-agent touches agent-action, deploy and both variable risks, never the fallback', () => {
    expect(touchedBy('railway__railway-agent', { message: 'hi' })).toEqual([
      'railway.agent-action',
      'railway.deploy',
      'railway.upsert-variable',
      'railway.bulk-variables-replace',
    ]);
  });
});

// ─── Lint coverage : every tool covered by ≥ 1 risk (handbook coverage matrix) ────────

describe('railway risk catalog — lint coverage', () => {
  test('every Railway tool surface has a corresponding risk', () => {
    // This test reads the catalog and checks that the union of ids covers
    // the conceptual surface of the handbook coverage matrix. We do NOT test the
    // classifier↔catalog round-trip here (that's risk-classifier.test.ts) ;
    // we only check that the catalog has the *names* the coverage matrix
    // references.
    const ids = new Set(catalog.risks.map((r) => r.id));
    const requiredCoverage = [
      'railway.read-account', // whoami, list-projects
      'railway.read-runtime', // list-services, list-deployments, get-status, get-logs
      'railway.read-logs', // get-logs (additionally)
      'railway.read-variables', // list-variables
      'railway.deploy', // redeploy, accept-deploy (all envs, vector_overrides for prod)
      'railway.upsert-variable', // upsert-variable (all envs, vector_overrides for prod)
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

/**
 * Catalog lint — parses the YAML, validates the static schema, parses every
 * `matches` slice pattern, and walks every MCP tool exposed by the provider
 * to assert that AT LEAST ONE non-fallback risk matches at least one of the
 * tool's emitted slices.
 *
 * Spec : docs/spec/gateway-risk-model.md §4, §14.
 * Research : .vaubaan/research/providers/vercel.md §4.
 *
 * The lint fails the build (CI gate) on :
 *   - malformed YAML
 *   - duplicate RiskId
 *   - RiskId that breaks the wire-format regex (cf. shared/src/risk.ts)
 *   - a `matches` pattern that does not parse via `parseSlice`
 *   - missing fallback risk (`vercel.uncategorized-*`)
 *   - any tool whose emitted slices are only covered by the fallback risk
 *     (signals a hole in the catalog).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, test } from 'vitest';
import yaml from 'js-yaml';
import type { ProviderBinding, RiskCatalog, RiskEntry, Slice } from '@vaubaan/shared';
import { matches, parseSlice } from '@vaubaan/policy-engine';

import { availableTools as vercelAvailableTools } from '../../src/tools.ts';
import { classifyVercelV4 } from '../../src/risk-classifier.ts';

// ─── Load + parse the YAML catalog ──────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const yamlPath = resolve(here, '../../src/risk-catalog.yaml');
const rawYaml = readFileSync(yamlPath, 'utf8');
const parsedCatalog = yaml.load(rawYaml) as RiskCatalog;

const binding: ProviderBinding = {
  id: 'b1',
  project_id: 'p1',
  provider: 'vercel',
  resource_ref: 'prj_abc',
  display_name: null,
  created_at: '2026-01-01',
};

// Mirror the regex from shared/src/risk.ts so we can lint catalog ids
// without importing a private symbol (cf. risk-policy.ts:RISK_ID_REGEX).
const RISK_ID_REGEX = /^[a-z][a-z0-9]*(\[[a-z][a-z0-9-]*\])?(\.[a-z][a-z0-9-]+)+$/;

describe('vercel risk-catalog — YAML structural validation', () => {
  test('YAML parses into a valid RiskCatalog shape', () => {
    expect(parsedCatalog.provider).toBe('vercel');
    expect(Array.isArray(parsedCatalog.risks)).toBe(true);
    expect(parsedCatalog.risks.length).toBeGreaterThanOrEqual(10);
  });

  test('every entry declares the required fields', () => {
    for (const entry of parsedCatalog.risks) {
      expect(typeof entry.id).toBe('string');
      expect(typeof entry.label).toBe('string');
      expect(typeof entry.reason).toBe('string');
      expect(
        typeof entry.matches === 'string' || Array.isArray(entry.matches),
        `risk '${entry.id}' matches must be a string or string[]`,
      ).toBe(true);
      expect(entry.vector).toBeDefined();
    }
  });

  test('every RiskId matches the wire-format regex', () => {
    for (const entry of parsedCatalog.risks) {
      expect(entry.id, `risk id '${entry.id}' must match RISK_ID_REGEX`).toMatch(RISK_ID_REGEX);
    }
  });

  test('RiskIds are unique', () => {
    const seen = new Set<string>();
    for (const entry of parsedCatalog.risks) {
      expect(seen.has(entry.id), `duplicate risk id '${entry.id}'`).toBe(false);
      seen.add(entry.id);
    }
  });

  test('every 6D vector axis carries a valid value', () => {
    const axes: Record<keyof RiskEntry['vector'], readonly string[]> = {
      reversibility: ['reversible', 'costly', 'irreversible'],
      blast: ['single', 'env', 'account', 'bulk'],
      data: ['metadata', 'data', 'secret', 'pii'],
      cost: ['free', 'moderate', 'unbounded'],
      visibility: ['internal', 'team', 'public'],
      persistence: ['stateless', 'session', 'posture'],
    };
    for (const entry of parsedCatalog.risks) {
      for (const [axis, allowed] of Object.entries(axes) as Array<
        [keyof RiskEntry['vector'], readonly string[]]
      >) {
        expect(
          allowed,
          `risk '${entry.id}' axis '${axis}' has invalid value '${entry.vector[axis]}'`,
        ).toContain(entry.vector[axis]);
      }
    }
  });

  test('a fallback entry (uncategorized-*) is declared', () => {
    const hasFallback = parsedCatalog.risks.some((e) => e.id.startsWith('vercel.uncategorized'));
    expect(hasFallback, 'catalog must declare a vercel.uncategorized-* fallback').toBe(true);
  });
});

describe('vercel risk-catalog — every `matches` pattern parses via parseSlice', () => {
  for (const entry of parsedCatalog.risks) {
    test(`'${entry.id}' parses`, () => {
      const raws: readonly string[] =
        typeof entry.matches === 'string' ? [entry.matches] : entry.matches;
      for (const raw of raws) {
        const parsed = parseSlice(raw);
        expect(parsed.provider).toBe('vercel');
      }
    });
  }
});

// ─── Build the parsed-pattern index once for lint usage ─────────────────────

const indexed = parsedCatalog.risks.map((entry) => {
  const raws: readonly string[] =
    typeof entry.matches === 'string' ? [entry.matches] : entry.matches;
  return {
    entry,
    patterns: raws.map((raw) => parseSlice(raw)),
  };
});

const FALLBACK_ID = 'vercel.uncategorized-write';

/** All slices the classifier can emit for a tool — we synthesise the
 *  argument combinations that matter for risk coverage. Each row may
 *  produce 1+ slices.  */
function syntheticArgsForTool(tool: string): Array<Record<string, unknown>> {
  // Common project-bound args reused below.
  const base = { projectId: 'prj_abc' } as const;
  switch (tool) {
    case 'vercel__deploy_to_vercel':
      return [
        { ...base, target: 'production' },
        { ...base, target: 'preview' },
        { ...base, target: 'development' },
      ];
    case 'vercel__upsert_env_var':
      return [
        { ...base, key: 'K', value: 'v', target: ['preview'] },
        { ...base, key: 'K', value: 'v', target: ['production'] },
        { ...base, key: 'K', value: 'v', target: ['production', 'preview', 'development'] },
      ];
    case 'vercel__delete_env_var':
      return [{ ...base, id: 'env_xyz' }];
    case 'vercel__list_env_vars':
      return [{ ...base }, { ...base, decrypt: true }];
    case 'vercel__get_access_to_vercel_url':
      return [{ url: 'dep-foo' }];
    case 'vercel__web_fetch_vercel_url':
      return [{ url: 'dep-foo' }];
    case 'vercel__get_deployment':
      return [{ ...base, idOrUrl: 'dep_xyz' }];
    case 'vercel__get_deployment_build_logs':
      return [{ ...base, idOrUrl: 'dep_xyz' }];
    case 'vercel__get_runtime_logs':
      return [{ ...base, deploymentId: 'dep_xyz' }];
    case 'vercel__list_toolbar_threads':
      return [{ ...base }];
    case 'vercel__get_toolbar_thread':
    case 'vercel__change_toolbar_thread_resolve_status':
    case 'vercel__reply_to_toolbar_thread':
      return [{ ...base, threadId: 'thr_1' }];
    case 'vercel__edit_toolbar_message':
    case 'vercel__add_toolbar_reaction':
      return [{ ...base, threadId: 'thr_1', messageId: 'msg_2' }];
    case 'vercel__add_project_domain':
    case 'vercel__verify_project_domain':
    case 'vercel__remove_project_domain':
      return [{ ...base, name: 'staging', domain: 'staging' }];
    default:
      return [base];
  }
}

/** Concrete slices the classifier emits for a tool, across the synthetic
 *  argument shapes above. */
function slicesForTool(tool: string): Slice[] {
  const out: Slice[] = [];
  for (const args of syntheticArgsForTool(tool)) {
    const result = classifyVercelV4(tool, args, [binding]);
    if ('slices' in result) out.push(...result.slices);
  }
  return out;
}

/** RiskIds matching at least one slice (across all synthetic invocations of
 *  the tool). */
function risksForTool(tool: string): string[] {
  const sl = slicesForTool(tool);
  const matched = new Set<string>();
  for (const slice of sl) {
    for (const { entry, patterns } of indexed) {
      if (patterns.some((p) => matches(p, slice))) matched.add(entry.id);
    }
  }
  return [...matched];
}

describe('vercel risk-catalog — coverage lint (every tool matched by ≥1 non-fallback risk)', () => {
  for (const tool of vercelAvailableTools) {
    test(`'${tool.name}' is covered by at least one non-fallback risk`, () => {
      const hit = risksForTool(tool.name);
      expect(hit.length, `tool '${tool.name}' matched zero catalog risks`).toBeGreaterThan(0);
      const nonFallback = hit.filter((id) => id !== FALLBACK_ID);
      expect(
        nonFallback.length,
        `tool '${tool.name}' is only covered by the fallback ${FALLBACK_ID} — add a specific risk`,
      ).toBeGreaterThan(0);
    });
  }
});

describe('vercel risk-catalog — saliency checks (entries from research doc §3)', () => {
  test('deploy entry exists (merged from deploy-preview + deploy-prod)', () => {
    const entry = parsedCatalog.risks.find((r) => r.id === 'vercel.deploy');
    expect(entry).toBeDefined();
    expect(Array.isArray(entry!.matches)).toBe(true);
    expect(entry!.acceptable_in_envs).toEqual(['preview', 'development', 'prod']);
    expect(entry!.vector_overrides).toBeDefined();
    expect(entry!.vector_overrides!.prod).toEqual({
      reversibility: 'costly',
      blast: 'env',
      visibility: 'public',
    });
  });

  test('env-var-write entry exists (merged from env-var-write-preview + env-var-write-prod)', () => {
    const entry = parsedCatalog.risks.find((r) => r.id === 'vercel.env-var-write');
    expect(entry).toBeDefined();
    expect(Array.isArray(entry!.matches)).toBe(true);
    expect(entry!.acceptable_in_envs).toEqual(['preview', 'development', 'prod']);
    expect(entry!.vector_overrides).toBeDefined();
    expect(entry!.vector_overrides!.prod).toEqual({ reversibility: 'costly' });
  });

  test('env-var-fan-out entry exists', () => {
    expect(parsedCatalog.risks.find((r) => r.id === 'vercel.env-var-fan-out')).toBeDefined();
  });

  test('deployment-protection-write entry exists', () => {
    expect(
      parsedCatalog.risks.find((r) => r.id === 'vercel.deployment-protection-write'),
    ).toBeDefined();
  });

  test('domain-write entry exists', () => {
    expect(parsedCatalog.risks.find((r) => r.id === 'vercel.domain-write')).toBeDefined();
  });

  test('read-env-var-plaintext entry exists', () => {
    expect(parsedCatalog.risks.find((r) => r.id === 'vercel.read-env-var-plaintext')).toBeDefined();
  });

  test('fallback entry exists', () => {
    expect(parsedCatalog.risks.find((r) => r.id === FALLBACK_ID)).toBeDefined();
  });
});

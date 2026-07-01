/**
 * Catalog lint — parses the YAML, validates the static schema, parses every
 * `matches` slice pattern, walks every Resend MCP tool the classifier
 * supports, and asserts that AT LEAST ONE non-fallback risk matches each
 * tool's emitted slices.
 *
 * Spec : docs/spec/resend.md §5.
 *
 * The lint fails the build (CI gate) on :
 *   - malformed YAML
 *   - duplicate RiskId
 *   - RiskId that breaks the wire-format regex (cf. shared/src/risk.ts)
 *   - a `matches` pattern that does not parse via `parseSlice`
 *   - missing fallback risk (`resend.uncategorized-*`)
 *   - any tool whose emitted slices are only covered by the fallback risk
 *     (signals a hole in the catalog).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, test } from 'vitest';
import yaml from 'js-yaml';
import type { ProviderBinding, RiskCatalog, RiskEntry, Slice } from '@vaubaan/shared';
import { matches, parseSlice, prepareCatalog, risksTouchedBy } from '@vaubaan/policy-engine';

import { classifyResendV4 } from '../../src/risk-classifier.ts';
import { resendRiskCatalog } from '../../src/risk-catalog.ts';

// ─── Load + parse the YAML catalog ──────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const yamlPath = resolve(here, '../../src/risk-catalog.yaml');
const rawYaml = readFileSync(yamlPath, 'utf8');
const parsedCatalog = yaml.load(rawYaml) as RiskCatalog;

const binding: ProviderBinding = {
  id: 'b1',
  project_id: 'p1',
  provider: 'resend',
  resource_ref: 'prod-email',
  display_name: null,
  environment: 'prod',
  metadata: {
    internal_domains: ['acme.com'],
    allowlist_domains: ['partner.com'],
    allowlist_addresses: ['support@vendor.com'],
  },
  created_at: '2026-01-01',
};

// Mirror the regex from shared/src/risk.ts so we can lint catalog ids without
// importing a private symbol.
const RISK_ID_REGEX =
  /^[a-z][a-z0-9]*(-[a-z][a-z0-9]*)*(\[[a-z][a-z0-9-]*\])?(\.[a-z][a-z0-9-]+)+$/;

describe('resend risk-catalog — YAML structural validation', () => {
  test('YAML parses into a valid RiskCatalog shape', () => {
    expect(parsedCatalog.provider).toBe('resend');
    expect(Array.isArray(parsedCatalog.risks)).toBe(true);
    // Expect 15 named risks + 1 fallback = 16.
    expect(parsedCatalog.risks.length).toBe(16);
  });

  test('every entry declares the required fields', () => {
    for (const entry of parsedCatalog.risks) {
      expect(typeof entry.id).toBe('string');
      expect(typeof entry.label).toBe('string');
      expect(typeof entry.reason).toBe('string');
      expect(entry.matches).toBeDefined();
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
    const hasFallback = parsedCatalog.risks.some((e) => e.id.startsWith('resend.uncategorized'));
    expect(hasFallback, 'catalog must declare a resend.uncategorized-* fallback').toBe(true);
  });

  test('resend.broadcast-send carries cost: unbounded + irreversible + caps + infra_limits', () => {
    const entry = parsedCatalog.risks.find((r) => r.id === 'resend.broadcast-send');
    expect(entry).toBeDefined();
    expect(entry!.vector.cost).toBe('unbounded');
    expect(entry!.vector.reversibility).toBe('irreversible');
    expect(entry!.caps).toBeDefined();
    expect(entry!.caps!.calls_per_minute_max).toBe(1);
    expect(entry!.caps!.calls_per_session_max).toBe(5);
    expect(entry!.infra_limits).toBeDefined();
    expect(entry!.infra_limits!.calls_per_minute_max).toBe(10);
  });

  test('resend.send-batch carries caps + infra_limits', () => {
    const entry = parsedCatalog.risks.find((r) => r.id === 'resend.send-batch');
    expect(entry).toBeDefined();
    expect(entry!.caps).toBeDefined();
    expect(entry!.caps!.items_per_call_max).toBe(100);
    expect(entry!.caps!.calls_per_minute_max).toBe(5);
    expect(entry!.caps!.calls_per_session_max).toBe(50);
    expect(entry!.infra_limits).toBeDefined();
    expect(entry!.infra_limits!.items_per_call_max).toBe(100);
  });

  test('the 2 irreversible risks are declared (send-email-external-unbounded, broadcast-send)', () => {
    const irreversible = parsedCatalog.risks.filter(
      (r) => r.vector.reversibility === 'irreversible',
    );
    const ids = irreversible.map((r) => r.id).sort();
    expect(ids).toEqual([
      'resend.broadcast-send',
      'resend.send-batch',
      'resend.send-email-external-unbounded',
    ]);
  });

  test('only send-email-external-unbounded carries acceptable_in_envs', () => {
    const entry = parsedCatalog.risks.find((r) => r.id === 'resend.send-email-external-unbounded');
    expect(entry).toBeDefined();
    expect(entry!.acceptable_in_envs).toEqual(['staging', 'dev']);

    // All others should NOT carry acceptable_in_envs
    for (const e of parsedCatalog.risks) {
      if (e.id !== 'resend.send-email-external-unbounded') {
        expect(
          e.acceptable_in_envs,
          `risk '${e.id}' should NOT carry acceptable_in_envs`,
        ).toBeUndefined();
      }
    }
  });
});

describe('resend risk-catalog — every `matches` pattern parses via parseSlice', () => {
  for (const entry of parsedCatalog.risks) {
    test(`'${entry.id}' parses`, () => {
      const raws: readonly string[] =
        typeof entry.matches === 'string' ? [entry.matches] : entry.matches;
      for (const raw of raws) {
        const parsed = parseSlice(raw);
        expect(parsed.provider).toBe('resend');
      }
    });
  }
});

describe('resend risk-catalog — prepareCatalog roundtrips OK', () => {
  test('prepareCatalog accepts the TS catalog', () => {
    const indexed = prepareCatalog(resendRiskCatalog);
    expect(indexed.provider).toBe('resend');
    expect(indexed.entries.length).toBe(parsedCatalog.risks.length);
  });
});

// ─── Build the parsed-pattern index once for lint usage ─────────────────────

/** Flatten one risk entry into one (entry, pattern) row per `matches` string. */
const indexed = parsedCatalog.risks.flatMap((entry) => {
  const raws: readonly string[] =
    typeof entry.matches === 'string' ? [entry.matches] : entry.matches;
  return raws.map((raw) => ({ entry, pattern: parseSlice(raw) }));
});

const FALLBACK_ID = 'resend.uncategorized-write';

/** The 25 tools the Resend classifier knows (9 reads + 16 writes). */
const RESEND_TOOLS = [
  // reads
  'resend__get_email',
  'resend__list_domains',
  'resend__get_domain',
  'resend__list_audiences',
  'resend__get_audience',
  'resend__list_contacts',
  'resend__get_contact',
  'resend__list_broadcasts',
  'resend__get_broadcast',
  // writes
  'resend__send_email',
  'resend__send_batch_emails',
  'resend__create_domain',
  'resend__update_domain',
  'resend__delete_domain',
  'resend__verify_domain',
  'resend__create_audience',
  'resend__delete_audience',
  'resend__create_contact',
  'resend__update_contact',
  'resend__delete_contact',
  'resend__create_broadcast',
  'resend__update_broadcast',
  'resend__send_broadcast',
  'resend__delete_broadcast',
  'resend__describe_zones',
] as const;

/** Synthesise argument shapes that exercise the classifier on each tool. */
function syntheticArgsForTool(tool: string): Array<Record<string, unknown>> {
  switch (tool) {
    case 'resend__get_email':
      return [{ id: 'email_x' }];
    case 'resend__get_domain':
      return [{ id: 'dom_x' }];
    case 'resend__get_audience':
      return [{ id: 'aud_x' }];
    case 'resend__list_contacts':
      return [{ audience_id: 'aud_x' }];
    case 'resend__get_contact':
      return [{ id: 'contact_x' }];
    case 'resend__get_broadcast':
      return [{ id: 'brd_x' }];
    case 'resend__send_email':
      return [{ from: 'noreply@acme.com', to: ['alice@acme.com'], subject: 'hi' }];
    case 'resend__send_batch_emails':
      return [
        {
          emails: [{ from: 'noreply@acme.com', to: ['alice@acme.com'], subject: 'hi' }],
        },
      ];
    case 'resend__create_domain':
      return [{ name: 'mail.acme.com' }];
    case 'resend__update_domain':
      return [{ id: 'dom_x' }];
    case 'resend__delete_domain':
      return [{ id: 'dom_x' }];
    case 'resend__verify_domain':
      return [{ id: 'dom_x' }];
    case 'resend__create_audience':
      return [{ name: 'Newsletter' }];
    case 'resend__delete_audience':
      return [{ id: 'aud_x' }];
    case 'resend__create_contact':
      return [{ audience_id: 'aud_x', email: 'bob@acme.com' }];
    case 'resend__update_contact':
      return [{ id: 'contact_x' }];
    case 'resend__delete_contact':
      return [{ id: 'contact_x' }];
    case 'resend__create_broadcast':
      return [{ audience_id: 'aud_x', from: 'noreply@acme.com', subject: 'news' }];
    case 'resend__update_broadcast':
      return [{ id: 'brd_x' }];
    case 'resend__send_broadcast':
      return [{ id: 'brd_x' }];
    case 'resend__delete_broadcast':
      return [{ id: 'brd_x' }];
    default:
      return [{}];
  }
}

function slicesForTool(tool: string): Slice[] {
  const out: Slice[] = [];
  for (const args of syntheticArgsForTool(tool)) {
    const result = classifyResendV4(tool, args, [binding]);
    if ('slices' in result) out.push(...result.slices);
  }
  return out;
}

function risksForTool(tool: string): string[] {
  const sl = slicesForTool(tool);
  const matched = new Set<string>();
  for (const sliceItem of sl) {
    for (const { entry, pattern } of indexed) {
      if (matches(pattern, sliceItem)) matched.add(entry.id);
    }
  }
  return [...matched];
}

describe('resend risk-catalog — coverage lint (every tool matched by >=1 non-fallback risk)', () => {
  for (const tool of RESEND_TOOLS) {
    test(`'${tool}' is covered by at least one non-fallback risk`, () => {
      const hit = risksForTool(tool);
      expect(hit.length, `tool '${tool}' matched zero catalog risks`).toBeGreaterThan(0);
      const nonFallback = hit.filter((id) => id !== FALLBACK_ID);
      expect(
        nonFallback.length,
        `tool '${tool}' is only covered by the fallback ${FALLBACK_ID} — add a specific risk`,
      ).toBeGreaterThan(0);
    });
  }
});

describe('resend risk-catalog — risksTouchedBy sanity checks', () => {
  const idx = prepareCatalog(resendRiskCatalog);

  test('an email[X].R slice touches resend.read-email-status', () => {
    const sl = parseSlice('resend.account[prod-email].email[email_x].R');
    expect(risksTouchedBy(sl, idx)).toContain('resend.read-email-status');
  });

  test('a domain[D].R slice touches resend.read-domains', () => {
    const sl = parseSlice('resend.account[prod-email].domain[dom_x].R');
    expect(risksTouchedBy(sl, idx)).toContain('resend.read-domains');
  });

  test('an audience[A].R slice touches resend.read-audiences', () => {
    const sl = parseSlice('resend.account[prod-email].audience[aud_x].R');
    expect(risksTouchedBy(sl, idx)).toContain('resend.read-audiences');
  });

  test('a to-zone[internal].W slice touches resend.send-email-internal', () => {
    const sl = parseSlice('resend.account[prod-email].to-zone[internal].W');
    expect(risksTouchedBy(sl, idx)).toContain('resend.send-email-internal');
  });

  test('a to-zone[external-unbounded].W slice touches resend.send-email-external-unbounded', () => {
    const sl = parseSlice('resend.account[prod-email].to-zone[external-unbounded].W');
    expect(risksTouchedBy(sl, idx)).toContain('resend.send-email-external-unbounded');
  });

  test('a recipient-count[batch].W slice touches resend.send-batch', () => {
    const sl = parseSlice('resend.account[prod-email].recipient-count[batch].W');
    expect(risksTouchedBy(sl, idx)).toContain('resend.send-batch');
  });

  test('a broadcast[B].send.W slice touches resend.broadcast-send', () => {
    const sl = parseSlice('resend.account[prod-email].audience[aud_x].broadcast[brd_x].send.W');
    expect(risksTouchedBy(sl, idx)).toContain('resend.broadcast-send');
  });

  test('a broadcast[B].delete.W slice touches resend.broadcast-delete', () => {
    const sl = parseSlice('resend.account[prod-email].audience[aud_x].broadcast[brd_x].delete.W');
    expect(risksTouchedBy(sl, idx)).toContain('resend.broadcast-delete');
  });

  test('a domain[D].W slice touches resend.domain-write', () => {
    const sl = parseSlice('resend.account[prod-email].domain[dom_x].W');
    expect(risksTouchedBy(sl, idx)).toContain('resend.domain-write');
  });

  test('a domain[D].dns-record[*].W slice touches resend.domain-verify', () => {
    const sl = parseSlice('resend.account[prod-email].domain[dom_x].dns-record[*].W');
    expect(risksTouchedBy(sl, idx)).toContain('resend.domain-verify');
  });

  test('the fallback catches a wholly novel write slice', () => {
    const sl = parseSlice('resend.account[prod-email].webhook[*].W');
    expect(risksTouchedBy(sl, idx)).toContain('resend.uncategorized-write');
  });
});

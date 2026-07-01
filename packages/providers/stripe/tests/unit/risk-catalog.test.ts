/**
 * Catalog lint — parses the YAML, validates the static schema, parses every
 * `matches` slice pattern, walks every Stripe MCP tool the classifier
 * supports, and asserts that AT LEAST ONE non-fallback risk matches each
 * tool's emitted slices.
 *
 * Spec     : docs/spec/gateway-risk-model.md §4, §14.
 * Research : .vaubaan/research/providers/stripe.md §4.
 *
 * The lint fails the build (CI gate) on :
 *   - malformed YAML
 *   - duplicate RiskId
 *   - RiskId that breaks the wire-format regex (cf. shared/src/risk.ts)
 *   - a `matches` pattern that does not parse via `parseSlice`
 *   - missing fallback risk (`stripe.uncategorized-*`)
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

import { classifyStripeV4 } from '../../src/risk-classifier.ts';
import { stripeRiskCatalog } from '../../src/risk-catalog.ts';

// ─── Load + parse the YAML catalog ──────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const yamlPath = resolve(here, '../../src/risk-catalog.yaml');
const rawYaml = readFileSync(yamlPath, 'utf8');
const parsedCatalog = yaml.load(rawYaml) as RiskCatalog;

const binding: ProviderBinding = {
  id: 'b1',
  project_id: 'p1',
  provider: 'stripe',
  resource_ref: 'acct_test123',
  display_name: null,
  environment: 'live',
  metadata: {},
  created_at: '2026-01-01',
};

// Mirror the regex from shared/src/risk.ts so we can lint catalog ids without
// importing a private symbol (cf. risk-policy.ts:RISK_ID_REGEX).
const RISK_ID_REGEX =
  /^[a-z][a-z0-9]*(-[a-z][a-z0-9]*)*(\[[a-z][a-z0-9-]*\])?(\.[a-z][a-z0-9-]+)+$/;

describe('stripe risk-catalog — YAML structural validation', () => {
  test('YAML parses into a valid RiskCatalog shape', () => {
    expect(parsedCatalog.provider).toBe('stripe');
    expect(Array.isArray(parsedCatalog.risks)).toBe(true);
    // Expect 14 named risks + 1 fallback = 15.
    expect(parsedCatalog.risks.length).toBe(15);
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
    const hasFallback = parsedCatalog.risks.some((e) => e.id.startsWith('stripe.uncategorized'));
    expect(hasFallback, 'catalog must declare a stripe.uncategorized-* fallback').toBe(true);
  });

  test('stripe.refund-create carries cost: unbounded + irreversible + caps + infra_limits', () => {
    const entry = parsedCatalog.risks.find((r) => r.id === 'stripe.refund-create');
    expect(entry).toBeDefined();
    expect(entry!.vector.cost).toBe('unbounded');
    expect(entry!.vector.reversibility).toBe('irreversible');
    expect(entry!.caps).toBeDefined();
    expect(entry!.caps!.items_per_call_max).toBe(1);
    expect(entry!.caps!.calls_per_minute_max).toBe(3);
    expect(entry!.caps!.calls_per_session_max).toBe(20);
    expect(entry!.infra_limits).toBeDefined();
    expect(entry!.infra_limits!.calls_per_minute_max).toBe(30);
  });

  test('the 3 irreversible risks are declared (refund-create, subscription-cancel, invoice-void)', () => {
    const irreversible = parsedCatalog.risks.filter(
      (r) => r.vector.reversibility === 'irreversible',
    );
    const ids = irreversible.map((r) => r.id).sort();
    expect(ids).toEqual([
      'stripe.invoice-void',
      'stripe.refund-create',
      'stripe.subscription-cancel',
    ]);
  });

  test('no risk declares acceptable_in_envs at MVP (research §3.3)', () => {
    for (const entry of parsedCatalog.risks) {
      expect(
        entry.acceptable_in_envs,
        `risk '${entry.id}' should NOT carry acceptable_in_envs at MVP`,
      ).toBeUndefined();
    }
  });
});

describe('stripe risk-catalog — every `matches` pattern parses via parseSlice', () => {
  for (const entry of parsedCatalog.risks) {
    test(`'${entry.id}' parses`, () => {
      const raws: readonly string[] =
        typeof entry.matches === 'string' ? [entry.matches] : entry.matches;
      for (const raw of raws) {
        const parsed = parseSlice(raw);
        expect(parsed.provider).toBe('stripe');
      }
    });
  }
});

describe('stripe risk-catalog — prepareCatalog roundtrips OK', () => {
  test('prepareCatalog accepts the TS catalog', () => {
    const indexed = prepareCatalog(stripeRiskCatalog);
    expect(indexed.provider).toBe('stripe');
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

const FALLBACK_ID = 'stripe.uncategorized-write';

/** The 25 tools the Stripe classifier knows (10 reads + 15 writes). */
const STRIPE_TOOLS = [
  // reads
  'stripe__list_products',
  'stripe__list_prices',
  'stripe__list_customers',
  'stripe__retrieve_customer',
  'stripe__list_subscriptions',
  'stripe__list_invoices',
  'stripe__list_charges',
  'stripe__list_payment_intents',
  'stripe__get_balance',
  'stripe__list_events',
  // writes
  'stripe__create_product',
  'stripe__update_product',
  'stripe__create_price',
  'stripe__update_price',
  'stripe__create_coupon',
  'stripe__create_promotion_code',
  'stripe__create_subscription',
  'stripe__update_subscription',
  'stripe__cancel_subscription',
  'stripe__pause_subscription',
  'stripe__create_invoice',
  'stripe__finalize_invoice',
  'stripe__void_invoice',
  'stripe__create_refund',
  'stripe__create_webhook_endpoint',
] as const;

/** Synthesise argument shapes that exercise the classifier on each tool. */
function syntheticArgsForTool(tool: string): Array<Record<string, unknown>> {
  switch (tool) {
    case 'stripe__list_prices':
      return [{ product: 'prod_x' }];
    case 'stripe__retrieve_customer':
      return [{ id: 'cus_x' }];
    case 'stripe__list_subscriptions':
    case 'stripe__list_invoices':
      return [{ customer: 'cus_x' }];
    case 'stripe__update_product':
      return [{ id: 'prod_x' }];
    case 'stripe__create_price':
      return [{ product: 'prod_x' }];
    case 'stripe__update_price':
      return [{ id: 'price_x' }];
    case 'stripe__create_promotion_code':
      return [{ coupon: 'coup_x' }];
    case 'stripe__create_subscription':
    case 'stripe__create_invoice':
      return [{ customer: 'cus_x' }];
    case 'stripe__update_subscription':
    case 'stripe__cancel_subscription':
    case 'stripe__pause_subscription':
      return [{ id: 'sub_x' }];
    case 'stripe__finalize_invoice':
    case 'stripe__void_invoice':
      return [{ id: 'inv_x' }];
    case 'stripe__create_refund':
      return [{ charge: 'ch_x' }];
    default:
      return [{}];
  }
}

function slicesForTool(tool: string): Slice[] {
  const out: Slice[] = [];
  for (const args of syntheticArgsForTool(tool)) {
    const result = classifyStripeV4(tool, args, [binding]);
    if ('slices' in result) out.push(...result.slices);
  }
  return out;
}

function risksForTool(tool: string): string[] {
  const sl = slicesForTool(tool);
  const matched = new Set<string>();
  for (const slice of sl) {
    for (const { entry, pattern } of indexed) {
      if (matches(pattern, slice)) matched.add(entry.id);
    }
  }
  return [...matched];
}

describe('stripe risk-catalog — coverage lint (every tool matched by ≥1 non-fallback risk)', () => {
  for (const tool of STRIPE_TOOLS) {
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

describe('stripe risk-catalog — risksTouchedBy sanity checks', () => {
  const idx = prepareCatalog(stripeRiskCatalog);

  test('a product[X].R slice touches stripe.read-catalog', () => {
    const sl = parseSlice('stripe.account[acct_x].mode[live].product[prod_x].R');
    expect(risksTouchedBy(sl, idx)).toContain('stripe.read-catalog');
  });

  test('a customer[C].pii.R slice touches stripe.read-customer-pii', () => {
    const sl = parseSlice('stripe.account[acct_x].mode[live].customer[cus_x].pii.R');
    expect(risksTouchedBy(sl, idx)).toContain('stripe.read-customer-pii');
  });

  test('a balance.R slice touches stripe.read-balance', () => {
    const sl = parseSlice('stripe.account[acct_x].mode[live].balance.R');
    expect(risksTouchedBy(sl, idx)).toContain('stripe.read-balance');
  });

  test('a refund.W slice touches stripe.refund-create', () => {
    const sl = parseSlice(
      'stripe.account[acct_x].mode[live].payment-intent[pi_x].charge[ch_x].refund.W',
    );
    expect(risksTouchedBy(sl, idx)).toContain('stripe.refund-create');
  });

  test('a subscription[S].cancel.W slice touches stripe.subscription-cancel', () => {
    const sl = parseSlice(
      'stripe.account[acct_x].mode[live].customer[cus_x].subscription[sub_x].cancel.W',
    );
    expect(risksTouchedBy(sl, idx)).toContain('stripe.subscription-cancel');
  });

  test('a webhook-endpoint[W].secret.W slice touches stripe.mint-webhook-secret', () => {
    const sl = parseSlice('stripe.account[acct_x].mode[live].webhook-endpoint[we_x].secret.W');
    expect(risksTouchedBy(sl, idx)).toContain('stripe.mint-webhook-secret');
  });

  test('the fallback catches a wholly novel write slice', () => {
    const sl = parseSlice('stripe.account[acct_x].mode[live].connect-account[**].W');
    expect(risksTouchedBy(sl, idx)).toContain('stripe.uncategorized-write');
  });

  test('invoice-finalize and invoice-void are distinct', () => {
    const finalize = parseSlice(
      'stripe.account[acct_x].mode[live].customer[cus_x].invoice[inv_x].finalize.W',
    );
    const voidSlice = parseSlice(
      'stripe.account[acct_x].mode[live].customer[cus_x].invoice[inv_x].void.W',
    );
    expect(risksTouchedBy(finalize, idx)).toContain('stripe.invoice-finalize');
    expect(risksTouchedBy(finalize, idx)).not.toContain('stripe.invoice-void');
    expect(risksTouchedBy(voidSlice, idx)).toContain('stripe.invoice-void');
    expect(risksTouchedBy(voidSlice, idx)).not.toContain('stripe.invoice-finalize');
  });
});

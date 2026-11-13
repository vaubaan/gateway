/**
 * Catalog lint — the YAML catalog as loaded by the SDK (`loadCatalogFile`),
 * every `matches` slice pattern parsed, every Gmail tool the classifier
 * supports walked, and AT LEAST ONE non-fallback risk matching each tool's
 * emitted slices.
 *
 * Spec     : docs/spec/gateway-risk-model.md §4, §14.
 * Handbook : docs/handbook/providers/gmail.md.
 *
 * The lint fails the build (CI gate) on :
 *   - a catalog the SDK loader refuses (malformed YAML, unknown keys, bad
 *     ids, patterns of another provider, missing fallback, invalid macro-actions)
 *   - a `matches` pattern that does not parse via `parseSlice`
 *   - any tool whose emitted slices are only covered by the fallback risk
 *     (signals a hole in the catalog).
 */
import { describe, expect, test } from 'vitest';

import { matches, prepareCatalog, risksTouchedBy } from '@vaubaan/plugin-sdk/testing';
import { parseSlice, type Resource, type RiskEntry, type Slice } from '@vaubaan/plugin-sdk';

import { classifyGmail } from '../../src/classify.ts';
import { gmailCatalog } from '../../src/index.ts';

// The catalog as the gateway loads it at boot : the loader already enforced
// the structure, the slice grammar and the macro-actions.
const parsedCatalog = gmailCatalog.catalog;

const mailbox: Resource = {
  provider: 'gmail',
  ref: 'me@myorg.com',
  displayName: 'me@myorg.com',
  metadata: {
    internal_domains: ['myorg.com'],
    allowlist_addresses: ['partner@vendor.com'],
    allowlist_domains: ['vendor.com'],
    sensitive_labels: ['LEGAL', 'HR'],
    account_email: 'me@myorg.com',
  },
};

// Mirror the regex from shared/src/risk.ts so we can lint catalog ids
// without importing a private symbol (cf. risk-policy.ts:RISK_ID_REGEX).
const RISK_ID_REGEX =
  /^[a-z][a-z0-9]*(-[a-z][a-z0-9]*)*(\[[a-z][a-z0-9-]*\])?(\.[a-z][a-z0-9-]+)+$/;

describe('gmail risk-catalog — structural validation of the loaded catalog', () => {
  test('the loaded catalog has the expected shape', () => {
    expect(parsedCatalog.provider).toBe('gmail');
    expect(Array.isArray(parsedCatalog.risks)).toBe(true);
    // Expect 20 named risks + 1 fallback = 21 (5 added gmail.label-create, 8 the four sends).
    expect(parsedCatalog.risks.length).toBe(21);
  });

  test('every entry declares the required fields', () => {
    for (const entry of parsedCatalog.risks) {
      expect(typeof entry.id).toBe('string');
      expect(typeof entry.label).toBe('string');
      expect(typeof entry.reason).toBe('string');
      expect(typeof entry.matches === 'string' || Array.isArray(entry.matches)).toBe(true);
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

  test('every vector axis (five facts) carries a valid value', () => {
    const axes: Record<keyof RiskEntry['vector'], readonly string[]> = {
      reversibility: ['reversible', 'costly', 'irreversible'],
      blast: ['single', 'env', 'account', 'bulk'],
      data: ['metadata', 'data', 'secret', 'pii'],
      cost: ['free', 'moderate', 'unbounded'],
      visibility: ['internal', 'team', 'public'],
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
    const hasFallback = parsedCatalog.risks.some((e) => e.id.startsWith('gmail.uncategorized'));
    expect(hasFallback, 'catalog must declare a gmail.uncategorized-* fallback').toBe(true);
  });

  test('gmail.draft-to-zone-external-unbounded is never acceptable : kept, deprecated, in no macro-action, and refused by the classifier', () => {
    // "Never acceptable" cannot be written in the catalog (the loader
    // refuses `acceptable_in_envs: []`), and a mission may enumerate every
    // risk id. The guarantee is therefore the classifier's : the draft is
    // refused before any accepted risk is looked at.
    const entry = parsedCatalog.risks.find(
      (r) => r.id === 'gmail.draft-to-zone-external-unbounded',
    );
    expect(entry).toBeDefined();
    expect(entry!.deprecated).toBe(true);
    for (const action of parsedCatalog.macro_actions ?? []) {
      expect(action.entries.map((e) => e.risk_id)).not.toContain(entry!.id);
    }
    for (const to of [['stranger@evil.ru'], ['colleague@myorg.com', 'stranger@evil.ru']]) {
      const outcome = classifyGmail('gmail__create_draft', { to, subject: 's', body: 'b' }, [
        mailbox,
      ]);
      expect(outcome).toEqual({
        denied:
          'recipients outside the internal domains and the allowlist: not acceptable for a draft.',
      });
    }
  });

  test('gmail.bulk-label-write is kept, in the tidy macro-action, though no tool can touch it', () => {
    expect(parsedCatalog.risks.some((r) => r.id === 'gmail.bulk-label-write')).toBe(true);
    const tidy = parsedCatalog.macro_actions?.find((a) => a.id === 'tidy');
    expect(tidy?.entries.map((e) => e.risk_id)).toContain('gmail.bulk-label-write');
  });

  test('no entry declares a cap the door does not enforce (ADR scope-caps-amplification-axis)', () => {
    for (const id of ['gmail.bulk-read', 'gmail.read-from-zone-unknown']) {
      const entry = parsedCatalog.risks.find((r) => r.id === id);
      expect(entry, id).toBeDefined();
      expect(entry!.caps, id).toBeUndefined();
      expect(entry!.infra_limits, id).toBeUndefined();
    }
  });
});

describe('gmail risk-catalog — every `matches` pattern parses via parseSlice', () => {
  for (const entry of parsedCatalog.risks) {
    test(`'${entry.id}' parses`, () => {
      const raws: readonly string[] =
        typeof entry.matches === 'string' ? [entry.matches] : entry.matches;
      for (const raw of raws) {
        const parsed = parseSlice(raw);
        expect(parsed.provider).toBe('gmail');
      }
    });
  }
});

describe('gmail risk-catalog — prepareCatalog roundtrips OK', () => {
  test('prepareCatalog accepts the loaded catalog and the SDK indexed it identically', () => {
    const indexed = prepareCatalog(parsedCatalog);
    expect(indexed.provider).toBe('gmail');
    expect(indexed.entries.length).toBe(parsedCatalog.risks.length);
    expect(gmailCatalog.indexed.entries.length).toBe(indexed.entries.length);
  });
});

// ─── Build the parsed-pattern index once for lint usage ─────────────────────

const indexed = parsedCatalog.risks.flatMap((entry) =>
  (typeof entry.matches === 'string' ? [entry.matches] : entry.matches).map((raw) => ({
    entry,
    pattern: parseSlice(raw),
  })),
);

const FALLBACK_ID = 'gmail.uncategorized-write';

/** The 10 tools the Gmail classifier knows (9 official MCP tools + 1 synthetic). */
const GMAIL_TOOLS = [
  'gmail__search_threads',
  'gmail__get_thread',
  'gmail__get_attachment',
  'gmail__create_label',
  'gmail__list_drafts',
  'gmail__create_draft',
  'gmail__list_labels',
  'gmail__label_message',
  'gmail__unlabel_message',
  'gmail__label_thread',
  'gmail__unlabel_thread',
  'gmail__describe_zones',
] as const;

/** Synthesise argument shapes that exercise the zoning logic on each tool. */
function syntheticArgsForTool(tool: string): Array<Record<string, unknown>> {
  switch (tool) {
    case 'gmail__search_threads':
      return [
        // discriminating `from:` — fires from-zone[automated].
        { q: 'from:no-reply@vendor.com' },
        // discriminating `from:` internal.
        { q: 'from:colleague@myorg.com' },
        // unknown sender → from-zone[unknown].
        { q: 'from:random@random.io' },
        // not bounded by a positive from: → bulk-marker + from-zone[unknown].
        { q: 'is:unread' },
        { q: 'from:no-reply@vendor.com OR newer_than:3650d' },
        // sensitive label.
        { q: 'label:LEGAL' },
      ];
    case 'gmail__get_thread':
      return [{ id: '1a2b3c' }];
    case 'gmail__get_attachment':
      return [{ thread_id: 'aa01', message_id: 'bb02', part: '2' }];
    case 'gmail__create_label':
      return [{ name: 'Clients/2026' }, { name: 'Factures payées' }];
    case 'gmail__list_drafts':
      return [{}];
    case 'gmail__create_draft':
      return [
        { to: ['colleague@myorg.com'], subject: 's', body: 'b' },
        { to: ['me@myorg.com'], subject: 's', body: 'b' },
        { to: ['partner@vendor.com'], subject: 's', body: 'b' },
      ];
    case 'gmail__list_labels':
      return [{}];
    case 'gmail__label_message':
    case 'gmail__unlabel_message':
      return [{ thread_id: 'aa01', message_id: 'bb02', label: 'IMPORTANT' }];
    case 'gmail__label_thread':
    case 'gmail__unlabel_thread':
      return [{ thread_id: 'aa01', label: 'IMPORTANT' }];
    case 'gmail__describe_zones':
      return [{}];
    default:
      return [{}];
  }
}

function slicesForTool(tool: string): Slice[] {
  const out: Slice[] = [];
  for (const args of syntheticArgsForTool(tool)) {
    const result = classifyGmail(tool, args, [mailbox]);
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

describe('gmail risk-catalog — coverage lint (every tool matched by ≥1 non-fallback risk)', () => {
  for (const tool of GMAIL_TOOLS) {
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

describe('gmail risk-catalog — risksTouchedBy sanity checks', () => {
  const idx = gmailCatalog.indexed;

  test('a from-zone[automated].R slice touches gmail.read-from-zone-automated', () => {
    const sl = parseSlice('gmail.mailbox.from-zone[automated].R');
    expect(risksTouchedBy(sl, idx)).toContain('gmail.read-from-zone-automated');
  });

  test('a from-zone[internal].R slice touches gmail.read-from-zone-internal', () => {
    const sl = parseSlice('gmail.mailbox.from-zone[internal].R');
    expect(risksTouchedBy(sl, idx)).toContain('gmail.read-from-zone-internal');
  });

  test('a from-zone[unknown].R slice touches gmail.read-from-zone-unknown', () => {
    const sl = parseSlice('gmail.mailbox.from-zone[unknown].R');
    expect(risksTouchedBy(sl, idx)).toContain('gmail.read-from-zone-unknown');
  });

  test('a bulk-marker.R slice touches gmail.bulk-read', () => {
    const sl = parseSlice('gmail.mailbox.bulk-marker.R');
    expect(risksTouchedBy(sl, idx)).toContain('gmail.bulk-read');
  });

  test('a to-zone[external-unbounded].W slice touches gmail.draft-to-zone-external-unbounded', () => {
    const sl = parseSlice('gmail.mailbox.to-zone[external-unbounded].W');
    expect(risksTouchedBy(sl, idx)).toContain('gmail.draft-to-zone-external-unbounded');
  });

  test('a sensitive-label[LEGAL].R slice touches gmail.read-sensitive-label', () => {
    const sl = parseSlice('gmail.mailbox.sensitive-label[LEGAL].R');
    expect(risksTouchedBy(sl, idx)).toContain('gmail.read-sensitive-label');
  });

  test('a sensitive-label[..].W slice touches only the fallback', () => {
    for (const raw of [
      'gmail.mailbox.sensitive-label[LEGAL].W',
      'gmail.mailbox.sensitive-label[*].W',
    ]) {
      expect(risksTouchedBy(parseSlice(raw), idx)).toEqual(['gmail.uncategorized-write']);
    }
  });

  test('a label write on a system label touches gmail.label-write alone', () => {
    const outcome = classifyGmail('gmail__label_thread', { thread_id: 'aa01', label: 'STARRED' }, [
      mailbox,
    ]);
    if (!('slices' in outcome)) throw new Error('expected slices');
    expect(outcome.slices.flatMap((sl) => risksTouchedBy(sl, idx))).toEqual(['gmail.label-write']);
  });

  test('the fallback catches a wholly novel write slice', () => {
    const sl = parseSlice('gmail.mailbox.filter[**].W');
    // Note : the fallback `gmail.[**].W` matches anything `.W` rooted at gmail.
    expect(risksTouchedBy(sl, idx)).toContain('gmail.uncategorized-write');
  });
});

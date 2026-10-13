/**
 * Catalog invariants the SDK loader does not check for us : the bulk entries
 * declare only the rate ceiling the gateway enforces, the irreversible set is exact, only the exfiltration risk
 * is env-scoped, no preset offers the fallback, a deprecated id or an
 * env-scoped risk unqualified, and the patterns are disjoint : a slice touches
 * exactly one risk. Structure, patterns, presets and fallback are validated by
 * `loadCatalogFile` at import and by the kit in `plugin.test.ts`.
 */
import { describe, expect, test } from 'vitest';

import { parseSlice } from '@vaubaan/plugin-sdk';
import { isEnvScopedEntry, risksTouchedBy } from '@vaubaan/policy-engine';

import { resendCatalog, resendPlugin } from '../../src/index.ts';

const { catalog, indexed } = resendCatalog;
const touched = (raw: string) => risksTouchedBy(parseSlice(raw), indexed);

describe('resend risk-catalog — shape', () => {
  test('18 entries : 15 live named risks + 1 fallback + 2 deprecated ids, version 3', () => {
    expect(catalog.provider).toBe('resend');
    expect(catalog.catalog_version).toBe(3);
    expect(catalog.risks).toHaveLength(18);
    const fallback = catalog.risks.filter((r) => r.fallback);
    const deprecated = catalog.risks.filter((r) => r.deprecated);
    const liveNamed = catalog.risks.filter((r) => !r.fallback && !r.deprecated);
    expect(fallback.map((r) => r.id)).toEqual(['resend.uncategorized-write']);
    expect(deprecated.map((r) => [r.id, r.replaced_by])).toEqual([
      ['resend.read-audiences', 'resend.read-segments'],
      ['resend.audience-write', 'resend.segment-write'],
    ]);
    expect(liveNamed).toHaveLength(15);
    expect(liveNamed.length + fallback.length + deprecated.length).toBe(catalog.risks.length);
  });

  test('only send-email-external-unbounded is env-scoped, on staging and dev', () => {
    const scoped = catalog.risks.filter((r) => isEnvScopedEntry(r)).map((r) => r.id);
    expect(scoped).toEqual(['resend.send-email-external-unbounded']);
    expect(
      catalog.risks.find((r) => r.id === 'resend.send-email-external-unbounded')!
        .acceptable_in_envs,
    ).toEqual(['staging', 'dev']);
  });

  test('the bulk entries declare only the limit the gateway enforces', () => {
    // ADR scope-caps-not-enforced-in-v5-0 : no `caps`, and of `infra_limits` only the
    // ceiling on a mission's rate limit. The 100-email batch limit is the classifier's.
    const batch = catalog.risks.find((r) => r.id === 'resend.send-batch')!;
    expect(batch.caps).toBeUndefined();
    expect(batch.infra_limits).toBeUndefined();
    const broadcast = catalog.risks.find((r) => r.id === 'resend.broadcast-send')!;
    expect(broadcast.vector.cost).toBe('unbounded');
    expect(broadcast.caps).toBeUndefined();
    expect(broadcast.infra_limits).toEqual({ calls_per_minute_max: 10 });
  });

  test('the irreversible set is exact', () => {
    const ids = catalog.risks
      .filter((r) => r.vector.reversibility === 'irreversible')
      .map((r) => r.id)
      .sort();
    expect(ids).toEqual([
      'resend.broadcast-send',
      'resend.send-batch',
      'resend.send-email-external-unbounded',
    ]);
  });

  test('no preset offers the fallback, a deprecated id or an unqualified env-scoped risk', () => {
    const deprecated = new Set(catalog.risks.filter((r) => r.deprecated).map((r) => r.id));
    for (const preset of catalog.presets) {
      for (const entry of preset.entries) {
        expect(entry.risk_id, preset.id).not.toMatch(/uncategorized/);
        expect(deprecated.has(entry.risk_id), `${preset.id}: ${entry.risk_id}`).toBe(false);
        expect(entry.risk_id, preset.id).not.toBe('resend.send-email-external-unbounded');
      }
    }
  });

  test('the plugin serves the loaded catalog itself', () => {
    expect(resendPlugin.catalog).toBe(catalog);
  });
});

describe('resend risk-catalog — slices resolve to the expected risk, and only it', () => {
  const domain = 'resend.domain[notifications.acme.com]';
  const segment = 'resend.segment[seg_news]';

  test.each([
    ['resend.email[em_1].R', 'resend.read-email-status'],
    [`${domain}.R`, 'resend.read-domains'],
    [`${domain}.dns-record[*].R`, 'resend.read-domains'],
    [`${segment}.R`, 'resend.read-segments'],
    [`${segment}.member[*].R`, 'resend.read-segments'],
    ['resend.contact[ct_1].R', 'resend.read-segments'],
    [`${segment}.broadcast[brd_1].R`, 'resend.read-broadcasts'],
    [`${domain}.to-zone[internal].W`, 'resend.send-email-internal'],
    [`${domain}.to-zone[allowlist].W`, 'resend.send-email-allowlist'],
    [`${domain}.to-zone[external-unbounded].W`, 'resend.send-email-external-unbounded'],
    [`${domain}.recipient-count[batch].W`, 'resend.send-batch'],
    ['resend.segment.W', 'resend.segment-write'],
    [`${segment}.W`, 'resend.segment-write'],
    ['resend.contact.W', 'resend.contact-write'],
    ['resend.contact[ct_1].W', 'resend.contact-write'],
    [`${segment}.member[ct_1].W`, 'resend.contact-write'],
    [`${segment}.broadcast.W`, 'resend.broadcast-draft'],
    [`${segment}.broadcast[brd_1].W`, 'resend.broadcast-draft'],
    [`${segment}.broadcast[brd_1].send.W`, 'resend.broadcast-send'],
    [`${segment}.broadcast[brd_1].delete.W`, 'resend.broadcast-delete'],
    ['resend.domain.W', 'resend.domain-write'],
    [`${domain}.W`, 'resend.domain-write'],
    [`${domain}.dns-record[*].W`, 'resend.domain-verify'],
  ])('%s → %s', (raw, risk) => {
    // Exactly that risk : a slice a named risk matches never touches the fallback as well.
    expect(touched(raw)).toEqual([risk]);
  });

  test('reads touch no write risk', () => {
    expect(touched(`${segment}.broadcast[*].R`)).toEqual(['resend.read-broadcasts']);
  });

  test('batch is the only count marker with a risk — which is why a single send emits none', () => {
    // A marker without a named risk reaches the fallback ; the classifier never emits these two.
    expect(touched(`${domain}.recipient-count[single].W`)).toEqual(['resend.uncategorized-write']);
    expect(touched(`${domain}.recipient-count[multi].W`)).toEqual(['resend.uncategorized-write']);
    for (const to of [['alice@acme.com'], ['alice@acme.com', 'bob@acme.com']]) {
      const outcome = resendPlugin.classify(
        'resend__send_email',
        { from: 'bot@notifications.acme.com', to, subject: 's' },
        [
          {
            provider: 'resend',
            ref: 'notifications.acme.com',
            displayName: 'notifications.acme.com',
            metadata: { kind: 'domain' },
          },
        ],
      );
      if ('denied' in outcome) throw new Error(outcome.denied);
      expect(outcome.slices.flatMap((s) => risksTouchedBy(s, indexed))).toEqual([
        'resend.send-email-external-unbounded',
      ]);
    }
  });

  test('a novel write falls into the fallback only', () => {
    expect(touched('resend.webhook[wh_1].W')).toEqual(['resend.uncategorized-write']);
    expect(touched('resend.api-key.W')).toEqual(['resend.uncategorized-write']);
  });

  test('account-rooted slices match nothing but the fallback', () => {
    expect(touched('resend.account[prod-email].to-zone[internal].W')).toEqual([
      'resend.uncategorized-write',
    ]);
    expect(touched('resend.account[prod-email].domain[*].R')).toEqual([]);
  });
});

/**
 * Catalog invariants the SDK loader does not check for us : the bulk entries
 * keep their caps, the irreversible set is exact, only the exfiltration risk
 * is env-scoped, no preset offers the fallback, a deprecated id or an
 * env-scoped risk unqualified, and the patterns are disjoint where the version 1
 * ones overlapped. Structure, patterns, presets and fallback are validated by
 * `loadCatalogFile` at import and by the kit in `plugin.test.ts`.
 */
import { describe, expect, test } from 'vitest';

import { parseSlice } from '@vaubaan/plugin-sdk';
import { isEnvScopedEntry, risksTouchedBy } from '@vaubaan/policy-engine';

import { resendCatalog, resendPlugin } from '../../src/index.ts';

const { catalog, indexed } = resendCatalog;
const touched = (raw: string) => risksTouchedBy(parseSlice(raw), indexed);

describe('resend risk-catalog — shape', () => {
  test('16 live risks + 2 deprecated version 1 ids, one fallback, version 2', () => {
    expect(catalog.provider).toBe('resend');
    expect(catalog.catalog_version).toBe(2);
    expect(catalog.risks).toHaveLength(18);
    expect(catalog.risks.filter((r) => r.deprecated).map((r) => [r.id, r.replaced_by])).toEqual([
      ['resend.read-audiences', 'resend.read-segments'],
      ['resend.audience-write', 'resend.segment-write'],
    ]);
    expect(catalog.risks.filter((r) => r.id.startsWith('resend.uncategorized'))).toHaveLength(1);
  });

  test('only send-email-external-unbounded is env-scoped, on staging and dev', () => {
    const scoped = catalog.risks.filter((r) => isEnvScopedEntry(r)).map((r) => r.id);
    expect(scoped).toEqual(['resend.send-email-external-unbounded']);
    expect(
      catalog.risks.find((r) => r.id === 'resend.send-email-external-unbounded')!
        .acceptable_in_envs,
    ).toEqual(['staging', 'dev']);
  });

  test('the bulk entries carry caps and infra limits', () => {
    const batch = catalog.risks.find((r) => r.id === 'resend.send-batch')!;
    expect(batch.caps).toEqual({
      items_per_call_max: 100,
      calls_per_minute_max: 5,
      calls_per_session_max: 50,
    });
    expect(batch.infra_limits).toEqual({ items_per_call_max: 100 });
    const broadcast = catalog.risks.find((r) => r.id === 'resend.broadcast-send')!;
    expect(broadcast.vector.cost).toBe('unbounded');
    expect(broadcast.caps).toEqual({ calls_per_minute_max: 1, calls_per_session_max: 5 });
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
    const risks = touched(raw);
    expect(risks).toContain(risk);
    // Exactly one named risk ; writes also touch the fallback by construction.
    expect(risks.filter((id) => !id.endsWith('.uncategorized-write'))).toEqual([risk]);
  });

  test('reads touch no write risk ; single and multi sends touch no bulk risk', () => {
    expect(touched(`${segment}.broadcast[*].R`)).toEqual(['resend.read-broadcasts']);
    expect(touched(`${domain}.recipient-count[single].W`)).toEqual(['resend.uncategorized-write']);
    expect(touched(`${domain}.recipient-count[multi].W`)).toEqual(['resend.uncategorized-write']);
  });

  test('a novel write falls into the fallback only', () => {
    expect(touched('resend.webhook[wh_1].W')).toEqual(['resend.uncategorized-write']);
    expect(touched('resend.api-key.W')).toEqual(['resend.uncategorized-write']);
  });

  test('the version 1 account-rooted slices match nothing but the fallback any more', () => {
    expect(touched('resend.account[prod-email].to-zone[internal].W')).toEqual([
      'resend.uncategorized-write',
    ]);
    expect(touched('resend.account[prod-email].domain[*].R')).toEqual([]);
  });
});

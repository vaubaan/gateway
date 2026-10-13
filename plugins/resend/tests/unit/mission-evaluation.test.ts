/**
 * The whole decision, not the classifier alone : real catalog, real
 * classifier, and the engine's `evaluateCall` with the resolver the gateway
 * builds (`envResolverFor(mission resources, plugin.envOf)` — the exact
 * composition of `evaluateCallForToken` in `@vaubaan/gateway-core`).
 *
 * Pins two things the per-slice tests cannot see :
 *   - a send to an external-unbounded recipient is refused on a domain
 *     labelled outside `acceptable_in_envs`, or not labelled at all, whatever
 *     else the mission accepted ;
 *   - what each shipped preset allows and refuses, call by call — no preset
 *     needs the fallback to do what its description says.
 */
import { describe, expect, test } from 'vitest';

import type { ProviderPlugin, Resource, RiskId } from '@vaubaan/plugin-sdk';
import { envResolverFor, evaluateCall } from '@vaubaan/policy-engine';

import { resendCatalog, resendPlugin } from '../../src/index.ts';

const { catalog, indexed } = resendCatalog;
/** The contract the gateway sees : `envOf` is optional there, and this plugin declares none. */
const plugin: ProviderPlugin = resendPlugin;

const domain = (ref: string, env?: string): Resource => ({
  provider: 'resend',
  ref,
  displayName: ref,
  ...(env === undefined ? {} : { env }),
  metadata: {
    kind: 'domain',
    domain_id: `dom_${ref}`,
    internal_domains: ['acme.com'],
    allowlist_domains: ['partner.com'],
    allowlist_addresses: [],
  },
});
const segment = (ref: string, env: string): Resource => ({
  provider: 'resend',
  ref,
  displayName: ref,
  env,
  metadata: { kind: 'segment', segment_id: ref },
});

const prod = domain('notifications.acme.com', 'prod');
const staging = domain('staging.acme.dev', 'staging');
const dev = domain('dev.acme.dev', 'dev');
const unlabelled = domain('unlabelled.acme.com');
const newsletter = segment('seg_news', 'prod');
const mission: readonly Resource[] = [prod, staging, dev, unlabelled, newsletter];

const EXTERNAL = 'resend.send-email-external-unbounded';
const qualified = (env: string): RiskId => `resend[${env}].send-email-external-unbounded`;

/** Every id a mission could conceivably hold : the whole catalog, fallback included, plus every qualified form. */
const EVERYTHING: readonly RiskId[] = [
  ...catalog.risks.map((r) => r.id),
  qualified('prod'),
  qualified('staging'),
  qualified('dev'),
];

type Verdict =
  | { readonly kind: 'allow'; readonly touched: readonly RiskId[] }
  | { readonly kind: 'deny'; readonly missing: readonly RiskId[] }
  | { readonly kind: 'classify-denied'; readonly reason: string };

function evaluate(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  accepted: readonly RiskId[],
  resources: readonly Resource[] = mission,
): Verdict {
  const outcome = plugin.classify(tool, args, resources);
  if ('denied' in outcome) return { kind: 'classify-denied', reason: outcome.denied };
  const decision = evaluateCall({
    executed_slices: outcome.slices,
    token_accepted_risks: new Set(accepted),
    catalog: indexed,
    envResolver: envResolverFor(resources, plugin.envOf?.bind(plugin)),
  });
  return decision.outcome === 'allowed'
    ? { kind: 'allow', touched: decision.risks_touched }
    : { kind: 'deny', missing: decision.missing_risks };
}

const email = (from: Resource, to: string) => ({ from: `bot@${from.ref}`, to: [to], subject: 's' });
const send = (from: Resource, to: string, accepted: readonly RiskId[]) =>
  evaluate('resend__send_email', email(from, to), accepted);
const batch = (from: Resource, to: string, accepted: readonly RiskId[]) =>
  evaluate('resend__send_batch_emails', { emails: [email(from, to)] }, accepted);

describe('resend — an external-unbounded send outside staging / dev is refused', () => {
  test('from a prod domain : refused whatever the mission accepted', () => {
    expect(send(prod, 'x@evil.com', EVERYTHING)).toEqual({
      kind: 'deny',
      missing: [qualified('prod')],
    });
    expect(batch(prod, 'x@evil.com', EVERYTHING)).toEqual({
      kind: 'deny',
      missing: [qualified('prod')],
    });
  });

  test('from an unlabelled domain : refused whatever the mission accepted', () => {
    expect(send(unlabelled, 'x@evil.com', EVERYTHING)).toEqual({
      kind: 'deny',
      missing: [EXTERNAL],
    });
    expect(batch(unlabelled, 'x@evil.com', EVERYTHING)).toEqual({
      kind: 'deny',
      missing: [EXTERNAL],
    });
  });

  test('the co-touched risks alone never carry it : send-batch, the fallback, the other zones', () => {
    const others = catalog.risks.map((r) => r.id).filter((id) => id !== EXTERNAL);
    for (const from of [prod, unlabelled, staging, dev]) {
      expect(send(from, 'x@evil.com', others).kind, from.ref).toBe('deny');
      expect(batch(from, 'x@evil.com', others).kind, from.ref).toBe('deny');
    }
  });

  test('one external recipient among internal ones is enough (to, cc, bcc)', () => {
    for (const field of ['to', 'cc', 'bcc'] as const) {
      const args = { ...email(prod, 'alice@acme.com'), [field]: ['alice@acme.com', 'x@evil.com'] };
      expect(evaluate('resend__send_email', args, EVERYTHING), field).toEqual({
        kind: 'deny',
        missing: [qualified('prod')],
      });
    }
  });

  test('a batch mixing a staging and a prod external send is refused as a whole', () => {
    const emails = [email(staging, 'x@evil.com'), email(prod, 'y@evil.com')];
    expect(evaluate('resend__send_batch_emails', { emails }, EVERYTHING)).toEqual({
      kind: 'deny',
      missing: [qualified('prod')],
    });
  });

  test('on a staging or dev domain : allowed when its qualified risk is accepted, refused otherwise', () => {
    for (const from of [staging, dev]) {
      const own = qualified(from.env!);
      expect(send(from, 'x@evil.com', [own])).toEqual({ kind: 'allow', touched: [own] });
      expect(send(from, 'x@evil.com', [])).toEqual({ kind: 'deny', missing: [own] });
      // The unqualified id, or another environment's, is not this one.
      expect(send(from, 'x@evil.com', [EXTERNAL, qualified('prod')]).kind).toBe('deny');
      expect(batch(from, 'x@evil.com', [own, 'resend.send-batch'])).toEqual({
        kind: 'allow',
        touched: [own, 'resend.send-batch'],
      });
      expect(batch(from, 'x@evil.com', ['resend.send-batch'])).toEqual({
        kind: 'deny',
        missing: [own],
      });
    }
    expect(send(staging, 'x@evil.com', [qualified('dev')]).kind).toBe('deny');
  });

  test('internal and allow-listed sends are not env-scoped : a prod or unlabelled domain sends them', () => {
    expect(send(prod, 'alice@acme.com', ['resend.send-email-internal'])).toEqual({
      kind: 'allow',
      touched: ['resend.send-email-internal'],
    });
    expect(send(unlabelled, 'bob@partner.com', ['resend.send-email-allowlist'])).toEqual({
      kind: 'allow',
      touched: ['resend.send-email-allowlist'],
    });
  });

  test('the catalog still scopes exactly that risk to staging and dev', () => {
    const entry = catalog.risks.find((r) => r.id === EXTERNAL)!;
    expect(entry.acceptable_in_envs).toEqual(['staging', 'dev']);
  });
});

describe('resend — what each shipped preset allows and refuses', () => {
  const presetRisks = (id: string): readonly RiskId[] =>
    catalog.presets.find((p) => p.id === id)!.entries.map((e) => e.risk_id);
  const seg = { segment_id: 'seg_news' };

  /** One representative call per capability ; the same list is judged under every preset. */
  const CALLS: Readonly<Record<string, readonly [string, Readonly<Record<string, unknown>>]>> = {
    'read email status': ['resend__get_email', { id: 'em_1' }],
    'read domains': ['resend__get_domain', { domain: prod.ref }],
    'read broadcasts': ['resend__get_broadcast', { ...seg, id: 'brd_1' }],
    'read contacts': ['resend__list_contacts', {}],
    'send internal, one recipient': ['resend__send_email', email(prod, 'alice@acme.com')],
    'send internal, several recipients': [
      'resend__send_email',
      { ...email(prod, 'alice@acme.com'), cc: ['bob@acme.com'] },
    ],
    'send allow-listed': ['resend__send_email', email(prod, 'bob@partner.com')],
    'send external from prod': ['resend__send_email', email(prod, 'x@evil.com')],
    'send external from staging': ['resend__send_email', email(staging, 'x@evil.com')],
    'batch internal': [
      'resend__send_batch_emails',
      { emails: [email(prod, 'alice@acme.com'), email(prod, 'bob@partner.com')] },
    ],
    'batch external from staging': [
      'resend__send_batch_emails',
      { emails: [email(staging, 'x@evil.com')] },
    ],
    'write a contact': ['resend__create_contact', { email: 'new@example.com', ...seg }],
    'delete a segment': ['resend__delete_segment', seg],
    'draft a broadcast': [
      'resend__create_broadcast',
      { ...seg, from: `news@${prod.ref}`, subject: 'News' },
    ],
    'send a broadcast': ['resend__send_broadcast', { ...seg, id: 'brd_1' }],
    'delete a broadcast': ['resend__delete_broadcast', { ...seg, id: 'brd_1' }],
    'verify a domain': ['resend__verify_domain', { domain: prod.ref }],
    'update a domain': ['resend__update_domain', { domain: prod.ref, tls: 'enforced' }],
    'create a domain': ['resend__create_domain', { name: 'mail.acme.com' }],
  };

  const READS = ['read email status', 'read domains', 'read broadcasts'];
  const ALLOWED: Readonly<Record<string, readonly string[]>> = {
    'read-only': READS,
    developer: [
      ...READS,
      'send internal, one recipient',
      'send internal, several recipients',
      'send allow-listed',
    ],
    'marketing-operator': [
      ...READS,
      'read contacts',
      'send internal, one recipient',
      'send internal, several recipients',
      'send allow-listed',
      'batch internal',
      'write a contact',
      'delete a segment',
      'draft a broadcast',
      'send a broadcast',
      'delete a broadcast',
    ],
    'domain-admin': ['read domains', 'verify a domain', 'update a domain', 'create a domain'],
  };

  test('the table covers every shipped preset', () => {
    expect(catalog.presets.map((p) => p.id).sort()).toEqual(Object.keys(ALLOWED).sort());
  });

  test.each(Object.keys(ALLOWED))('%s', (preset) => {
    const accepted = presetRisks(preset);
    const allowed = Object.entries(CALLS)
      .filter(([, [tool, args]]) => evaluate(tool, args, accepted).kind === 'allow')
      .map(([label]) => label);
    expect(allowed).toEqual(Object.keys(CALLS).filter((label) => ALLOWED[preset]!.includes(label)));
    // Nothing is refused by the classifier : every refusal above is a risk the preset lacks.
    for (const [label, [tool, args]] of Object.entries(CALLS)) {
      expect(evaluate(tool, args, accepted).kind, label).not.toBe('classify-denied');
    }
  });

  test('no preset can send to an external-unbounded recipient, on any domain', () => {
    for (const preset of catalog.presets) {
      const accepted = preset.entries.map((e) => e.risk_id);
      for (const from of [prod, staging, dev, unlabelled]) {
        expect(send(from, 'x@evil.com', accepted).kind, `${preset.id} ${from.ref}`).toBe('deny');
        expect(batch(from, 'x@evil.com', accepted).kind, `${preset.id} ${from.ref}`).toBe('deny');
      }
    }
  });

  test('a single send touches its zone risk and nothing else — never the fallback', () => {
    expect(send(prod, 'alice@acme.com', EVERYTHING)).toEqual({
      kind: 'allow',
      touched: ['resend.send-email-internal'],
    });
    expect(
      evaluate(
        'resend__send_email',
        { ...email(prod, 'alice@acme.com'), cc: ['bob@partner.com'] },
        EVERYTHING,
      ),
    ).toEqual({ kind: 'allow', touched: ['resend.send-email-allowlist'] });
  });
});

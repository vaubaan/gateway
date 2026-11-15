/**
 * Mandatory suite of the `gmail` plugin : the SDK kit (tools, catalog
 * coverage, identifiers), the credential spec (an app password over IMAP),
 * `verify` and `discoverResources` against a fake IMAP transport, resource
 * selection and the macro-actions. No network : the transport is `fakeGmail()`.
 * Tool by tool, execution is in `execute.test.ts`.
 */
import { describe, expect, test } from 'vitest';

import {
  CredentialKindMismatch,
  UpstreamAuthError,
  definePlugin,
  serializeSlice,
  type ApiKeySecret,
  type AccountContext,
  type ExecuteContext,
  type Resource,
} from '@vaubaan/plugin-sdk';
import {
  assertCatalogCoverage,
  assertIdentifiersRefused,
  assertNoWildcard,
  assertPluginWellFormed,
  assertSlicesOnDataModel,
  guideText,
  mockFetch,
  policyFromMacroActions,
  type ToolSamples,
} from '@vaubaan/plugin-sdk/testing';

import {
  GMAIL_APP_PASSWORDS_URL,
  GMAIL_CLASSIFIED_TOOLS,
  createGmailPlugin,
  gmailClassifiedToolDeclarations,
  gmailPlugin,
  normalizeAppPassword,
  readMailboxMetadata,
} from '../../src/index.ts';
import {
  EXAMPLE_MAILBOX as mailbox,
  EXAMPLE_OTHER_MAILBOX as otherMailbox,
  THREAD,
} from '../../src/examples.ts';
import { fakeGmail, fakeSmtp } from './fake-imap.ts';

const githubRepo: Resource = { service: 'github', ref: 'acme/app', displayName: 'acme/app' };

const secret = (fields: Record<string, string> = {}): ApiKeySecret => ({
  kind: 'api-key',
  fields: { email: 'Me@MyOrg.com', app_password: 'abcd efgh ijkl mnop', ...fields },
  metadata: {},
});

const connCtx = (overrides: Partial<AccountContext> = {}): AccountContext => ({
  credential: secret(),
  fetch: mockFetch([]),
  ...overrides,
});

const execCtx = (resources: readonly Resource[] = [mailbox]): ExecuteContext => ({
  ...connCtx(),
  resources,
});

/** The plugin's own samples (`src/examples.ts`), on `me@myorg.com`. */
const SAMPLES: ToolSamples = gmailPlugin.examples ?? {};

// ─────────────────────────────────────────────────────────────────────────────
// SDK kit
// ─────────────────────────────────────────────────────────────────────────────

describe('gmail plugin — SDK kit', () => {
  test('well-formed, no wildcard', () => {
    assertPluginWellFormed(gmailPlugin);
    assertNoWildcard(gmailPlugin);
  });

  test('no longer says experimental, and exposes its fourteen tools', () => {
    expect(gmailPlugin.description).not.toMatch(/experimental/i);
    expect(gmailPlugin.summary).not.toMatch(/experimental/i);
    expect(gmailPlugin.description).toMatch(/send messages and drafts over SMTP/);
    const names = gmailPlugin.tools.map((t) => t.name);
    expect(names).toEqual([...GMAIL_CLASSIFIED_TOOLS]);
    expect(gmailPlugin.tools).toBe(gmailClassifiedToolDeclarations);
    expect(names).toHaveLength(14);
    // The two sends, over SMTP ; no other tool sends.
    expect(names.filter((n) => /send/.test(n))).toEqual([
      'gmail__send_message',
      'gmail__send_draft',
    ]);
    for (const t of gmailPlugin.tools) {
      expect(t.name.startsWith('gmail__')).toBe(true);
      expect(t.inputSchema.type).toBe('object');
    }
  });

  test('every tool maps to slices the catalog covers', () => {
    const report = assertCatalogCoverage(gmailPlugin);
    // Paths only : this model's cardinalities count instances, not how a slice names them.
    assertSlicesOnDataModel(gmailPlugin, SAMPLES, { resources: [mailbox], cardinalities: false });
    expect(report.toolsChecked).toBe(14);
    // Untouched on purpose : the classifier refuses a draft to an external
    // recipient, and no modelled tool emits a bulk write. Every write of
    // these samples is covered by a specific entry, so the fallback is never
    // the only match — a macro-action can therefore grant drafts and labels.
    expect(report.risksUntouched).toEqual([
      'gmail.draft-to-zone-external-unbounded',
      'gmail.bulk-label-write',
    ]);
    expect(report.fallbackHits).toEqual([]);
  });

  test('a write on a sensitive label reaches the fallback, which no macro-action offers', () => {
    const exposed = definePlugin({
      ...gmailPlugin,
      tools: gmailClassifiedToolDeclarations.filter((t) => t.name === 'gmail__unlabel_thread'),
      toolTitles: { gmail__unlabel_thread: 'Remove a label from a thread' },
      examples: {
        gmail__unlabel_thread: [
          { args: { thread_id: THREAD, label: 'LEGAL' }, resources: [mailbox] },
        ],
      },
    });
    const report = assertCatalogCoverage(exposed);
    expect(report.fallbackHits).toHaveLength(1);
  });

  test('a hostile identifier is refused by classify and reaches no IMAP or SMTP command', async () => {
    const transport = fakeGmail();
    const smtp = fakeSmtp();
    const report = await assertIdentifiersRefused(createGmailPlugin({ transport, smtp }), SAMPLES, {
      resources: [mailbox],
      context: (_fetch, resources) => execCtx(resources),
      elsewhere: {
        reset: () => {
          transport.calls.splice(0);
          smtp.sent.splice(0);
        },
        sent: () => [
          ...transport.calls.map((c) => ({ method: 'IMAP', url: `imap:${c.op}` })),
          ...smtp.sent.map(() => ({ method: 'SMTP', url: 'smtp:send' })),
        ],
      },
      pathIdentifiers: { none: 'the upstream is IMAP, not an HTTP request' },
    });
    expect(report.toolsChecked).toBe(14);
    expect(report.pathIdentifiers).toEqual([]);
    expect(report.refusedByClassify).toBeGreaterThan(0);
    expect(report.nothingSent).toBeGreaterThanOrEqual(report.refusedByClassify);
  });
});
// ─────────────────────────────────────────────────────────────────────────────
// Resource selection and metadata
// ─────────────────────────────────────────────────────────────────────────────

describe('gmail classify — mailbox selection', () => {
  test('exactly one gmail resource is required ; other services are ignored', () => {
    expect(gmailPlugin.classify('gmail__list_labels', {}, [])).toEqual({
      denied: 'no gmail mailbox is a resource of this mission.',
    });
    expect(gmailPlugin.classify('gmail__list_labels', {}, [githubRepo])).toEqual({
      denied: 'no gmail mailbox is a resource of this mission.',
    });
    expect(gmailPlugin.classify('gmail__list_labels', {}, [mailbox, otherMailbox])).toEqual({
      denied: 'ambiguous gmail target: this mission has several mailboxes.',
    });
    expect(gmailPlugin.classify('gmail__list_labels', {}, [githubRepo, mailbox])).toEqual({
      slices: [
        {
          service: 'gmail',
          action: 'R',
          path: [
            { kind: 'name', value: 'mailbox' },
            { kind: 'name', value: 'label' },
            { kind: 'ident', value: '*' },
          ],
        },
      ],
    });
  });

  test('unknown tool is denied even with a mailbox', () => {
    expect(gmailPlugin.classify('gmail__delete_message', {}, [mailbox])).toEqual({
      denied: "unknown gmail tool 'gmail__delete_message'.",
    });
  });

  test('metadata : lists default to empty, account_email falls back to the ref, everything lower-cased', () => {
    expect(readMailboxMetadata(otherMailbox)).toEqual({
      internal_domains: [],
      allowlist_addresses: [],
      allowlist_domains: [],
      sensitive_labels: [],
      account_email: 'support@myorg.com',
    });
    const md = readMailboxMetadata({
      service: 'gmail',
      ref: 'mailbox-1',
      displayName: 'x',
      metadata: { internal_domains: ['MyOrg.com', 42], account_email: 'Me@MyOrg.com' },
    });
    expect(md.internal_domains).toEqual(['myorg.com']);
    expect(md.account_email).toBe('me@myorg.com');
    expect(
      readMailboxMetadata({ service: 'gmail', ref: 'mailbox-1', displayName: 'x' }),
    ).toMatchObject({ account_email: null });
  });

  test('without zoning metadata every sender is unknown and every recipient external (refused)', () => {
    const search = gmailPlugin.classify(
      'gmail__search_threads',
      { q: 'from:colleague@myorg.com' },
      [otherMailbox],
    );
    expect('slices' in search && search.slices.map(serializeSlice)).toContain(
      'gmail.mailbox.from-zone[unknown].R',
    );
    const draft = gmailPlugin.classify(
      'gmail__create_draft',
      { to: ['colleague@myorg.com'], subject: 's', body: 'b' },
      [otherMailbox],
    );
    expect(draft).toEqual({
      denied:
        'recipients outside the internal domains and the allowlist: not acceptable for a draft.',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Credential spec
// ─────────────────────────────────────────────────────────────────────────────

describe('gmail credential spec — an app password over IMAP', () => {
  const spec = gmailPlugin.credential;

  test('api-key : the address and the secret app password, a guide, a verify', () => {
    expect(spec.kind).toBe('api-key');
    if (spec.kind !== 'api-key') return;
    expect(spec.fields.map((f) => [f.name, f.secret])).toEqual([
      ['email', false],
      ['app_password', true],
    ]);
    expect(spec.createUrl).toBe(GMAIL_APP_PASSWORDS_URL);
    expect(spec.label).toBe('app password');
    expect(typeof spec.verify).toBe('function');
  });

  test('the guide : 2-Step Verification, the app passwords page, the name, Workspace and IMAP caveats ; no permission, no expiry', () => {
    if (spec.kind !== 'api-key' || !spec.guide) throw new Error('guide expected');
    const text = guideText(spec.guide);
    expect(text).toMatch(/2-Step Verification/);
    expect(text).toContain('https://myaccount.google.com/apppasswords');
    expect(text).toContain('"Vaubaan Gateway"');
    expect(text).toMatch(/Workspace administrator/);
    expect(text).toMatch(/IMAP is on/);
    expect(text).toMatch(/no scopes/);
    expect(spec.guide.permissions).toEqual([]);
    expect(spec.guide.expiry.kind).toBe('none');
  });

  test('the field patterns accept the password with or without Google’s spaces', () => {
    if (spec.kind !== 'api-key') throw new Error('api-key expected');
    // nosemgrep: detect-non-literal-regexp -- the plugin's own field declaration
    const pattern = new RegExp(spec.fields[1]!.pattern!);
    expect(pattern.test('abcd efgh ijkl mnop')).toBe(true);
    expect(pattern.test('abcdefghijklmnop')).toBe(true);
    expect(pattern.test('abcd efgh ijkl')).toBe(false);
    expect(pattern.test('abcd-efgh-ijkl-mnop')).toBe(false);
  });

  test('normalizeAppPassword strips spaces and wants exactly 16 letters', () => {
    expect(normalizeAppPassword('abcd efgh ijkl mnop')).toBe('abcdefghijklmnop');
    expect(normalizeAppPassword(' ABCD\tEFGH ijkl mnop ')).toBe('ABCDEFGHijklmnop');
    expect(normalizeAppPassword('abcd efgh ijkl mno')).toBeNull();
    expect(normalizeAppPassword('abcd efgh ijkl mnop q')).toBeNull();
    expect(normalizeAppPassword('abcd efgh ijkl mn0p')).toBeNull();
    expect(normalizeAppPassword(42)).toBeNull();
  });

  test('no refresh, no revoke hook : the owner deletes the app password at Google', () => {
    expect(gmailPlugin.refresh).toBeUndefined();
    expect(gmailPlugin.revoke).toBeUndefined();
    expect(gmailPlugin.manualRevocation).toContain(GMAIL_APP_PASSWORDS_URL);
    expect(gmailPlugin.manualRevocation).toContain('Vaubaan Gateway');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// verify and discoverResources
// ─────────────────────────────────────────────────────────────────────────────

describe('gmail verify and discoverResources', () => {
  test('verify signs in with the lower-cased address and the password without spaces, and names the account', async () => {
    const transport = fakeGmail();
    const plugin = createGmailPlugin({ transport });
    if (plugin.credential.kind !== 'api-key' || !plugin.credential.verify) throw new Error();
    const check = await plugin.credential.verify(connCtx());
    expect(check).toEqual({ account: 'me@myorg.com', expiresAt: null });
    const session = transport.calls[0];
    expect(session).toMatchObject({
      op: 'session',
      account: { email: 'me@myorg.com', appPassword: 'abcdefghijklmnop' },
    });
    // Signs in and finds the two folders every tool needs, by special use.
    expect(transport.ops()).toEqual(['mailboxes', 'mailboxes']);
  });

  test('a refused sign-in is an UpstreamAuthError : nothing is stored, the account needs a new password', async () => {
    const transport = fakeGmail();
    transport.refuseSignIn = true;
    const plugin = createGmailPlugin({ transport });
    if (plugin.credential.kind !== 'api-key' || !plugin.credential.verify) throw new Error();
    await expect(plugin.credential.verify(connCtx())).rejects.toBeInstanceOf(UpstreamAuthError);
    await expect(plugin.discoverResources(connCtx())).rejects.toBeInstanceOf(UpstreamAuthError);
  });

  test('a mailbox whose All Mail is hidden from IMAP is refused with the setting to change', async () => {
    const transport = fakeGmail();
    transport.folders = transport.folders.filter((f) => f.specialUse !== '\\All');
    const plugin = createGmailPlugin({ transport });
    await expect(plugin.discoverResources(connCtx())).rejects.toThrow(/Show in IMAP/);
  });

  test('discovery returns the mailbox as the single resource, ref and account_email lower-cased', async () => {
    const plugin = createGmailPlugin({ transport: fakeGmail() });
    expect(await plugin.discoverResources(connCtx())).toEqual([
      {
        service: 'gmail',
        ref: 'me@myorg.com',
        displayName: 'me@myorg.com',
        metadata: { account_email: 'me@myorg.com' },
      },
    ]);
  });

  test('an OAuth credential of an earlier build is refused before any IMAP command', async () => {
    const transport = fakeGmail();
    const plugin = createGmailPlugin({ transport });
    const oauth = {
      kind: 'oauth2' as const,
      accessToken: 'ya29.access',
      refreshToken: '1//refresh',
      expiresAt: null,
      scopes: [],
      metadata: {},
    };
    await expect(plugin.discoverResources(connCtx({ credential: oauth }))).rejects.toBeInstanceOf(
      CredentialKindMismatch,
    );
    expect(transport.calls).toEqual([]);
  });

  test('a malformed stored field is a host bug, not a service error', async () => {
    const plugin = createGmailPlugin({ transport: fakeGmail() });
    const bad = connCtx({ credential: secret({ app_password: 'short' }) });
    const err = await plugin.discoverResources(bad).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UpstreamAuthError);
  });

  test('the caller’s signal and a session deadline reach the transport', async () => {
    const transport = fakeGmail();
    const controller = new AbortController();
    await createGmailPlugin({ transport }).discoverResources(
      connCtx({ signal: controller.signal }),
    );
    expect(transport.calls[0]).toMatchObject({
      op: 'session',
      options: { signal: controller.signal, timeoutMs: 60_000 },
    });
  });
});
// ─────────────────────────────────────────────────────────────────────────────
// Macro-actions
// ─────────────────────────────────────────────────────────────────────────────

describe('gmail macro-actions', () => {
  const riskOf = (riskId: string) => gmailPlugin.catalog.risks.find((r) => r.id === riskId)!;
  const isWrite = (riskId: string) => String(riskOf(riskId).matches).endsWith('.W');
  const gates = (trustLevels: Parameters<typeof policyFromMacroActions>[1]) =>
    Object.fromEntries(
      policyFromMacroActions(gmailPlugin, trustLevels).map((l) => [l.risk_id, l.gate]),
    );

  test('ships search, draft, send and tidy', () => {
    expect(gmailPlugin.catalog.macro_actions?.map((a) => a.id)).toEqual([
      'search',
      'draft',
      'send',
      'tidy',
    ]);
    expect(gmailPlugin.catalog.catalog_version).toBe(10);
  });

  test('search at Careful : reads only, every sender zone freely ; bulk and sensitive reads ask first', () => {
    const g = gates({ search: 'careful' });
    expect(Object.keys(g).some(isWrite)).toBe(false);
    expect(g['gmail.read-from-zone-unknown']).toBe('auto');
    expect(g['gmail.bulk-read']).toBe('approval');
    expect(g['gmail.read-sensitive-label']).toBe('approval');
  });

  test('draft and tidy : drafts to self / internal / allowlist and single labels run freely ; bulk labels ask first at Careful', () => {
    const g = gates({ draft: 'careful', tidy: 'careful' });
    expect(g['gmail.draft-to-zone-self']).toBe('auto');
    expect(g['gmail.draft-to-zone-internal']).toBe('auto');
    expect(g['gmail.draft-to-zone-allowlist']).toBe('auto');
    expect(g['gmail.label-write']).toBe('auto');
    expect(g['gmail.bulk-label-write']).toBe('approval');
  });

  test('no macro-action carries the fallback or the refused draft risk ; no line is env-qualified', () => {
    const listed = (gmailPlugin.catalog.macro_actions ?? []).flatMap((a) =>
      a.entries.map((e) => e.risk_id),
    );
    expect(listed).not.toContain('gmail.uncategorized-write');
    expect(listed).not.toContain('gmail.draft-to-zone-external-unbounded');
    const all = policyFromMacroActions(gmailPlugin, {
      search: 'autonomous',
      draft: 'autonomous',
      tidy: 'autonomous',
    });
    expect(all.some((l) => l.risk_id.includes('['))).toBe(false);
  });

  test('read-from-zone-unknown starts at 20 calls per minute', () => {
    const entry = gmailPlugin.catalog.macro_actions
      ?.flatMap((a) => a.entries)
      .find((e) => e.risk_id === 'gmail.read-from-zone-unknown');
    expect(entry?.rate_limit).toEqual({ max: 20, window_seconds: 60 });
  });
});

/**
 * Mandatory suite of the `gmail` plugin : the SDK kit (tools, catalog
 * coverage, identifiers), the credential spec (an app password over IMAP),
 * `verify` and `discoverResources` against a fake IMAP transport, resource
 * selection and the presets. No network : the transport is `fakeGmail()`.
 * Tool by tool, execution is in `execute.test.ts`.
 */
import { describe, expect, test } from 'vitest';

import {
  CredentialKindMismatch,
  UpstreamAuthError,
  definePlugin,
  serializeSlice,
  type ApiKeySecret,
  type ConnectionContext,
  type ExecuteContext,
  type Resource,
} from '@vaubaan/plugin-sdk';
import {
  assertCatalogCoverage,
  assertIdentifiersRefused,
  assertNoWildcard,
  assertPluginWellFormed,
  assertPresetsValid,
  mockFetch,
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
import { fakeGmail } from './fake-imap.ts';

const MAILBOX = 'me@myorg.com';
const THREAD = '18c2a9f0e1d2b3a4';
const MESSAGE = '18c2a9f0e1d2b3a5';

const mailbox: Resource = {
  provider: 'gmail',
  ref: MAILBOX,
  displayName: MAILBOX,
  metadata: {
    internal_domains: ['myorg.com'],
    allowlist_addresses: ['partner@vendor.com'],
    allowlist_domains: ['vendor.com'],
    sensitive_labels: ['LEGAL', 'HR'],
    account_email: MAILBOX,
  },
};
const otherMailbox: Resource = {
  provider: 'gmail',
  ref: 'support@myorg.com',
  displayName: 'support@myorg.com',
};
const githubRepo: Resource = { provider: 'github', ref: 'acme/app', displayName: 'acme/app' };

const secret = (fields: Record<string, string> = {}): ApiKeySecret => ({
  kind: 'api-key',
  fields: { email: 'Me@MyOrg.com', app_password: 'abcd efgh ijkl mnop', ...fields },
  metadata: {},
});

const connCtx = (overrides: Partial<ConnectionContext> = {}): ConnectionContext => ({
  credential: secret(),
  fetch: mockFetch([]),
  ...overrides,
});

const execCtx = (resources: readonly Resource[] = [mailbox]): ExecuteContext => ({
  ...connCtx(),
  resources,
});

/** The samples of every tool, ids in the grammar (16 lower-case hexadecimal digits at most). */
const SAMPLES: ToolSamples = {
  gmail__describe_zones: [{ args: {} }],
  gmail__search_threads: [
    { args: { q: 'from:no-reply@vendor.com' } },
    { args: { q: 'from:colleague@myorg.com' } },
    { args: { q: 'from:other@vendor.com' } },
    { args: { q: 'from:random@random.io' } },
    { args: { q: 'is:unread' } },
    { args: { q: 'label:LEGAL' } },
    { args: { q: 'from:no-reply@vendor.com OR newer_than:3650d' } },
    { args: { q: 'from:colleague@myorg.com -label:LEGAL -label:HR' } },
    { args: { q: 'is:unread' }, resources: [], expectDenied: true },
    { args: { q: 'is:unread' }, resources: [mailbox, otherMailbox], expectDenied: true },
  ],
  gmail__get_thread: [{ args: { id: THREAD } }, { args: {}, expectDenied: true }],
  gmail__get_attachment: [
    { args: { thread_id: THREAD, message_id: MESSAGE, part: '2' } },
    { args: { thread_id: THREAD, message_id: MESSAGE, part: '1.2' } },
    { args: { thread_id: THREAD, message_id: MESSAGE }, expectDenied: true },
    { args: { thread_id: THREAD, message_id: MESSAGE, part: '0' }, expectDenied: true },
  ],
  gmail__list_drafts: [{ args: {} }],
  gmail__create_draft: [
    { args: { to: [MAILBOX], subject: 's', body: 'b' } },
    { args: { to: ['colleague@myorg.com'], subject: 's', body: 'b' } },
    {
      args: { to: ['partner@vendor.com'], cc: 'Me <me@myorg.com>', subject: 's', body: 'b' },
    },
    // An external recipient, and a recipient that does not parse, refuse the call.
    { args: { to: ['stranger@evil.example'], subject: 's', body: 'b' }, expectDenied: true },
    {
      args: { to: ['evil@evil.example, colleague@myorg.com'], subject: 's', body: 'b' },
      expectDenied: true,
    },
  ],
  gmail__list_labels: [{ args: {} }],
  gmail__create_label: [
    { args: { name: 'Clients 2026' } },
    { args: { name: 'Projets/Été' } },
    { args: { name: 'TRASH' }, expectDenied: true },
    { args: { name: '[Gmail]/Archive' }, expectDenied: true },
  ],
  gmail__label_message: [{ args: { thread_id: THREAD, message_id: MESSAGE, label: 'STARRED' } }],
  gmail__unlabel_message: [{ args: { thread_id: THREAD, message_id: MESSAGE, label: 'STARRED' } }],
  gmail__label_thread: [
    { args: { thread_id: THREAD, label: 'STARRED' } },
    { args: { label: 'STARRED' }, expectDenied: true },
    { args: { thread_id: THREAD, label: 'TRASH' }, expectDenied: true },
  ],
  gmail__unlabel_thread: [{ args: { thread_id: THREAD, label: 'STARRED' } }],
};

// ─────────────────────────────────────────────────────────────────────────────
// SDK kit
// ─────────────────────────────────────────────────────────────────────────────

describe('gmail plugin — SDK kit', () => {
  test('well-formed, presets valid, no wildcard', () => {
    assertPluginWellFormed(gmailPlugin);
    assertPresetsValid(gmailPlugin);
    assertNoWildcard(gmailPlugin);
  });

  test('is at 1.0, no longer says experimental, and exposes its twelve tools', () => {
    expect(gmailPlugin.version).toMatch(/^1\.0\.\d+$/);
    expect(gmailPlugin.description).not.toMatch(/experimental/i);
    expect(gmailPlugin.summary).not.toMatch(/experimental/i);
    expect(gmailPlugin.description).toMatch(/never sends/i);
    const names = gmailPlugin.tools.map((t) => t.name);
    expect(names).toEqual([...GMAIL_CLASSIFIED_TOOLS]);
    expect(gmailPlugin.tools).toBe(gmailClassifiedToolDeclarations);
    expect(names).toHaveLength(12);
    // No tool sends: IMAP cannot, and no SMTP client is shipped.
    expect(names.some((n) => /send/.test(n))).toBe(false);
    for (const t of gmailPlugin.tools) {
      expect(t.name.startsWith('gmail__')).toBe(true);
      expect(t.inputSchema.type).toBe('object');
    }
  });

  test('every tool maps to slices the catalog covers', () => {
    const report = assertCatalogCoverage(gmailPlugin, SAMPLES, { resources: [mailbox] });
    expect(report.toolsChecked).toBe(12);
    // Untouched on purpose : the classifier refuses a draft to an external
    // recipient, and no modelled tool emits a bulk write. Every write of
    // these samples is covered by a specific entry, so the fallback is never
    // the only match — a preset can therefore grant drafts and labels.
    expect(report.risksUntouched).toEqual([
      'gmail.draft-to-zone-external-unbounded',
      'gmail.bulk-label-write',
    ]);
    expect(report.fallbackHits).toEqual([]);
  });

  test('a write on a sensitive label reaches the fallback, which no preset offers', () => {
    const exposed = definePlugin({
      ...gmailPlugin,
      tools: gmailClassifiedToolDeclarations.filter((t) => t.name === 'gmail__unlabel_thread'),
      toolTitles: { gmail__unlabel_thread: 'Remove a label from a thread' },
    });
    const report = assertCatalogCoverage(
      exposed,
      { gmail__unlabel_thread: [{ args: { thread_id: THREAD, label: 'LEGAL' } }] },
      { resources: [mailbox] },
    );
    expect(report.fallbackHits).toHaveLength(1);
  });

  test('a hostile identifier is refused by classify and reaches no IMAP command', async () => {
    const transport = fakeGmail();
    const report = await assertIdentifiersRefused(createGmailPlugin({ transport }), SAMPLES, {
      resources: [mailbox],
      context: (_fetch, resources) => execCtx(resources),
      elsewhere: {
        reset: () => transport.calls.splice(0),
        sent: () => transport.calls.map((c) => ({ method: 'IMAP', url: `imap:${c.op}` })),
      },
      pathIdentifiers: { none: 'the upstream is IMAP, not an HTTP request' },
    });
    expect(report.toolsChecked).toBe(12);
    expect(report.pathIdentifiers).toEqual([]);
    expect(report.refusedByClassify).toBeGreaterThan(0);
    expect(report.nothingSent).toBeGreaterThanOrEqual(report.refusedByClassify);
  });
});
// ─────────────────────────────────────────────────────────────────────────────
// Resource selection and metadata
// ─────────────────────────────────────────────────────────────────────────────

describe('gmail classify — mailbox selection', () => {
  test('exactly one gmail resource is required ; other providers are ignored', () => {
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
          provider: 'gmail',
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
    expect(gmailPlugin.classify('gmail__send_message', {}, [mailbox])).toEqual({
      denied: "unknown gmail tool 'gmail__send_message'.",
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
      provider: 'gmail',
      ref: 'mailbox-1',
      displayName: 'x',
      metadata: { internal_domains: ['MyOrg.com', 42], account_email: 'Me@MyOrg.com' },
    });
    expect(md.internal_domains).toEqual(['myorg.com']);
    expect(md.account_email).toBe('me@myorg.com');
    expect(
      readMailboxMetadata({ provider: 'gmail', ref: 'mailbox-1', displayName: 'x' }),
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
    const text = spec.guide.steps.join(' ');
    expect(text).toMatch(/2-Step Verification/);
    expect(text).toContain('https://myaccount.google.com/apppasswords');
    expect(text).toContain('"Vaubaan Gateway"');
    expect(text).toMatch(/Workspace administrator/);
    expect(text).toMatch(/IMAP is on/);
    expect(text).toMatch(/no scopes/);
    expect(spec.guide.permissions).toEqual([]);
    expect(spec.guide.recommendedExpiryDays).toBeNull();
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
        provider: 'gmail',
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

  test('a malformed stored field is a host bug, not a provider error', async () => {
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
// Presets
// ─────────────────────────────────────────────────────────────────────────────

describe('gmail presets', () => {
  const preset = (id: string) => {
    const p = gmailPlugin.catalog.presets?.find((x) => x.id === id);
    if (!p) throw new Error(`preset ${id} missing`);
    return p;
  };
  const riskOf = (riskId: string) => gmailPlugin.catalog.risks.find((r) => r.id === riskId)!;
  const isWrite = (riskId: string) => String(riskOf(riskId).matches).endsWith('.W');

  test('ships read-only and developer', () => {
    expect(gmailPlugin.catalog.presets?.map((p) => p.id)).toEqual(['read-only', 'developer']);
    expect(gmailPlugin.catalog.catalog_version).toBe(7);
  });

  test('read-only : reads only, no bulk read, no sensitive label, every entry auto', () => {
    const entries = preset('read-only').entries;
    const ids = entries.map((e) => e.risk_id);
    expect(ids.some(isWrite)).toBe(false);
    expect(ids).not.toContain('gmail.bulk-read');
    expect(ids).not.toContain('gmail.read-sensitive-label');
    expect(ids).toContain('gmail.read-from-zone-unknown');
    expect(entries.every((e) => e.gate === 'auto')).toBe(true);
  });

  test('developer : drafts to self / internal / allowlist and single labels auto ; bulk read under approval', () => {
    const entries = preset('developer').entries;
    const gate = (id: string) => entries.find((e) => e.risk_id === id)?.gate;
    expect(gate('gmail.draft-to-zone-self')).toBe('auto');
    expect(gate('gmail.draft-to-zone-internal')).toBe('auto');
    expect(gate('gmail.draft-to-zone-allowlist')).toBe('auto');
    expect(gate('gmail.label-write')).toBe('auto');
    expect(gate('gmail.bulk-read')).toBe('approval');
    expect(entries.every((e) => e.risk_id.startsWith('gmail.'))).toBe(true);
  });

  test('no preset carries the fallback, the refused draft risk, a risk no tool can touch, a sensitive read or an env qualifier', () => {
    for (const p of gmailPlugin.catalog.presets ?? []) {
      const ids = p.entries.map((e) => e.risk_id);
      expect(ids).not.toContain('gmail.uncategorized-write');
      expect(ids).not.toContain('gmail.draft-to-zone-external-unbounded');
      expect(ids).not.toContain('gmail.bulk-label-write');
      expect(ids).not.toContain('gmail.read-sensitive-label');
      expect(ids.some((id) => id.includes('['))).toBe(false);
      for (const e of p.entries) {
        expect(e.quota).toBeGreaterThan(0);
        expect(e.rate_limit.max).toBeGreaterThan(0);
      }
    }
  });

  test('read-from-zone-unknown never exceeds the catalog cap of 20 calls per minute', () => {
    for (const p of gmailPlugin.catalog.presets ?? []) {
      const e = p.entries.find((x) => x.risk_id === 'gmail.read-from-zone-unknown')!;
      expect(e.rate_limit.window_seconds).toBe(60);
      expect(e.rate_limit.max).toBeLessThanOrEqual(20);
    }
  });
});

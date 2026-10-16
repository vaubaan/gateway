/**
 * Mandatory suite of the `gmail` plugin : the SDK kit, the experimental
 * shape (no exposed tool, `execute` not implemented), the credential spec,
 * `discoverResources` against `mockFetch`, resource selection and the
 * presets. No network : an unmatched request fails the test.
 */
import { describe, expect, test } from 'vitest';

import {
  CredentialKindMismatch,
  definePlugin,
  serializeSlice,
  type ConnectionContext,
  type ExecuteContext,
  type OAuth2Secret,
  type Resource,
} from '@vaubaan/plugin-sdk';
import {
  assertCatalogCoverage,
  assertIdentifiersRefused,
  assertNoWildcard,
  assertPluginWellFormed,
  assertPresetsValid,
  mockFetch,
} from '@vaubaan/plugin-sdk/testing';

import {
  GMAIL_API_BASE,
  GMAIL_AUTHORIZATION_URL,
  GMAIL_CLASSIFIED_TOOLS,
  GMAIL_NOT_IMPLEMENTED_CODE,
  GMAIL_SCOPE_COMPOSE,
  GMAIL_SCOPE_READONLY,
  GMAIL_TOKEN_URL,
  gmailClassifiedToolDeclarations,
  gmailPlugin,
  readMailboxMetadata,
} from '../../src/index.ts';

const MAILBOX = 'me@myorg.com';

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

const oauthSecret = (overrides: Partial<OAuth2Secret> = {}): OAuth2Secret => ({
  kind: 'oauth2',
  accessToken: 'ya29.access',
  refreshToken: '1//refresh',
  expiresAt: '2026-10-13T12:00:00.000Z',
  scopes: [GMAIL_SCOPE_READONLY, GMAIL_SCOPE_COMPOSE],
  metadata: {},
  ...overrides,
});

const connCtx = (
  fetch: typeof globalThis.fetch,
  overrides: Partial<ConnectionContext> = {},
): ConnectionContext => ({
  credential: oauthSecret(),
  appConfig: { client_id: 'cid', client_secret: 'csecret' },
  fetch,
  ...overrides,
});

const execCtx = (fetch: typeof globalThis.fetch): ExecuteContext => ({
  ...connCtx(fetch),
  resources: [mailbox],
});

const PROFILE_URL = `${GMAIL_API_BASE}/users/me/profile`;

// ─────────────────────────────────────────────────────────────────────────────
// SDK kit and experimental shape
// ─────────────────────────────────────────────────────────────────────────────

describe('gmail plugin — SDK kit', () => {
  test('well-formed, presets valid, no wildcard', () => {
    assertPluginWellFormed(gmailPlugin);
    assertPresetsValid(gmailPlugin);
    assertNoWildcard(gmailPlugin);
  });

  test('is experimental : flag set, version below 1.0, no tool exposed', () => {
    expect(gmailPlugin.experimental).toBe(true);
    expect(gmailPlugin.version.startsWith('0.')).toBe(true);
    expect(gmailPlugin.tools).toEqual([]);
    expect(gmailPlugin.description).toMatch(/experimental/i);
  });

  test('the ten classified tools are declared (unexposed) under the gmail__ prefix', () => {
    const names = gmailClassifiedToolDeclarations.map((t) => t.name);
    expect(names).toEqual([...GMAIL_CLASSIFIED_TOOLS]);
    expect(names).toHaveLength(10);
    for (const t of gmailClassifiedToolDeclarations) {
      expect(t.name.startsWith('gmail__')).toBe(true);
      expect(t.inputSchema.type).toBe('object');
    }
  });

  test('coverage of the exposed surface is vacuous (no tool) and passes', () => {
    const report = assertCatalogCoverage(gmailPlugin, {});
    expect(report.toolsChecked).toBe(0);
  });

  test('the identifier proof is vacuous too : no tool is exposed, so nothing can be executed', async () => {
    const report = await assertIdentifiersRefused(
      gmailPlugin,
      {},
      { context: (fetch) => execCtx(fetch) },
    );
    expect(report).toMatchObject({ toolsChecked: 0, hostileCalls: 0, pathIdentifiers: [] });
  });

  test('every classified tool maps to slices the catalog covers', () => {
    // The classified tools are not exposed ; a plugin variant that exposes
    // them lets the kit check the classifier → catalog plumbing.
    const exposed = definePlugin({ ...gmailPlugin, tools: gmailClassifiedToolDeclarations });
    const report = assertCatalogCoverage(
      exposed,
      {
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
        gmail__get_thread: [{ args: { id: 't_xyz' } }, { args: {}, expectDenied: true }],
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
        gmail__label_message: [{ args: { thread_id: 't1', message_id: 'm1', label: 'STARRED' } }],
        gmail__unlabel_message: [{ args: { thread_id: 't1', message_id: 'm1', label: 'STARRED' } }],
        gmail__label_thread: [
          { args: { thread_id: 't1', label: 'STARRED' } },
          { args: { label: 'STARRED' }, expectDenied: true },
          { args: { thread_id: 't1', label: 'TRASH' }, expectDenied: true },
        ],
        gmail__unlabel_thread: [{ args: { thread_id: 't1', label: 'STARRED' } }],
      },
      { resources: [mailbox] },
    );
    expect(report.toolsChecked).toBe(10);
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
    });
    const report = assertCatalogCoverage(
      exposed,
      { gmail__unlabel_thread: [{ args: { thread_id: 't1', label: 'LEGAL' } }] },
      { resources: [mailbox] },
    );
    expect(report.fallbackHits).toHaveLength(1);
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

describe('gmail credential spec', () => {
  test('Google oauth2 : PKCE, client_secret_post, offline + consent, refreshable', () => {
    const spec = gmailPlugin.credential;
    expect(spec.kind).toBe('oauth2');
    if (spec.kind !== 'oauth2') return;
    expect(spec.authorizationUrl).toBe(GMAIL_AUTHORIZATION_URL);
    expect(spec.tokenUrl).toBe(GMAIL_TOKEN_URL);
    expect(spec.authorizationUrl).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(spec.tokenUrl).toBe('https://oauth2.googleapis.com/token');
    expect(spec.pkce).toBe(true);
    expect(spec.clientAuthMethod).toBe('client_secret_post');
    expect(spec.refreshable).toBe(true);
    expect(spec.extraAuthorizationParams).toEqual({
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
    });
    expect(spec.resourceIndicator).toBeUndefined();
  });

  test('scopes are readonly + compose only : no modify, no send, no mail.google.com', () => {
    const spec = gmailPlugin.credential;
    if (spec.kind !== 'oauth2') throw new Error('oauth2 expected');
    expect(spec.scopes).toEqual([
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.compose',
    ]);
    for (const s of spec.scopes) {
      expect(s).not.toMatch(/gmail\.modify|gmail\.send|mail\.google\.com\/?$/);
    }
  });

  test('no plugin refresh : the host performs the standard refresh_token grant from the spec', () => {
    expect(gmailPlugin.refresh).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// discoverResources
// ─────────────────────────────────────────────────────────────────────────────

describe('gmail discoverResources', () => {
  test('returns the authenticated mailbox as the single resource', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: PROFILE_URL,
        body: {
          emailAddress: 'Alice@MyOrg.com',
          messagesTotal: 12345,
          threadsTotal: 678,
          historyId: '99',
        },
        times: 1,
      },
    ]);
    const resources = await gmailPlugin.discoverResources(connCtx(fetch));
    expect(resources).toEqual([
      {
        provider: 'gmail',
        ref: 'alice@myorg.com',
        displayName: 'alice@myorg.com',
        metadata: { account_email: 'alice@myorg.com', messages_total: 12345, threads_total: 678 },
      },
    ]);
    expect(fetch.calls[0]!.headers.authorization).toBe('Bearer ya29.access');
    expect(fetch.pending()).toEqual([]);
  });

  test('does not pre-fill any zoning list', async () => {
    const fetch = mockFetch([{ url: PROFILE_URL, body: { emailAddress: 'bob@gmail.com' } }]);
    const [res] = await gmailPlugin.discoverResources(connCtx(fetch));
    expect(res!.metadata).toEqual({ account_email: 'bob@gmail.com' });
    const md = readMailboxMetadata(res!);
    expect(md.internal_domains).toEqual([]);
  });

  test('401 / 403 → UpstreamAuthError with the status', async () => {
    for (const status of [401, 403]) {
      const fetch = mockFetch([{ url: PROFILE_URL, status, body: { error: 'invalid_token' } }]);
      await expect(gmailPlugin.discoverResources(connCtx(fetch))).rejects.toMatchObject({
        name: 'UpstreamAuthError',
        upstreamStatus: status,
      });
    }
  });

  test('other upstream failures and malformed profiles are plain errors', async () => {
    await expect(
      gmailPlugin.discoverResources(
        connCtx(mockFetch([{ url: PROFILE_URL, status: 500, body: 'x' }])),
      ),
    ).rejects.toThrow(/HTTP 500/);
    await expect(
      gmailPlugin.discoverResources(connCtx(mockFetch([{ url: PROFILE_URL, body: {} }]))),
    ).rejects.toThrow(/without an emailAddress/);
  });

  test('wrong credential kind is refused before any call', async () => {
    const fetch = mockFetch([]);
    await expect(
      gmailPlugin.discoverResources(
        connCtx(fetch, {
          credential: { kind: 'api-key', fields: { api_key: 'x' }, metadata: {} },
        }),
      ),
    ).rejects.toBeInstanceOf(CredentialKindMismatch);
    expect(fetch.calls).toHaveLength(0);
  });

  test('passes the abort signal through', async () => {
    const controller = new AbortController();
    const fetch = mockFetch([{ url: PROFILE_URL, body: { emailAddress: 'a@b.co' } }]);
    await gmailPlugin.discoverResources(connCtx(fetch, { signal: controller.signal }));
    expect(fetch.calls).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// execute — not implemented
// ─────────────────────────────────────────────────────────────────────────────

describe('gmail execute (experimental)', () => {
  test('every classified tool answers a structured not_implemented error without any call', async () => {
    const fetch = mockFetch([]);
    for (const tool of GMAIL_CLASSIFIED_TOOLS) {
      const result = await gmailPlugin.execute(execCtx(fetch), tool, {});
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: GMAIL_NOT_IMPLEMENTED_CODE,
        plugin: 'gmail',
        experimental: true,
        tool,
      });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(JSON.parse(text)).toEqual(result.structuredContent);
      expect(text).toMatch(/not implemented/);
      expect(text).toMatch(/experimental/);
    }
    expect(fetch.calls).toHaveLength(0);
  });

  test('an unknown tool gets the same answer (classify denies it earlier)', async () => {
    const result = await gmailPlugin.execute(execCtx(mockFetch([])), 'gmail__nope', { a: 1 });
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.tool).toBe('gmail__nope');
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
    expect(gmailPlugin.catalog.catalog_version).toBe(4);
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

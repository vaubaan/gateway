/**
 * The generic driver against the plugins the image actually ships: every
 * connect form is derived from a real `CredentialSpec`. No request leaves the process (`mockFetch` with no route).
 */
import { createRegistry, isBrokeredSpec } from '@vaubaan/plugin-sdk';
import { describe, expect, it } from 'vitest';

import { SHIPPED_PLUGINS } from '../compose/shipped-plugins';
import { toolTitleOf } from '../providers/tool-titles';
import { canWithdraw } from './credentials';
import { connectionsHarness, stateOf } from '../../../tests/support/connections/testing';

describe('shipped plugins through the generic connect driver', () => {
  it('registers every shipped plugin once', () => {
    const registry = createRegistry(SHIPPED_PLUGINS);
    expect(registry.size).toBe(SHIPPED_PLUGINS.length);
    expect(registry.size).toBeGreaterThanOrEqual(10);
  });

  it('every tool of a shipped plugin says what it does in a few words, and tools/list does not carry it', () => {
    // The head of an approval request ("Merge a pull request · acme-org/app") is the
    // plugin's title of the tool: a tool without one would be headed by its name.
    const registry = createRegistry(SHIPPED_PLUGINS);
    let tools = 0;
    for (const plugin of SHIPPED_PLUGINS) {
      const titles = plugin.toolTitles ?? {};
      for (const tool of plugin.tools) {
        tools += 1;
        expect(titles[tool.name], tool.name).toEqual(expect.any(String));
        expect(toolTitleOf(registry, tool.name), tool.name).toBe(titles[tool.name]);
        // For people only: the declaration an MCP client lists is unchanged.
        expect(Object.keys(tool).sort(), tool.name).toEqual(['description', 'inputSchema', 'name']);
      }
      // A title is a verb and its object, not the description again.
      for (const [name, title] of Object.entries(titles)) {
        expect(title.split(' ').length, name).toBeLessThanOrEqual(8);
        expect(title, name).not.toMatch(/Backed by|\bGET\b|\bPOST\b|`/);
      }
    }
    expect(tools).toBeGreaterThan(150);
    expect(toolTitleOf(registry, 'github__merge_pull_request')).toBe('Merge a pull request');
    // A tool nobody declares, a provider nobody ships, a name that is not a tool's: no title.
    expect(toolTitleOf(registry, 'github__no_such_tool')).toBeNull();
    expect(toolTitleOf(registry, 'nobody__merge')).toBeNull();
    expect(toolTitleOf(registry, 'not a tool')).toBeNull();
  });

  it('every shipped plugin says where a person removes the grant by hand', () => {
    for (const plugin of SHIPPED_PLUGINS) {
      expect(plugin.manualRevocation, plugin.id).toEqual(expect.any(String));
      expect(plugin.manualRevocation!.length, plugin.id).toBeGreaterThan(30);
      // A place in the provider's interface, not a promise of the gateway.
      expect(plugin.manualRevocation, plugin.id).not.toMatch(/will be|automatically/i);
    }
  });

  it('withdraws the provider-side grant for the providers that document an endpoint, and for no other', () => {
    // The endpoints below are the ones read in the providers' documentation (ADR
    // provider-side-revocation-on-connection-revoke). A plugin joins this table with
    // its source, never by analogy. A pasted token is deleted by hand at the service. A
    // brokered connection is withdrawn through its broker (`POST /revoke`, ADR
    // oauth-broker-stateless-in-an-attested-enclave D1).
    const declared = new Map(
      SHIPPED_PLUGINS.filter((plugin) => canWithdraw(plugin)).map((plugin) => {
        const spec = plugin.credential;
        if (spec.kind !== 'oauth2') return [plugin.id, 'revoke()'];
        return [plugin.id, isBrokeredSpec(spec) ? 'broker' : spec.revocation];
      }),
    );
    expect(Object.fromEntries(declared)).toEqual({ 'google-calendar': 'broker' });
    for (const plugin of SHIPPED_PLUGINS) expect(plugin.revoke, plugin.id).toBeUndefined();
  });

  it('every shipped token way guides the person, checks the token and names what it is', () => {
    // The guided token way (ADR one-place-to-authorize-services-token-first) : a label in
    // the service's words, where to create it, the steps, a check at paste.
    const guided = SHIPPED_PLUGINS.filter(
      (plugin) => plugin.credential.kind === 'api-key' && plugin.credential.guide !== undefined,
    );
    expect(guided.map((plugin) => plugin.id)).toEqual(
      expect.arrayContaining(['github', 'gmail', 'railway', 'supabase']),
    );
    for (const plugin of guided) {
      const spec = plugin.credential;
      if (spec.kind !== 'api-key') continue;
      expect(spec.label, plugin.id).toBeTruthy();
      expect(spec.createUrl, plugin.id).toMatch(/^https:\/\//);
      expect(spec.guide?.steps.length, plugin.id).toBeGreaterThan(0);
      expect(typeof spec.verify, plugin.id).toBe('function');
      // A secret is never shown back: the token field is secret.
      expect(
        spec.fields.some((field) => field.secret),
        plugin.id,
      ).toBe(true);
    }
  });

  it('ships one way per service: a key at once, OAuth only where no key exists', async () => {
    const h = connectionsHarness({ plugins: SHIPPED_PLUGINS });
    const before = await h.service.providers();
    // Nothing needs the operator: a key is pasted, an OAuth client is registered by the gateway.
    for (const p of before) {
      expect(p.redirects, p.id).toBe(p.kind === 'oauth2');
      if (p.kind === 'oauth2') expect(p.fields, p.id).toEqual([]);
      else expect(p.fields.length, p.id).toBeGreaterThan(0);
    }
    const ways = before.map((p) => p.kind);
    expect(ways).toContain('ssh-key');
    expect(ways).not.toContain('app-install');
    // Miro offers no key a person can use (its REST token needs an app an organisation may
    // refuse, docs/handbook/providers/miro.md): the one OAuth way shipped, with a
    // client the gateway registers itself (ADR oauth-client-registered-by-the-gateway). Gmail
    // connects with an app password (ADR gmail-over-imap-with-an-app-password). Google
    // Calendar's client is an OAuth broker's (ADR google-calendar-through-an-oauth-broker):
    // without a broker configured it is listed as not configured, with the reason.
    expect(before.filter((p) => p.kind === 'oauth2').map((p) => p.id)).toEqual([
      'miro',
      'google-calendar',
    ]);
    for (const plugin of SHIPPED_PLUGINS) {
      const spec = plugin.credential;
      if (spec.kind !== 'oauth2') continue;
      if (isBrokeredSpec(spec)) expect(spec.broker.provider, plugin.id).toBe('google');
      else expect(spec.clientRegistration.registrationUrl, plugin.id).toMatch(/^https:\/\//);
    }
    expect(before.filter((p) => p.unavailable !== null).map((p) => p.id)).toEqual([
      'google-calendar',
    ]);
    expect(before.filter((p) => p.viaBroker).map((p) => p.id)).toEqual(['google-calendar']);
  });

  it('builds a valid authorization redirect for every oauth2 plugin', async () => {
    const h = connectionsHarness({ plugins: SHIPPED_PLUGINS });
    const alice = await h.actor('alice@example.com');
    // The registration itself is tested in oauth2-clients.test.ts: the client is seeded here.
    // A brokered flow starts at the broker: oauth-broker.test.ts drives it end to end.
    const redirectFlows = SHIPPED_PLUGINS.filter(
      (p) => p.credential.kind === 'oauth2' && !isBrokeredSpec(p.credential),
    );
    expect(redirectFlows.length).toBeGreaterThan(0);
    for (const plugin of redirectFlows) {
      await h.seedClient(plugin.id, 'value-1', 'secret-1');

      const result = await h.service.start(alice, plugin.id);
      if (result.kind !== 'redirect') throw new Error(`${plugin.id}: expected a redirect`);
      const url = new URL(result.url);
      expect(url.protocol, plugin.id).toBe('https:');
      expect(stateOf(result.url), plugin.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
      if (plugin.credential.kind === 'oauth2' && !isBrokeredSpec(plugin.credential)) {
        const spec = plugin.credential;
        expect(`${url.origin}${url.pathname}`, plugin.id).toBe(spec.authorizationUrl);
        expect(url.searchParams.get('redirect_uri'), plugin.id).toBe(
          h.service.callbackUrl(plugin.id).href,
        );
        expect(url.searchParams.get('client_id'), plugin.id).toBe('value-1');
        expect(url.searchParams.has('code_challenge'), plugin.id).toBe(spec.pkce);
        expect(url.searchParams.get('resource'), plugin.id).toBe(spec.resourceIndicator ?? null);
        for (const [name, value] of Object.entries(spec.extraAuthorizationParams ?? {})) {
          expect(url.searchParams.get(name), `${plugin.id}.${name}`).toBe(value);
        }
        // The client secret is for the token endpoint only.
        expect(result.url, plugin.id).not.toContain('client_secret');
      }
    }
    expect(h.fetch.calls).toHaveLength(0);
  });
});

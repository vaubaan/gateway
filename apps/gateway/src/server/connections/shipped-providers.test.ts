/**
 * The generic driver against the plugins the image actually ships: every
 * connect form and every provider-app form is derived from a real
 * `CredentialSpec`. No request leaves the process (`mockFetch` with no route).
 */
import { createRegistry } from '@vaubaan/plugin-sdk';
import { describe, expect, it } from 'vitest';

import { SHIPPED_PLUGINS } from '../compose/shipped-plugins';
import { PROVIDER_APP_FIELDS } from '../config/types';
import { appConfigFieldsOf, APP_FIELD_NAME_PATTERN } from '../provider-apps';
import { toolTitleOf } from '../providers/tool-titles';
import { canWithdraw } from './credentials';
import { connectionsHarness, stateOf } from './testing';

describe('shipped plugins through the generic connect driver', () => {
  it('registers every shipped plugin once', () => {
    const registry = createRegistry(SHIPPED_PLUGINS);
    expect(registry.size).toBe(SHIPPED_PLUGINS.length);
    expect(registry.size).toBeGreaterThanOrEqual(10);
  });

  it('can express every provider-app field in the mounted configuration', () => {
    // A field a plugin asks for but `providers.<id>.<field>` cannot carry would
    // force the operator through the Admin page; today none exists.
    for (const plugin of SHIPPED_PLUGINS) {
      for (const field of appConfigFieldsOf(plugin.credential)) {
        expect(field.name, `${plugin.id}.${field.name}`).toMatch(APP_FIELD_NAME_PATTERN);
        expect(PROVIDER_APP_FIELDS as readonly string[], `${plugin.id}.${field.name}`).toContain(
          field.name,
        );
      }
    }
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
    // its source, never by analogy. A pasted token is deleted by hand at the service.
    const declared = new Map(
      SHIPPED_PLUGINS.filter((plugin) => canWithdraw(plugin)).map((plugin) => [
        plugin.id,
        plugin.credential.kind === 'oauth2' ? plugin.credential.revocation : 'revoke()',
      ]),
    );
    expect(Object.fromEntries(declared)).toEqual({
      gmail: { url: 'https://oauth2.googleapis.com/revoke', format: 'token-form' },
    });
    for (const plugin of SHIPPED_PLUGINS) expect(plugin.revoke, plugin.id).toBeUndefined();
  });

  it('every shipped token way guides the person, checks the token and names what it is', () => {
    // The guided token way (ADR one-place-to-authorize-services-token-first) : a label in
    // the service's words, where to create it, the steps, a check at paste.
    const guided = SHIPPED_PLUGINS.filter(
      (plugin) => plugin.credential.kind === 'api-key' && plugin.credential.guide !== undefined,
    );
    expect(guided.map((plugin) => plugin.id)).toEqual(
      expect.arrayContaining(['github', 'railway', 'supabase']),
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

  it('ships one way per service: a key at once, OAuth only where no key exists, and flags experimental ones', async () => {
    const h = connectionsHarness({ plugins: SHIPPED_PLUGINS });
    const before = await h.service.providers();
    // The OAuth way needs the company's client declared, unless the gateway registers its own;
    // a key needs nothing from the operator.
    for (const p of before) {
      expect(p.redirects, p.id).toBe(p.kind === 'oauth2');
      expect(p.usesApp, p.id).toBe(p.kind === 'oauth2' && !p.registersItself);
      expect(p.configured, p.id).toBe(!p.usesApp);
      if (p.kind === 'oauth2') expect(p.fields, p.id).toEqual([]);
      else expect(p.fields.length, p.id).toBeGreaterThan(0);
    }
    const ways = before.map((p) => p.kind);
    expect(ways).toContain('ssh-key');
    expect(ways).not.toContain('app-install');
    // Gmail and Miro offer no key a person can use (ADR one-place-to-authorize-services-token-first;
    // Miro's REST token needs an app an organisation may refuse, ADR
    // miro-rewraps-the-official-mcp-server): the OAuth ways shipped. Miro's client
    // registers itself (ADR oauth-client-registered-by-the-gateway).
    expect(before.filter((p) => p.kind === 'oauth2').map((p) => p.id)).toEqual(['gmail', 'miro']);
    expect(before.filter((p) => p.registersItself).map((p) => p.id)).toEqual(['miro']);
    expect(before.filter((p) => p.experimental).map((p) => p.id)).toEqual(
      SHIPPED_PLUGINS.filter((p) => p.experimental === true).map((p) => p.id),
    );
  });

  it('builds a valid authorization redirect for every oauth2 plugin', async () => {
    const h = connectionsHarness({ plugins: SHIPPED_PLUGINS });
    const alice = await h.actor('alice@example.com');
    // A client the gateway registers is not part of this test (oauth2-clients.test.ts).
    const redirectFlows = SHIPPED_PLUGINS.filter(
      (p) => p.credential.kind === 'oauth2' && p.credential.clientRegistration === undefined,
    );
    expect(redirectFlows.length).toBeGreaterThan(0);
    for (const plugin of redirectFlows) {
      // Fill every declared field with a value of the declared shape.
      const values: Record<string, string> = {};
      for (const field of appConfigFieldsOf(plugin.credential)) {
        values[field.name] = field.pattern?.includes('[0-9]+') ? '12345' : 'value-1';
      }
      await h.providerApps.save(plugin.id, values);

      const result = await h.service.start(alice, plugin.id);
      if (result.kind !== 'redirect') throw new Error(`${plugin.id}: expected a redirect`);
      const url = new URL(result.url);
      expect(url.protocol, plugin.id).toBe('https:');
      expect(stateOf(result.url), plugin.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
      if (plugin.credential.kind === 'oauth2') {
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

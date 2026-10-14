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
    // its source, never by analogy.
    const declared = new Map(
      SHIPPED_PLUGINS.filter((plugin) => canWithdraw(plugin)).map((plugin) => [
        plugin.id,
        plugin.credential.kind === 'oauth2' ? plugin.credential.revocation : 'revoke()',
      ]),
    );
    expect(Object.fromEntries(declared)).toEqual({
      gmail: { url: 'https://oauth2.googleapis.com/revoke', format: 'token-form' },
      supabase: {
        url: 'https://api.supabase.com/v1/oauth/revoke',
        format: 'client-credentials-json',
      },
    });
    for (const plugin of SHIPPED_PLUGINS) expect(plugin.revoke, plugin.id).toBeUndefined();
  });

  it('ships no app-install plugin whose installations cannot be verified', () => {
    // Such a plugin would only be connectable with "accept unverified installations" on.
    for (const plugin of SHIPPED_PLUGINS) {
      if (plugin.credential.kind !== 'app-install') continue;
      expect(plugin.credential.userVerification, plugin.id).toBeDefined();
    }
  });

  it('offers a provider only once its company app is configured, and flags experimental ones', async () => {
    const h = connectionsHarness({ plugins: SHIPPED_PLUGINS });
    const before = await h.service.providers();
    const byKind = (kind: string) => before.filter((p) => p.kind === kind);
    // Redirect flows need the company app; forms need nothing from the operator.
    for (const p of [...byKind('oauth2'), ...byKind('app-install')]) {
      expect(p.configured, p.id).toBe(false);
      expect(p.fields, p.id).toEqual([]);
    }
    for (const p of [...byKind('api-key'), ...byKind('ssh-key')]) {
      expect(p.configured, p.id).toBe(true);
      expect(p.fields.length, p.id).toBeGreaterThan(0);
    }
    expect(byKind('oauth2').length).toBeGreaterThan(0);
    expect(byKind('app-install').length).toBeGreaterThan(0);
    expect(byKind('ssh-key').length).toBeGreaterThan(0);
    expect(before.filter((p) => p.experimental).map((p) => p.id)).toEqual(
      SHIPPED_PLUGINS.filter((p) => p.experimental === true).map((p) => p.id),
    );
  });

  it('builds a valid authorization or installation redirect for every redirect-flow plugin', async () => {
    const h = connectionsHarness({ plugins: SHIPPED_PLUGINS });
    const alice = await h.actor('alice@example.com');
    const redirectFlows = SHIPPED_PLUGINS.filter(
      (p) => p.credential.kind === 'oauth2' || p.credential.kind === 'app-install',
    );
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

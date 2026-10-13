import { describe, expect, test } from 'vitest';

import { PluginDefinitionError, definePlugin, pluginIssues } from '../../src/define-plugin.ts';
import type { ProviderPlugin } from '../../src/plugin.ts';
import { CredentialKindMismatch, expectCredentialKind } from '../../src/credential.ts';
import { DEFAULT_HOST_FLAGS, normalizeArgsIfEnabled } from '../../src/flags.ts';
import { acmePlugin } from '../fixtures/acme/acme-plugin.ts';

describe('definePlugin', () => {
  test('the fixture is well-formed and frozen', () => {
    expect(pluginIssues(acmePlugin)).toEqual([]);
    expect(Object.isFrozen(acmePlugin)).toBe(true);
  });

  test('collects every issue and throws once', () => {
    const broken = {
      ...acmePlugin,
      id: 'Acme',
      version: '1',
      tools: [
        { ...acmePlugin.tools[0]!, name: 'other__x' },
        acmePlugin.tools[0]!,
        acmePlugin.tools[0]!,
      ],
    } as ProviderPlugin;
    const err = (() => {
      try {
        definePlugin(broken);
      } catch (e) {
        return e as PluginDefinitionError;
      }
      return undefined;
    })();
    expect(err).toBeInstanceOf(PluginDefinitionError);
    expect(err!.issues).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^id: expected a lowercase slug/),
        expect.stringMatching(/^version: expected semver/),
        expect.stringMatching(/tools\[0\]\.name 'other__x' must start with 'Acme__'/),
        expect.stringMatching(/tools\[2\]\.name 'acme__list_things' is declared twice/),
        expect.stringMatching(/dataModel.provider 'acme' must equal the plugin id/),
        expect.stringMatching(/catalog.provider 'acme' must equal the plugin id/),
      ]),
    );
  });

  test('catalog rules apply (presets, fallback) through the definition', () => {
    const noPresets: ProviderPlugin = {
      ...acmePlugin,
      catalog: { ...acmePlugin.catalog, presets: [] },
    };
    expect(pluginIssues(noPresets)).toEqual([
      expect.stringMatching(/^catalog: presets: every plugin ships at least one preset/),
    ]);
  });

  test('optional hooks must be functions when present', () => {
    const bad = { ...acmePlugin, envOf: 'prod' } as unknown as ProviderPlugin;
    expect(pluginIssues(bad)).toEqual(['envOf: expected a function when present']);
    const good: ProviderPlugin = { ...acmePlugin, envOf: () => undefined };
    expect(pluginIssues(good)).toEqual([]);
  });

  test('data-model integrity is checked', () => {
    const orphan: ProviderPlugin = {
      ...acmePlugin,
      dataModel: {
        provider: 'acme',
        planes: [
          {
            slug: 'p',
            entities: [{ name: 'a', parent: 'ghost', cardinalities: ['one'], description: 'x' }],
          },
        ],
      },
    };
    expect(pluginIssues(orphan).join('\n')).toMatch(
      /dataModel: provider 'acme' plane 'p': entity 'a' has parent 'ghost'/,
    );
  });

  test('credential spec rules per kind', () => {
    const noSecret: ProviderPlugin = {
      ...acmePlugin,
      credential: {
        kind: 'api-key',
        fields: [{ name: 'account', label: 'Account', secret: false }],
      },
    };
    expect(pluginIssues(noSecret)).toEqual([expect.stringMatching(/at least one secret field/)]);

    const oauthNoRefresh: ProviderPlugin = {
      ...acmePlugin,
      credential: {
        kind: 'oauth2',
        authorizationUrl: 'http://insecure.example/authorize',
        tokenUrl: 'https://auth.example/token',
        scopes: ['read'],
        pkce: false,
        clientAuthMethod: 'none',
        refreshable: true,
      },
    };
    const oauthIssues = pluginIssues(oauthNoRefresh);
    expect(oauthIssues).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/credential.authorizationUrl: expected an https URL/),
        expect.stringMatching(/public client .* must use PKCE/),
      ]),
    );
    // `refreshable: true` without `refresh()` is fine : the host performs the
    // standard refresh_token grant from the spec (P1.2-align).
    expect(oauthIssues.filter((m) => /refresh/.test(m))).toEqual([]);

    const appInstall: ProviderPlugin = {
      ...acmePlugin,
      credential: {
        kind: 'app-install',
        appConfigFields: [{ name: 'app_id', label: 'App id', secret: false }],
        installUrl: (cfg) => `https://example.test/apps/${cfg.app_slug}/installations/new`,
        installationIdParam: 'installation_id',
      },
    };
    expect(pluginIssues(appInstall)).toEqual([]);

    const ssh: ProviderPlugin = {
      ...acmePlugin,
      credential: { kind: 'ssh-key', algorithm: 'ed25519', fields: [] },
    };
    expect(pluginIssues(ssh)).toEqual([]);

    const unknownKind = {
      ...acmePlugin,
      credential: { kind: 'magic' },
    } as unknown as ProviderPlugin;
    expect(pluginIssues(unknownKind)).toEqual([
      expect.stringMatching(/credential.kind: expected one of/),
    ]);
  });

  test('missing functions are reported', () => {
    const noExec = {
      ...acmePlugin,
      execute: undefined,
      refresh: 'nope',
    } as unknown as ProviderPlugin;
    expect(pluginIssues(noExec)).toEqual(
      expect.arrayContaining([
        'execute: expected a function',
        'refresh: expected a function when present',
      ]),
    );
  });
});

describe('expectCredentialKind', () => {
  const apiKey = { kind: 'api-key', fields: { api_key: 'k' }, metadata: {} } as const;
  test('returns the narrowed secret', () => {
    expect(expectCredentialKind('acme', apiKey, 'api-key').fields.api_key).toBe('k');
  });
  test('throws CredentialKindMismatch otherwise', () => {
    expect(() => expectCredentialKind('acme', apiKey, 'oauth2')).toThrow(CredentialKindMismatch);
    expect(() => expectCredentialKind('acme', apiKey, 'oauth2')).toThrow(
      /expects a 'oauth2' credential, got 'api-key'/,
    );
  });
});

describe('normalizeArgsIfEnabled', () => {
  const plugin = {
    normalizeArgs: (args: Readonly<Record<string, unknown>>) => ({ ...args, space: 'filled' }),
  };
  test('off by default', () => {
    expect(DEFAULT_HOST_FLAGS.argNormalization).toBe(false);
    expect(normalizeArgsIfEnabled(plugin, { a: 1 }, [])).toEqual({ a: 1 });
  });
  test('applies the hook when the flag is on', () => {
    expect(normalizeArgsIfEnabled(plugin, { a: 1 }, [], { argNormalization: true })).toEqual({
      a: 1,
      space: 'filled',
    });
  });
  test('no hook, no change', () => {
    expect(normalizeArgsIfEnabled({}, { a: 1 }, [], { argNormalization: true })).toEqual({ a: 1 });
  });
});

import { describe, expect, test } from 'vitest';

import { PluginDefinitionError, definePlugin, pluginIssues } from '../../src/define-plugin.ts';
import type { ProviderPlugin } from '../../src/plugin.ts';
import { CredentialKindMismatch, expectCredentialKind } from '../../src/credential.ts';
import { DEFAULT_HOST_FLAGS, normalizeArgsIfEnabled } from '../../src/flags.ts';
import { PluginRegistry, PluginRegistryError } from '../../src/registry.ts';
import {
  PluginAssertionError,
  assertPluginWellFormed,
  assertPresetsValid,
} from '../../src/testing/assertions.ts';
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

  test('summary is optional, and a paragraph when present', () => {
    expect(pluginIssues({ ...acmePlugin, summary: 'One connection is one Acme account.' })).toEqual(
      [],
    );
    expect(pluginIssues({ ...acmePlugin, summary: '   ' })).toEqual([
      'summary: expected a non-empty string when present',
    ]);
    expect(pluginIssues({ ...acmePlugin, summary: 'x'.repeat(601) })).toEqual([
      'summary: expected at most 600 characters',
    ]);
  });

  test('icon is optional, and the path data of one SVG path when present', () => {
    expect(pluginIssues({ ...acmePlugin, icon: 'M12 2 22 22H2Z' })).toEqual([]);
    expect(pluginIssues({ ...acmePlugin, icon: 'm4.5 3.25h15a1 1 0 0 1 1 1v15z' })).toEqual([]);
    const issue = 'icon: expected the path data of one SVG path (`M…`) when present';
    expect(pluginIssues({ ...acmePlugin, icon: '' })).toEqual([issue]);
    expect(pluginIssues({ ...acmePlugin, icon: '   ' })).toEqual([issue]);
    expect(pluginIssues({ ...acmePlugin, icon: '<svg><path d="M0 0"/></svg>' })).toEqual([issue]);
    expect(pluginIssues({ ...acmePlugin, icon: 'url(javascript:alert(1))' })).toEqual([issue]);
    expect(pluginIssues({ ...acmePlugin, icon: 'M0 0"/><script>' })).toEqual([issue]);
  });

  test('secretArguments is optional; it names declared arguments of declared tools', () => {
    const tool = 'acme__update_thing';
    expect(pluginIssues({ ...acmePlugin, secretArguments: { [tool]: ['name'] } })).toEqual([]);
    expect(
      pluginIssues({
        ...acmePlugin,
        secretArguments: [] as unknown as Record<string, readonly string[]>,
      }),
    ).toEqual(['secretArguments: expected an object keyed by tool name when present']);
    expect(pluginIssues({ ...acmePlugin, secretArguments: { acme__nope: ['name'] } })).toEqual([
      "secretArguments['acme__nope'] is not a tool of this plugin",
    ]);
    expect(pluginIssues({ ...acmePlugin, secretArguments: { [tool]: [] } })).toEqual([
      `secretArguments['${tool}']: expected a non-empty list of argument names`,
    ]);
    expect(pluginIssues({ ...acmePlugin, secretArguments: { [tool]: ['password'] } })).toEqual([
      `secretArguments['${tool}']: 'password' is not an argument of the tool`,
    ]);
  });

  test('resourceCreatingTools is optional; it names MCP tools of the plugin, once each', () => {
    const [tool] = acmePlugin.tools;
    const name = tool!.name;
    expect(pluginIssues({ ...acmePlugin, resourceCreatingTools: [name] })).toEqual([]);
    expect(pluginIssues({ ...acmePlugin, resourceCreatingTools: [] })).toEqual([
      'resourceCreatingTools: expected a non-empty list of tool names when present',
    ]);
    expect(
      pluginIssues({ ...acmePlugin, resourceCreatingTools: ['acme__create_nothing'] }),
    ).toEqual(["resourceCreatingTools: 'acme__create_nothing' is not a tool of this plugin"]);
    expect(pluginIssues({ ...acmePlugin, resourceCreatingTools: [name, name] })).toEqual([
      `resourceCreatingTools: '${name}' is listed twice`,
    ]);
    expect(() =>
      definePlugin({ ...acmePlugin, resourceCreatingTools: ['acme__create_nothing'] }),
    ).toThrow(PluginDefinitionError);
  });

  test('toolTitles is optional; a title names a declared tool and reads as a headline', () => {
    const [tool] = acmePlugin.tools;
    const name = tool!.name;
    expect(pluginIssues({ ...acmePlugin, toolTitles: { [name]: 'List things' } })).toEqual([]);
    expect(pluginIssues({ ...acmePlugin, toolTitles: {} })).toEqual([]);
    expect(
      pluginIssues({ ...acmePlugin, toolTitles: [] as unknown as Record<string, string> }),
    ).toEqual(['toolTitles: expected an object keyed by tool name when present']);
    expect(pluginIssues({ ...acmePlugin, toolTitles: { acme__no_such_tool: 'Do it' } })).toEqual([
      "toolTitles['acme__no_such_tool'] is not a tool of this plugin",
    ]);
    expect(pluginIssues({ ...acmePlugin, toolTitles: { [name]: '  ' } })).toEqual([
      `toolTitles['${name}']: expected a non-empty string`,
    ]);
    expect(pluginIssues({ ...acmePlugin, toolTitles: { [name]: 'list things.' } })).toEqual([
      `toolTitles['${name}']: a title has no final period`,
      `toolTitles['${name}']: a title starts with a capital letter`,
    ]);
    expect(pluginIssues({ ...acmePlugin, toolTitles: { [name]: `L${'x'.repeat(60)}` } })).toEqual([
      `toolTitles['${name}']: expected at most 60 characters`,
    ]);
    expect(pluginIssues({ ...acmePlugin, toolTitles: { [name]: 'List\nthings' } })).toEqual([
      `toolTitles['${name}']: expected a single line without surrounding spaces`,
    ]);
  });

  test('manualRevocation is optional, and a sentence or two when present; revoke is a function', () => {
    const sentence = 'Delete the API key in the Acme dashboard, under API keys.';
    expect(pluginIssues({ ...acmePlugin, manualRevocation: sentence })).toEqual([]);
    expect(pluginIssues({ ...acmePlugin, manualRevocation: ' ' })).toEqual([
      'manualRevocation: expected a non-empty string when present',
    ]);
    expect(pluginIssues({ ...acmePlugin, manualRevocation: 'x'.repeat(401) })).toEqual([
      'manualRevocation: expected at most 400 characters',
    ]);
    expect(pluginIssues({ ...acmePlugin, revoke: async () => undefined })).toEqual([]);
    expect(pluginIssues({ ...acmePlugin, revoke: 'yes' } as unknown as ProviderPlugin)).toEqual([
      'revoke: expected a function when present',
    ]);
  });

  test('an oauth2 revocation block names an https endpoint and one of the two request shapes', () => {
    const oauth = (extra: Record<string, unknown>): ProviderPlugin => ({
      ...acmePlugin,
      credential: {
        kind: 'oauth2',
        authorizationUrl: 'https://auth.example/authorize',
        tokenUrl: 'https://auth.example/token',
        scopes: ['read'],
        pkce: true,
        clientAuthMethod: 'client_secret_basic',
        refreshable: true,
        ...extra,
      },
    });
    const url = 'https://auth.example/revoke';
    expect(pluginIssues(oauth({ revocation: { url, format: 'token-form' } }))).toEqual([]);
    expect(pluginIssues(oauth({ revocation: { url, format: 'client-credentials-json' } }))).toEqual(
      [],
    );
    expect(
      pluginIssues(oauth({ revocation: { url: 'http://auth.example/revoke', format: 'rfc7009' } })),
    ).toEqual([
      'credential.revocation.url: expected an https URL',
      'credential.revocation.format: expected one of token-form | client-credentials-json',
    ]);
    expect(pluginIssues(oauth({ revocation: 'https://auth.example/revoke' }))).toEqual([
      'credential.revocation: expected { url, format }',
    ]);
    // The JSON shape carries the client secret and a refresh token: both must exist.
    for (const extra of [{ clientAuthMethod: 'none' }, { refreshable: false }]) {
      expect(
        pluginIssues(oauth({ ...extra, revocation: { url, format: 'client-credentials-json' } })),
      ).toEqual([
        "credential.revocation.format: 'client-credentials-json' needs a confidential client and refresh tokens",
      ]);
    }
  });

  test('a token handout names a declared tool and risks of the catalog', () => {
    const [tool] = acmePlugin.tools;
    const [risk] = acmePlugin.catalog.risks;
    const withHandout = (tokenHandouts: unknown): ProviderPlugin =>
      ({ ...acmePlugin, tokenHandouts }) as ProviderPlugin;
    expect(
      pluginIssues(
        withHandout([{ tool: tool!.name, riskIds: [risk!.id], readOnlyRiskIds: [risk!.id] }]),
      ),
    ).toEqual([]);
    expect(pluginIssues(withHandout('yes'))).toEqual([
      'tokenHandouts: expected a list when present',
    ]);
    expect(pluginIssues(withHandout([{ tool: 'acme__nope', riskIds: [] }, 3]))).toEqual([
      "tokenHandouts[0].tool 'acme__nope' is not a tool of this plugin",
      'tokenHandouts[0].riskIds: expected at least one risk',
      'tokenHandouts[1]: expected { tool, riskIds }',
    ]);
    expect(pluginIssues(withHandout([{ tool: tool!.name, riskIds: ['acme.unknown'] }]))).toEqual([
      "tokenHandouts[0].riskIds: 'acme.unknown' is not a risk of the catalog",
    ]);
  });

  // Spec §2.4: in a preset, a token-handing risk that grants write is gated by
  // approval; a read-only one may be automatic. Undeclared means write.
  describe('a preset and the token-handing risks', () => {
    const [tool] = acmePlugin.tools;
    const handing = (riskIds: string[], readOnlyRiskIds?: unknown): ProviderPlugin =>
      ({
        ...acmePlugin,
        tokenHandouts: [{ tool: tool!.name, riskIds, readOnlyRiskIds }],
      }) as ProviderPlugin;

    test('a write token left on auto is refused, where it is left on auto', () => {
      // `acme.thing-write` is on auto in staging and on approval in prod.
      expect(pluginIssues(handing(['acme.thing-write']))).toEqual([
        expect.stringMatching(
          /^catalog: preset 'developer': 'acme\[staging\]\.thing-write' hands the agent a token that can write ; its gate must be 'approval'/,
        ),
      ]);
    });

    test('a risk that is not declared read-only is taken as write', () => {
      const issues = pluginIssues(handing(['acme.read-things']));
      expect(issues).toHaveLength(2);
      expect(issues[0]).toContain("preset 'reader': 'acme.read-things'");
      expect(issues[1]).toContain("preset 'developer': 'acme.read-things'");
    });

    test('a declared read-only token may stay on auto', () => {
      expect(pluginIssues(handing(['acme.read-things'], ['acme.read-things']))).toEqual([]);
    });

    test('read-only is declared among the risks of the handout, as a list', () => {
      expect(pluginIssues(handing(['acme.read-things'], ['acme.thing-write']))).toEqual(
        expect.arrayContaining([
          "tokenHandouts[0].readOnlyRiskIds: 'acme.thing-write' is not one of its riskIds",
        ]),
      );
      expect(pluginIssues(handing(['acme.read-things'], 'all'))).toEqual(
        expect.arrayContaining(['tokenHandouts[0].readOnlyRiskIds: expected a list when present']),
      );
    });
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

  // A catalog written in TypeScript never goes through the YAML loader: the
  // budget rule (spec §3.2, "always numbers, never unbounded") must hold on
  // this path too, for `definePlugin`, the registry and the test kit.
  describe('budget rules on a TypeScript catalog', () => {
    const withEntry = (entry: Record<string, unknown>): ProviderPlugin =>
      ({
        ...acmePlugin,
        catalog: {
          ...acmePlugin.catalog,
          presets: [
            {
              id: 'ts-preset',
              label: 'TS',
              description: 'Declared in TypeScript.',
              entries: [
                {
                  risk_id: 'acme.read-things',
                  quota: 10,
                  rate_limit: { max: 1, window_seconds: 60 },
                  gate: 'auto',
                  ...entry,
                },
              ],
            },
          ],
        },
      }) as unknown as ProviderPlugin;
    const at = 'catalog: presets[0].entries[0]';

    test('a legal budget passes', () => {
      expect(pluginIssues(withEntry({}))).toEqual([]);
    });

    test.each([
      ['an infinite quota', { quota: Infinity }, `${at}.quota: expected a positive integer`],
      ['a zero quota', { quota: 0 }, `${at}.quota: expected a positive integer`],
      ['a fractional quota', { quota: 1.5 }, `${at}.quota: expected a positive integer`],
      ['a missing quota', { quota: undefined }, `${at}.quota: expected a positive integer`],
      [
        'a negative rate',
        { rate_limit: { max: -1, window_seconds: 60 } },
        `${at}.rate_limit.max: expected a positive integer`,
      ],
      [
        'a zero window',
        { rate_limit: { max: 1, window_seconds: 0 } },
        `${at}.rate_limit.window_seconds: expected a positive integer`,
      ],
      [
        'a missing rate limit',
        { rate_limit: undefined },
        `${at}.rate_limit: expected { max, window_seconds }`,
      ],
      ['a bogus gate', { gate: 'whatever' }, `${at}.gate: expected one of auto | approval`],
      ['a missing gate', { gate: undefined }, `${at}.gate: expected one of auto | approval`],
    ])('%s is refused', (_name, entry, expected) => {
      const issues = pluginIssues(withEntry(entry));
      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain(expected);
      expect(() => definePlugin(withEntry(entry))).toThrow(PluginDefinitionError);
      expect(() => new PluginRegistry([withEntry(entry)])).toThrow(PluginRegistryError);
      expect(() => assertPresetsValid(withEntry(entry))).toThrow(PluginAssertionError);
      expect(() => assertPluginWellFormed(withEntry(entry))).toThrow(PluginAssertionError);
    });

    test('every illegal value of one entry is listed', () => {
      const issues = pluginIssues(
        withEntry({
          quota: Infinity,
          rate_limit: { max: -1, window_seconds: 0 },
          gate: 'whatever',
        }),
      );
      expect(issues).toHaveLength(4);
    });
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
    // standard refresh_token grant from the spec.
    expect(oauthIssues.filter((m) => /refresh/.test(m))).toEqual([]);

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

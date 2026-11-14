import { describe, expect, test } from 'vitest';

import {
  PluginDefinitionError,
  RETIRED_TOKEN_HANDOUTS_ISSUE,
  definePlugin,
  pluginIssues,
} from '../../src/define-plugin.ts';
import type { ProviderPlugin } from '../../src/plugin.ts';
import {
  CredentialKindMismatch,
  expectCredentialKind,
  isBrokeredSpec,
} from '../../src/credential.ts';
import { PluginRegistry, PluginRegistryError } from '../../src/registry.ts';
import { RETIRED_PRESETS_ISSUE } from '../../src/catalog-rules.ts';
import { PluginAssertionError, assertPluginWellFormed } from '../../src/testing/assertions.ts';
import { apiKeyCredentialFixture } from '../../src/testing/guide.ts';
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

  test('iconColor is optional, and one #RRGGBB colour when present', () => {
    expect(pluginIssues({ ...acmePlugin, iconColor: '#635BFF' })).toEqual([]);
    expect(pluginIssues({ ...acmePlugin, iconColor: '#3fcf8e' })).toEqual([]);
    const issue = 'iconColor: expected a colour as `#RRGGBB` when present';
    expect(pluginIssues({ ...acmePlugin, iconColor: '' })).toEqual([issue]);
    expect(pluginIssues({ ...acmePlugin, iconColor: '#fff' })).toEqual([issue]);
    expect(pluginIssues({ ...acmePlugin, iconColor: 'rebeccapurple' })).toEqual([issue]);
    expect(pluginIssues({ ...acmePlugin, iconColor: '#635BFF; background: url(x)' })).toEqual([
      issue,
    ]);
  });

  test('resourceNoun is optional, and two lowercase nouns when present', () => {
    const noun = (one: unknown, other: unknown) =>
      pluginIssues({
        ...acmePlugin,
        resourceNoun: { one, other } as ProviderPlugin['resourceNoun'],
      });
    expect(noun('board', 'boards')).toEqual([]);
    expect(noun('library index', 'library indexes')).toEqual([]);
    expect(noun('sub-account', 'sub-accounts')).toEqual([]);
    expect(noun('', 'boards')).toEqual(['resourceNoun.one: expected a non-empty string']);
    expect(noun('board', '   ')).toEqual(['resourceNoun.other: expected a non-empty string']);
    expect(noun('board', undefined)).toEqual(['resourceNoun.other: expected a non-empty string']);
    expect(noun('x'.repeat(41), 'boards')).toEqual([
      'resourceNoun.one: expected at most 40 characters',
    ]);
    for (const bad of [
      'Board',
      ' board',
      'board ',
      'two  spaces',
      'line\nbreak',
      'board.',
      '<b>',
    ]) {
      expect(noun(bad, 'boards')).toEqual([
        expect.stringMatching(/^resourceNoun\.one: expected a lowercase noun/),
      ]);
    }
    expect(
      pluginIssues({
        ...acmePlugin,
        resourceNoun: 'board' as unknown as ProviderPlugin['resourceNoun'],
      }),
    ).toEqual(['resourceNoun: expected { one, other } when present']);
    expect(() =>
      definePlugin({ ...acmePlugin, resourceNoun: { one: 'Board', other: 'boards' } }),
    ).toThrow(PluginDefinitionError);
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

  test('excludedTools is optional; it names tools the plugin does not declare, one sentence each', () => {
    const reason = 'It runs whatever the provider does with it.';
    expect(pluginIssues({ ...acmePlugin, excludedTools: { acme__dispatch: reason } })).toEqual([]);
    expect(
      pluginIssues({
        ...acmePlugin,
        excludedTools: ['acme__dispatch'] as unknown as Record<string, string>,
      }),
    ).toEqual(['excludedTools: expected a record tool → reason']);
    expect(pluginIssues({ ...acmePlugin, excludedTools: { acme__update_thing: reason } })).toEqual([
      "excludedTools: 'acme__update_thing' is a declared tool of this plugin, it cannot be excluded",
    ]);
    expect(pluginIssues({ ...acmePlugin, excludedTools: { acme__dispatch: '  ' } })).toEqual([
      'excludedTools.acme__dispatch: expected one sentence saying why',
    ]);
  });

  test('examples is optional; it maps tools of the plugin to well-formed sample calls', () => {
    const tool = 'acme__update_thing';
    expect(pluginIssues({ ...acmePlugin, examples: { [tool]: [{ args: { id: 'x' } }] } })).toEqual(
      [],
    );
    expect(
      pluginIssues({ ...acmePlugin, examples: [] as unknown as ProviderPlugin['examples'] }),
    ).toEqual(['examples: expected a record tool → sample calls']);
    expect(pluginIssues({ ...acmePlugin, examples: { acme__nope: [{ args: {} }] } })).toEqual([
      "examples: 'acme__nope' is not a tool of this plugin",
    ]);
    expect(pluginIssues({ ...acmePlugin, examples: { [tool]: [] } })).toEqual([
      `examples.${tool}: expected a non-empty list of sample calls`,
    ]);
    const malformed = {
      [tool]: [{ args: 'x' }, { args: {}, resources: 'all', expectDenied: 'yes' }],
    } as unknown as ProviderPlugin['examples'];
    expect(pluginIssues({ ...acmePlugin, examples: malformed })).toEqual([
      `examples.${tool}[0].args: expected an object`,
      `examples.${tool}[1].resources: expected a list when present`,
      `examples.${tool}[1].expectDenied: expected a boolean when present`,
    ]);
  });

  test('resourceCreatingTools is optional; it names MCP tools of the plugin, once each', () => {
    const [tool] = acmePlugin.tools;
    const name = tool!.name;
    const reader = { createdResources: () => [] };
    expect(pluginIssues({ ...acmePlugin, ...reader, resourceCreatingTools: [name] })).toEqual([]);
    expect(pluginIssues({ ...acmePlugin, ...reader, resourceCreatingTools: [] })).toEqual([
      'resourceCreatingTools: expected a non-empty list of tool names when present',
    ]);
    expect(
      pluginIssues({ ...acmePlugin, ...reader, resourceCreatingTools: ['acme__create_nothing'] }),
    ).toEqual(["resourceCreatingTools: 'acme__create_nothing' is not a tool of this plugin"]);
    expect(pluginIssues({ ...acmePlugin, ...reader, resourceCreatingTools: [name, name] })).toEqual(
      [`resourceCreatingTools: '${name}' is listed twice`],
    );
    expect(() =>
      definePlugin({ ...acmePlugin, ...reader, resourceCreatingTools: ['acme__create_nothing'] }),
    ).toThrow(PluginDefinitionError);
  });

  test('a plugin that declares resourceCreatingTools reads the created resource (createdResources)', () => {
    const name = acmePlugin.tools[0]!.name;
    expect(pluginIssues({ ...acmePlugin, resourceCreatingTools: [name] })).toEqual([
      'createdResources: required when resourceCreatingTools is declared (read the created resource from the answer)',
    ]);
    expect(() => definePlugin({ ...acmePlugin, resourceCreatingTools: [name] })).toThrow(
      PluginDefinitionError,
    );
    // The hook alone is harmless (nothing calls it); a non-function is refused.
    expect(pluginIssues({ ...acmePlugin, createdResources: () => [] })).toEqual([]);
    expect(
      pluginIssues({
        ...acmePlugin,
        createdResources: 'nope' as unknown as ProviderPlugin['createdResources'],
      }),
    ).toEqual(['createdResources: expected a function when present']);
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
        clientRegistration: { registrationUrl: 'https://auth.example/register' },
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

  test('an oauth2 spec names the registration endpoint of the client the gateway registers itself', () => {
    // No administrator declares an OAuth client (ADR gmail-over-imap-with-an-app-password).
    const oauth = (clientRegistration: unknown): ProviderPlugin =>
      ({
        ...acmePlugin,
        credential: {
          kind: 'oauth2',
          authorizationUrl: 'https://auth.example/authorize',
          tokenUrl: 'https://auth.example/token',
          scopes: ['read'],
          pkce: true,
          clientAuthMethod: 'client_secret_basic',
          refreshable: true,
          ...(clientRegistration === undefined ? {} : { clientRegistration }),
        },
      }) as ProviderPlugin;
    expect(pluginIssues(oauth({ registrationUrl: 'https://auth.example/register' }))).toEqual([]);
    expect(pluginIssues(oauth(undefined))).toEqual([
      'credential.clientRegistration: expected { registrationUrl }',
    ]);
    expect(pluginIssues(oauth({ registrationUrl: 'http://auth.example/register' }))).toEqual([
      'credential.clientRegistration.registrationUrl: expected an https URL',
    ]);
  });

  test('an oauth2 spec names one client source: a registered client or a broker (ADR google-calendar-through-an-oauth-broker D3)', () => {
    const brokered = (credential: Record<string, unknown>): ProviderPlugin =>
      ({
        ...acmePlugin,
        credential: { kind: 'oauth2', scopes: ['read'], ...credential },
      }) as unknown as ProviderPlugin;
    expect(pluginIssues(brokered({ broker: { provider: 'google' } }))).toEqual([]);
    expect(pluginIssues(brokered({ broker: { provider: 'Google' } }))).toEqual([
      "credential.broker: expected { provider } with a lowercase slug such as 'google'",
    ]);
    expect(pluginIssues(brokered({ broker: 'google' }))).toEqual([
      "credential.broker: expected { provider } with a lowercase slug such as 'google'",
    ]);
    expect(
      pluginIssues(
        brokered({
          broker: { provider: 'google' },
          clientRegistration: { registrationUrl: 'https://auth.example/register' },
        }),
      ),
    ).toEqual(['credential: declare one client source, clientRegistration or broker, not both']);
    // The provider's endpoints, PKCE and the client are the broker's.
    expect(
      pluginIssues(
        brokered({
          broker: { provider: 'google' },
          tokenUrl: 'https://auth.example/token',
          refreshable: true,
        }),
      ),
    ).toEqual([
      'credential.tokenUrl: a brokered spec leaves it to the broker',
      'credential.refreshable: a brokered spec leaves it to the broker',
    ]);
    expect(isBrokeredSpec({ kind: 'oauth2', broker: { provider: 'google' }, scopes: [] })).toBe(
      true,
    );
  });

  test('a plugin that still declares tokenHandouts is refused: no tool hands a token', () => {
    const [tool] = acmePlugin.tools;
    const [risk] = acmePlugin.catalog.risks;
    const withHandouts = {
      ...acmePlugin,
      tokenHandouts: [{ tool: tool!.name, riskIds: [risk!.id] }],
    } as unknown as ProviderPlugin;
    expect(pluginIssues(withHandouts)).toEqual([RETIRED_TOKEN_HANDOUTS_ISSUE]);
    expect(pluginIssues(acmePlugin)).toEqual([]);
  });

  test('catalog rules apply (retired presets) through the definition', () => {
    const withPresets = {
      ...acmePlugin,
      catalog: { ...acmePlugin.catalog, presets: [] },
    } as ProviderPlugin;
    expect(pluginIssues(withPresets)).toEqual([`catalog: ${RETIRED_PRESETS_ISSUE}`]);
  });

  // A catalog written in TypeScript never goes through the YAML loader: the
  // budget rule (spec §3.2, "always numbers, never unbounded") must hold on
  // this path too, for `definePlugin`, the registry and the test kit.
  describe('budget rules on a TypeScript catalog', () => {
    const [first, ...others] = acmePlugin.catalog.macro_actions ?? [];
    const withEntry = (entry: Record<string, unknown>): ProviderPlugin =>
      ({
        ...acmePlugin,
        catalog: {
          ...acmePlugin.catalog,
          macro_actions: [
            {
              ...first,
              entries: [
                {
                  risk_id: 'acme.read-things',
                  quota: 10,
                  rate_limit: { max: 1, window_seconds: 60 },
                  ...entry,
                },
              ],
            },
            ...others,
          ],
        },
      }) as unknown as ProviderPlugin;
    const at = 'catalog: macro_actions[0].entries[0]';

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
    ])('%s is refused', (_name, entry, expected) => {
      const issues = pluginIssues(withEntry(entry));
      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain(expected);
      expect(() => definePlugin(withEntry(entry))).toThrow(PluginDefinitionError);
      expect(() => new PluginRegistry([withEntry(entry)])).toThrow(PluginRegistryError);
      expect(() => assertPluginWellFormed(withEntry(entry))).toThrow(PluginAssertionError);
    });

    test('every illegal value of one entry is listed', () => {
      const issues = pluginIssues(
        withEntry({
          quota: Infinity,
          rate_limit: { max: -1, window_seconds: 0 },
        }),
      );
      expect(issues).toHaveLength(3);
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

  test('a live catalog pattern off the data model is refused ; a deprecated one is not read', () => {
    const [first, ...rest] = acmePlugin.catalog.risks;
    if (!first) throw new Error('the acme fixture has risks');
    const typo = { ...first, matches: 'acme.space[**].thnig[**].R' };
    const offModel: ProviderPlugin = {
      ...acmePlugin,
      catalog: { ...acmePlugin.catalog, risks: [typo, ...rest] },
    };
    expect(pluginIssues(offModel)).toEqual([
      `catalog: risks[0] '${first.id}' matches 'acme.space[**].thnig[**].R': 'thnig' is not below 'space' : did you mean 'thing' ?`,
    ]);
    const retired: ProviderPlugin = {
      ...acmePlugin,
      catalog: { ...acmePlugin.catalog, risks: [{ ...typo, deprecated: true }, ...rest] },
    };
    expect(pluginIssues(retired).filter((m) => m.includes('thnig'))).toEqual([]);
  });

  test('credential spec rules per kind', () => {
    const noSecret: ProviderPlugin = {
      ...acmePlugin,
      credential: apiKeyCredentialFixture([{ name: 'account', label: 'Account', secret: false }]),
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
        clientRegistration: { registrationUrl: 'https://auth.example/register' },
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

    // A host account declares its kind and nothing else: no field, no guide, no check.
    const host: ProviderPlugin = { ...acmePlugin, credential: { kind: 'host' } };
    expect(pluginIssues(host)).toEqual([]);
    const hostWithField = {
      ...acmePlugin,
      credential: { kind: 'host', fields: [{ name: 'token', label: 'Token', secret: true }] },
    } as unknown as ProviderPlugin;
    expect(pluginIssues(hostWithField)).toEqual([
      'credential: a host account declares nothing but its kind (fields)',
    ]);

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
  test('a host secret carries its kind and no material', () => {
    const host = { kind: 'host', metadata: {} } as const;
    expect(expectCredentialKind('acme', host, 'host')).toEqual({ kind: 'host', metadata: {} });
    expect(() => expectCredentialKind('acme', host, 'api-key')).toThrow(CredentialKindMismatch);
  });
});

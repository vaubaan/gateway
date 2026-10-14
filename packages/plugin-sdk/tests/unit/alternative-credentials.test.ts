import { describe, expect, test } from 'vitest';

import {
  appCredentialSpecOf,
  credentialSpecFor,
  credentialSpecsOf,
  unavailableToolReason,
  type ApiKeyCredentialSpec,
  type CredentialSpec,
  type OAuth2CredentialSpec,
} from '../../src/credential.ts';
import { pluginIssues } from '../../src/define-plugin.ts';
import type { ProviderPlugin } from '../../src/plugin.ts';
import { acmePlugin } from '../fixtures/acme/acme-plugin.ts';

const OAUTH: OAuth2CredentialSpec = {
  kind: 'oauth2',
  authorizationUrl: 'https://acme.example/oauth/authorize',
  tokenUrl: 'https://acme.example/oauth/token',
  scopes: [],
  pkce: true,
  clientAuthMethod: 'client_secret_basic',
  refreshable: true,
};

const TOKEN: ApiKeyCredentialSpec = {
  kind: 'api-key',
  label: 'personal access token',
  fields: [{ name: 'token', label: 'Token', secret: true }],
  createUrl: 'https://acme.example/tokens',
  unavailableTools: { acme__update_thing: 'needs the Acme app: a token cannot update things.' },
  manualRevocation: 'Delete the token on the Acme tokens page.',
  guide: {
    steps: ['Open the tokens page.', 'Create a token.'],
    permissions: [{ name: 'Things', access: 'read', tools: ['acme__list_things'] }],
    recommendedExpiryDays: 90,
  },
  verify: () => Promise.resolve({ account: 'acme-bot', expiresAt: null }),
};

function withCredentials(primary: CredentialSpec, alternatives: unknown): ProviderPlugin {
  return {
    ...acmePlugin,
    credential: primary,
    alternativeCredentials: alternatives,
  } as ProviderPlugin;
}

describe('alternative credentials', () => {
  test('an app plus a token is well-formed and read as one ordered declaration', () => {
    const plugin = withCredentials(OAUTH, [TOKEN]);
    expect(pluginIssues(plugin)).toEqual([]);
    expect(credentialSpecsOf(plugin).map((s) => s.kind)).toEqual(['oauth2', 'api-key']);
    expect(credentialSpecFor(plugin, 'api-key')).toBe(TOKEN);
    expect(credentialSpecFor(plugin, 'ssh-key')).toBeNull();
    expect(appCredentialSpecOf(plugin)).toBe(OAUTH);
    expect(appCredentialSpecOf(acmePlugin)).toBeNull();
  });

  test('unavailable tools are per kind', () => {
    const plugin = withCredentials(OAUTH, [TOKEN]);
    expect(unavailableToolReason(plugin, 'oauth2', 'acme__update_thing')).toBeNull();
    expect(unavailableToolReason(plugin, 'api-key', 'acme__update_thing')).toMatch(
      /needs the Acme app/,
    );
    expect(unavailableToolReason(plugin, 'api-key', 'acme__list_things')).toBeNull();
    expect(unavailableToolReason(plugin, 'ssh-key', 'acme__list_things')).toMatch(
      /cannot be connected/,
    );
  });

  test('a kind declared twice and two company apps are refused', () => {
    expect(pluginIssues(withCredentials(TOKEN, [TOKEN]))).toContain(
      "alternativeCredentials: kind 'api-key' is declared twice",
    );
    const install = {
      kind: 'app-install',
      appConfigFields: [{ name: 'app_id', label: 'App', secret: false }],
      installUrl: () => 'https://acme.example/install',
      installationIdParam: 'installation_id',
    } as CredentialSpec;
    expect(pluginIssues(withCredentials(OAUTH, [install]))).toContain(
      'alternativeCredentials: at most one way of connecting may go through a company app',
    );
  });

  test('an alternative is validated like a primary spec, under its own path', () => {
    const broken = { ...TOKEN, fields: [] } as ApiKeyCredentialSpec;
    expect(pluginIssues(withCredentials(OAUTH, [broken]))).toContain(
      'alternativeCredentials[0].fields: expected at least one field',
    );
    expect(pluginIssues(withCredentials(OAUTH, 'nope'))).toContain(
      'alternativeCredentials: expected a list when present',
    );
  });

  test('unavailable tools name real tools with a reason', () => {
    const issues = pluginIssues(
      withCredentials(OAUTH, [
        { ...TOKEN, unavailableTools: { acme__nothing: '', acme__update_thing: 'x' } },
      ]),
    );
    expect(issues).toContain(
      "alternativeCredentials[0].unavailableTools: 'acme__nothing' is not a tool of this plugin",
    );
    expect(issues).toContain(
      'alternativeCredentials[0].unavailableTools.acme__nothing: expected one sentence saying why',
    );
  });

  test('the guide covers every tool the token can run, and only real ones', () => {
    const uncovered = { ...TOKEN, unavailableTools: {} } as ApiKeyCredentialSpec;
    expect(pluginIssues(withCredentials(OAUTH, [uncovered]))).toContain(
      "alternativeCredentials[0].guide.permissions: no permission serves 'acme__update_thing'",
    );
    const wrong = {
      ...TOKEN,
      guide: {
        steps: [],
        permissions: [
          { name: 'Things', access: 'admin', tools: ['acme__list_things', 'acme__update_thing'] },
        ],
        recommendedExpiryDays: 0,
        docsUrl: 'http://acme.example',
      },
    } as unknown as ApiKeyCredentialSpec;
    const issues = pluginIssues(withCredentials(OAUTH, [wrong]));
    expect(issues).toEqual(
      expect.arrayContaining([
        'alternativeCredentials[0].guide.steps: expected at least one step',
        'alternativeCredentials[0].guide.recommendedExpiryDays: expected a positive number of days or null',
        'alternativeCredentials[0].guide.docsUrl: expected an https URL when present',
        'alternativeCredentials[0].guide.permissions[0].access: expected one of read | read-write',
        "alternativeCredentials[0].guide.permissions[0].tools: 'acme__update_thing' is unavailable this way",
      ]),
    );
  });

  test('verify must be a function', () => {
    const issues = pluginIssues(
      withCredentials(OAUTH, [{ ...TOKEN, verify: 'yes' } as unknown as ApiKeyCredentialSpec]),
    );
    expect(issues).toContain('alternativeCredentials[0].verify: expected a function when present');
  });
});

import { describe, expect, test } from 'vitest';

import type { ApiKeyCredentialSpec, CredentialSpec } from '../../src/credential.ts';
import { pluginIssues } from '../../src/define-plugin.ts';
import type { ProviderPlugin } from '../../src/plugin.ts';
import { acmePlugin } from '../fixtures/acme/acme-plugin.ts';

const TOKEN: ApiKeyCredentialSpec = {
  kind: 'api-key',
  label: 'personal access token',
  fields: [{ name: 'token', label: 'Token', secret: true }],
  createUrl: 'https://acme.example/tokens',
  guide: {
    steps: ['Open the tokens page.', 'Create a token.'],
    permissions: [
      { name: 'Things', access: 'read', tools: ['acme__list_things'] },
      { name: 'Things', access: 'read-write', tools: ['acme__update_thing'] },
    ],
    recommendedExpiryDays: 90,
  },
  verify: () => Promise.resolve({ account: 'acme-bot', expiresAt: null }),
};

function withCredential(credential: CredentialSpec): ProviderPlugin {
  return { ...acmePlugin, credential };
}

describe('the token guide of an api-key credential', () => {
  test('a well-formed guide passes', () => {
    expect(pluginIssues(withCredential(TOKEN))).toEqual([]);
  });

  test('the guide covers every tool of the plugin, and only real ones', () => {
    const uncovered = {
      ...TOKEN,
      guide: { ...TOKEN.guide, permissions: [TOKEN.guide!.permissions[0]] },
    } as ApiKeyCredentialSpec;
    expect(pluginIssues(withCredential(uncovered))).toContain(
      "credential.guide.permissions: no permission serves 'acme__update_thing'",
    );
    const wrong = {
      ...TOKEN,
      guide: {
        steps: [],
        permissions: [
          { name: 'Things', access: 'admin', tools: ['acme__list_things', 'acme__nothing'] },
        ],
        recommendedExpiryDays: 0,
        docsUrl: 'http://acme.example',
      },
    } as unknown as ApiKeyCredentialSpec;
    const issues = pluginIssues(withCredential(wrong));
    expect(issues).toEqual(
      expect.arrayContaining([
        'credential.guide.steps: expected at least one step',
        'credential.guide.recommendedExpiryDays: expected a positive number of days or null',
        'credential.guide.docsUrl: expected an https URL when present',
        'credential.guide.permissions[0].access: expected one of read | read-write',
        "credential.guide.permissions[0].tools: 'acme__nothing' is not a tool of this plugin",
      ]),
    );
  });

  test('a provider whose tokens carry no permission choice lists none', () => {
    const noChoice = {
      ...TOKEN,
      guide: { ...TOKEN.guide, permissions: [] },
    } as ApiKeyCredentialSpec;
    expect(pluginIssues(withCredential(noChoice))).toEqual([]);
  });

  test('label, createUrl and verify are checked when present', () => {
    const issues = pluginIssues(
      withCredential({
        ...TOKEN,
        label: '',
        createUrl: 'http://acme.example/tokens',
        verify: 'yes',
      } as unknown as ApiKeyCredentialSpec),
    );
    expect(issues).toEqual(
      expect.arrayContaining([
        'credential.label: expected a short name when present',
        'credential.createUrl: expected an https URL when present',
        'credential.verify: expected a function when present',
      ]),
    );
  });
});

import { describe, expect, test } from 'vitest';

import type { ApiKeyCredentialSpec, CredentialSpec, TokenGuide } from '../../src/credential.ts';
import { pluginIssues } from '../../src/define-plugin.ts';
import type { ProviderPlugin } from '../../src/plugin.ts';
import { acmePlugin } from '../fixtures/acme/acme-plugin.ts';

const GUIDE: TokenGuide = {
  steps: [
    { do: 'Open the tokens page.', url: 'https://acme.example/tokens' },
    { do: 'Create a token.', code: 'acme tokens create --all' },
  ],
  reach: {
    what: 'Workspaces',
    grant: 'All workspaces',
    why: 'Each mission narrows what an agent may do.',
  },
  permissions: [
    { name: 'Things', access: 'read', tools: ['acme__list_things'] },
    { name: 'Things', access: 'read-write', tools: ['acme__update_thing'] },
  ],
  expiry: { kind: 'provider-reports' },
  docsUrl: 'https://acme.example/docs/tokens',
};

const TOKEN: ApiKeyCredentialSpec = {
  kind: 'api-key',
  label: 'personal access token',
  fields: [{ name: 'token', label: 'Token', secret: true }],
  createUrl: 'https://acme.example/tokens',
  guide: GUIDE,
  verify: () => Promise.resolve({ account: 'acme-bot', expiresAt: null }),
};

function withCredential(credential: CredentialSpec): ProviderPlugin {
  return { ...acmePlugin, credential };
}

function withGuide(guide: unknown): ProviderPlugin {
  return withCredential({ ...TOKEN, guide } as ApiKeyCredentialSpec);
}

describe('the token guide of an api-key credential', () => {
  test('a well-formed guide passes', () => {
    expect(pluginIssues(withCredential(TOKEN))).toEqual([]);
  });

  test('the guide covers every tool of the plugin, and only real ones', () => {
    expect(pluginIssues(withGuide({ ...GUIDE, permissions: [GUIDE.permissions[0]] }))).toContain(
      "credential.guide.permissions: no permission serves 'acme__update_thing'",
    );
    const issues = pluginIssues(
      withGuide({
        ...GUIDE,
        permissions: [
          { name: 'Things', access: 'admin', tools: ['acme__list_things', 'acme__nothing'] },
        ],
      }),
    );
    expect(issues).toEqual(
      expect.arrayContaining([
        'credential.guide.permissions[0].access: expected one of read | read-write',
        "credential.guide.permissions[0].tools: 'acme__nothing' is not a tool of this plugin",
      ]),
    );
  });

  test('a provider whose tokens carry no permission choice lists none', () => {
    expect(pluginIssues(withGuide({ ...GUIDE, permissions: [] }))).toEqual([]);
  });

  test('every step is a sentence to act on, its page https, its command not empty', () => {
    expect(pluginIssues(withGuide({ ...GUIDE, steps: [] }))).toContain(
      'credential.guide.steps: expected at least one step',
    );
    const issues = pluginIssues(
      withGuide({
        ...GUIDE,
        steps: ['Open the page.', { do: '', url: 'http://acme.example', code: '' }],
      }),
    );
    expect(issues).toEqual(
      expect.arrayContaining([
        'credential.guide.steps[0]: expected { do, url?, code? }',
        'credential.guide.steps[1].do: expected one plain sentence',
        'credential.guide.steps[1].url: expected an https URL when present',
        'credential.guide.steps[1].code: expected a non-empty command when present',
      ]),
    );
  });

  test('the guide says how wide to grant, and why', () => {
    expect(pluginIssues(withGuide({ ...GUIDE, reach: undefined }))).toContain(
      'credential.guide.reach: expected { what, grant, why }',
    );
    expect(pluginIssues(withGuide({ ...GUIDE, reach: { ...GUIDE.reach, why: ' ' } }))).toContain(
      'credential.guide.reach.why: expected one plain sentence',
    );
  });

  test.each([
    [{ kind: 'provider-reports' }, []],
    [{ kind: 'person-types', recommendedDays: 90 }, []],
    [{ kind: 'none', reason: 'Delete the key to end it.' }, []],
    [
      { kind: 'person-types', recommendedDays: 0 },
      ['credential.guide.expiry.recommendedDays: expected a positive number of days'],
    ],
    [
      { kind: 'none' },
      ['credential.guide.expiry.reason: expected one sentence saying how the token is ended'],
    ],
    [
      { kind: 'sometimes' },
      ['credential.guide.expiry.kind: expected one of provider-reports | person-types | none'],
    ],
  ])('the expiry %j is checked by its kind', (expiry, expected) => {
    expect(pluginIssues(withGuide({ ...GUIDE, expiry }))).toEqual(expected);
  });

  test('the guide points to the provider documentation over https', () => {
    expect(pluginIssues(withGuide({ ...GUIDE, docsUrl: 'http://acme.example' }))).toContain(
      'credential.guide.docsUrl: expected an https URL',
    );
  });

  test('a token way without its guide, label, token page or check at paste is refused', () => {
    const bare = { kind: 'api-key', fields: TOKEN.fields } as unknown as ApiKeyCredentialSpec;
    expect(pluginIssues(withCredential(bare))).toEqual([
      "credential.label: expected what the person creates, in the provider's words",
      'credential.verify: expected the check at paste, a function',
      'credential.createUrl: expected the https URL of the token page',
      'credential.guide: expected { steps, reach, permissions, expiry, docsUrl }',
    ]);
  });

  test('label, createUrl and verify are checked for their shape', () => {
    const issues = pluginIssues(
      withCredential({
        ...TOKEN,
        label: '',
        createUrl: 'http://acme.example/tokens',
        verify: 'yes',
      } as unknown as ApiKeyCredentialSpec),
    );
    expect(issues).toEqual([
      "credential.label: expected what the person creates, in the provider's words",
      'credential.verify: expected the check at paste, a function',
      'credential.createUrl: expected the https URL of the token page',
    ]);
  });
});

describe('the alternatives of an api-key credential', () => {
  const SPLIT: ApiKeyCredentialSpec = {
    ...TOKEN,
    fields: [
      { name: 'token', label: 'Token', secret: true },
      { name: 'workspace_id', label: 'Workspace ID', secret: false },
      { name: 'project_id', label: 'Project ID', secret: false },
    ],
    alternatives: [
      {
        id: 'workspace',
        label: 'Workspace',
        fields: ['workspace_id'],
        steps: [{ do: 'Copy the workspace ID.' }],
      },
      {
        id: 'project',
        label: 'One project',
        help: 'For a token scoped to one project.',
        fields: ['project_id'],
        steps: [{ do: 'Copy the project ID.' }],
      },
    ],
  };
  const [WORKSPACE, PROJECT] = SPLIT.alternatives!;

  function withAlternatives(alternatives: unknown): ProviderPlugin {
    return withCredential({ ...SPLIT, alternatives } as ApiKeyCredentialSpec);
  }

  test('well-formed alternatives pass', () => {
    expect(pluginIssues(withCredential(SPLIT))).toEqual([]);
  });

  test('a choice has two to four alternatives', () => {
    expect(pluginIssues(withAlternatives([WORKSPACE]))).toContain(
      'credential.alternatives: expected 2 to 4 alternatives',
    );
  });

  test('each has a unique slug, a label, steps, and fields of its own the spec declares', () => {
    const issues = pluginIssues(
      withAlternatives([
        WORKSPACE,
        { ...PROJECT, id: 'workspace', label: '', steps: [], fields: ['workspace_id', 'nope'] },
      ]),
    );
    expect(issues).toEqual(
      expect.arrayContaining([
        "credential.alternatives[1].id: 'workspace' is already the id of another alternative",
        'credential.alternatives[1].label: expected a few words',
        'credential.alternatives[1].steps: expected at least one step',
        "credential.alternatives[1].fields: 'workspace_id' already belongs to another alternative",
        "credential.alternatives[1].fields: 'nope' is not a field of this spec",
      ]),
    );
    expect(pluginIssues(withAlternatives([WORKSPACE, { ...PROJECT, id: 'Project X' }]))).toContain(
      "credential.alternatives[1].id: expected a lowercase slug such as 'team'",
    );
  });

  test('every alternative asks for a secret, shared or its own', () => {
    const issues = pluginIssues(
      withAlternatives([{ ...WORKSPACE, fields: ['workspace_id', 'token'] }, PROJECT]),
    );
    expect(issues).toContain('credential.alternatives[1]: asks for no secret field');
  });
});

/**
 * Token guides in tests : the words of a guide, for a plugin test that checks
 * what its guide says, and a complete `api-key` way for a test plugin whose
 * guide is not under test.
 */
import type { ApiKeyCredentialSpec, CredentialField, TokenGuide } from '../credential.ts';

/** Every step (sentence, page, command), then how wide to grant and why, as one string. */
export function guideText(guide: TokenGuide): string {
  const steps = guide.steps.flatMap((step) => [step.do, step.url ?? '', step.code ?? '']);
  return [...steps, guide.reach.what, guide.reach.grant, guide.reach.why]
    .filter((part) => part !== '')
    .join(' ');
}

/**
 * A complete `api-key` way over `fields` : a guide without permission choice
 * (so it covers any tool list) and a check at paste that names no account
 * and reads no expiry. For fixtures only; a shipped plugin writes its own.
 */
export function apiKeyCredentialFixture(
  fields: readonly CredentialField[],
  overrides: Partial<Omit<ApiKeyCredentialSpec, 'kind' | 'fields'>> = {},
): ApiKeyCredentialSpec {
  return {
    kind: 'api-key',
    label: 'API key',
    createUrl: 'https://provider.example.com/keys',
    fields,
    guide: {
      steps: [{ do: 'Create a key and paste it here.' }],
      reach: {
        what: 'Key',
        grant: 'The whole account',
        why: 'Each mission narrows what an agent may do.',
      },
      permissions: [],
      expiry: { kind: 'none', reason: 'Delete the key at the provider to end the account.' },
      docsUrl: 'https://provider.example.com/docs/keys',
    },
    verify: () => Promise.resolve({ account: null, expiresAt: null }),
    ...overrides,
  };
}

import { CredentialRefusal, UpstreamAuthError, UpstreamHttpError } from '@vaubaan/shared';
import { describe, expect, it } from 'vitest';

import { ConnectError, ProviderUnreachableError } from './errors';
import { providerFailureReason } from './failure-reason';
import { OAuth2TokenError } from './oauth2';

const ECHOED = 'sk_live_echoed_credential_value';

describe('providerFailureReason: the status and our own words, never the provider text', () => {
  it.each([
    [
      new UpstreamAuthError(`401: {"key":"${ECHOED}"}`, 401),
      'the provider rejected the credential (HTTP 401)',
    ],
    [new UpstreamHttpError(`500: ${ECHOED}`, 500), 'the provider answered HTTP 500'],
    [
      new OAuth2TokenError(
        `token endpoint answered 400 (invalid_grant: ${ECHOED})`,
        400,
        'invalid_grant',
        true,
      ),
      'the token endpoint answered HTTP 400 (invalid_grant)',
    ],
    [new OAuth2TokenError('x', 400, `bad ${ECHOED}`, true), 'the token endpoint answered HTTP 400'],
    [
      new OAuth2TokenError(`unreachable ${ECHOED}`, 0, null, false),
      'the token endpoint could not be reached',
    ],
    [new ProviderUnreachableError(ECHOED), 'the provider could not be reached'],
    [new TypeError(`fetch failed ${ECHOED}`), 'the provider could not be reached'],
    [
      Object.assign(new Error(ECHOED), { name: 'TimeoutError' }),
      'the provider did not answer in time',
    ],
    [new ConnectError('credential-rejected', ECHOED), 'credential-rejected'],
    [new Error(`GitHub said ${ECHOED}`), 'the provider call failed (Error)'],
    [Object.assign(new Error('x'), { name: ECHOED + ' !' }), 'the provider call failed'],
    [ECHOED, 'the provider call failed'],
  ])('%s', (err, expected) => {
    const reason = providerFailureReason(err);
    expect(reason).toBe(expected);
    expect(reason).not.toContain(ECHOED);
  });
});

describe('providerFailureReason: a refusal the plugin wrote itself is kept', () => {
  it('shows the sentence of a CredentialRefusal, on one bounded line', () => {
    const sentence = 'the token lacks the scope boards:write; give the app boards:write';
    expect(providerFailureReason(new CredentialRefusal(sentence, 403))).toBe(sentence);
    expect(providerFailureReason(new CredentialRefusal(`a\n  b ${'x'.repeat(400)}`))).toMatch(
      /^a b x+…$/,
    );
  });

  it('is still a rejected credential for everything that reads UpstreamAuthError', () => {
    const refusal = new CredentialRefusal('not the kind of token this needs', 401);
    expect(refusal).toBeInstanceOf(UpstreamAuthError);
    expect(refusal.upstreamStatus).toBe(401);
  });
});

describe('providerFailureReason: at connect time, the sentence of a rejection is kept, masked', () => {
  const credential = {
    kind: 'api-key' as const,
    fields: { user: 'bot@example.com', token: ECHOED },
    metadata: {},
  };

  it('keeps the plugin sentence, masks every value of the credential, adds the status', () => {
    const reason = providerFailureReason(
      new UpstreamAuthError(
        `refused ${ECHOED} for bot@example.com (${encodeURIComponent(ECHOED)})`,
        401,
      ),
      credential,
    );
    expect(reason).toBe('refused [credential] for [credential] ([credential]) (HTTP 401)');
    expect(reason).not.toContain(ECHOED);
  });

  it('says the status once when the sentence already does, on one bounded line', () => {
    expect(
      providerFailureReason(
        new UpstreamAuthError('Fly refused the token (HTTP 401)', 401),
        credential,
      ),
    ).toBe('Fly refused the token (HTTP 401)');
    const long = providerFailureReason(
      new UpstreamAuthError(`a\n${'b'.repeat(900)}`, 403),
      credential,
    );
    expect(long.length).toBeLessThanOrEqual(320);
    expect(long).not.toContain('\n');
  });

  it('keeps the status alone without the credential being connected (refresh, logs)', () => {
    expect(providerFailureReason(new UpstreamAuthError('Bad credentials', 401))).toBe(
      'the provider rejected the credential (HTTP 401)',
    );
  });
});

import { UpstreamAuthError, UpstreamHttpError } from '@vaubaan/shared';
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

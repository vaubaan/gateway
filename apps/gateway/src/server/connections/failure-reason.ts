/**
 * What the gateway itself keeps of a provider's failure: the HTTP status and a short
 * reason it writes itself — never text the provider sent (ADR
 * provider-error-text-stays-with-the-agent).
 *
 * A provider's error body can echo the credential it was given (the offending header,
 * a URL with `?apikey=`), on purpose or not. The plugins quote it in their error
 * messages for the calling agent; everything the gateway logs, persists (discovery
 * state, audit) or renders on a page goes through `providerFailureReason` instead.
 *
 * One exception, written by the plugin and not by the provider: a
 * `CredentialRefusal` carries a sentence the plugin authored ("the token lacks
 * the scope boards:write"), which is kept as it is (one line, bounded). The
 * plugin's rule is to quote nothing the provider sent in it (ADR
 * provider-error-text-stays-with-the-agent, amendment of 2026-10-21).
 */
import { CredentialRefusal, UpstreamAuthError, UpstreamHttpError } from '@vaubaan/shared';

import { ConnectError, oneLine, ProviderUnreachableError } from './errors';
import { OAuth2RegistrationError, OAuth2TokenError } from './oauth2';
import { OAuth2ClientMissing } from './oauth2-clients';

/** An OAuth `error` code is a token of the protocol (RFC 6749 §5.2), never free text. */
const OAUTH_ERROR_CODE = /^[a-z_]{1,40}$/;
/** An error class name is shown only when it looks like one. */
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9]{0,40}$/;

export function providerFailureReason(err: unknown): string {
  if (err instanceof CredentialRefusal) return oneLine(err.message);
  if (err instanceof UpstreamAuthError) {
    return `the provider rejected the credential (HTTP ${err.upstreamStatus})`;
  }
  if (err instanceof UpstreamHttpError) return `the provider answered HTTP ${err.status}`;
  if (err instanceof OAuth2TokenError) {
    if (err.status === 0) return 'the token endpoint could not be reached';
    const code =
      err.oauthError !== null && OAUTH_ERROR_CODE.test(err.oauthError)
        ? ` (${err.oauthError})`
        : '';
    return `the token endpoint answered HTTP ${err.status}${code}`;
  }
  if (err instanceof OAuth2RegistrationError) {
    if (err.status === 0) return 'the registration endpoint could not be reached';
    const code =
      err.oauthError !== null && OAUTH_ERROR_CODE.test(err.oauthError)
        ? ` (${err.oauthError})`
        : '';
    return `the registration endpoint answered HTTP ${err.status}${code}`;
  }
  if (err instanceof OAuth2ClientMissing) return 'no OAuth client is declared for this service';
  if (err instanceof ConnectError) return err.code;
  if (err instanceof ProviderUnreachableError) return 'the provider could not be reached';
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return 'the provider did not answer in time';
  }
  if (err instanceof TypeError) return 'the provider could not be reached';
  if (err instanceof Error && ERROR_NAME.test(err.name))
    return `the provider call failed (${err.name})`;
  return 'the provider call failed';
}

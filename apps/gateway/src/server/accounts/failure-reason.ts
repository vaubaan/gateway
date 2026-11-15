/**
 * What the gateway itself keeps of a service's failure: the HTTP status and a short
 * reason it writes itself — never text the service sent (ADR
 * provider-error-text-stays-with-the-agent).
 *
 * A service's error body can echo the credential it was given (the offending header,
 * a URL with `?apikey=`), on purpose or not. The plugins quote it in their error
 * messages for the calling agent; everything the gateway logs, persists (discovery
 * state, audit) or renders on a page goes through `serviceFailureReason` instead.
 *
 * One exception, written by the plugin and not by the service: a
 * `CredentialRefusal` carries a sentence the plugin authored ("the token lacks
 * the scope boards:write"), which is kept as it is (one line, bounded). The
 * plugin's rule is to quote nothing the service sent in it (ADR
 * provider-error-text-stays-with-the-agent, amendment of 2026-10-21).
 *
 * A second one, at connect time only (amendment of 2026-10-31): the sentence of an
 * `UpstreamAuthError` thrown while the person connects — "Gmail refused the IMAP
 * sign-in of x: the app password is wrong…" — names the fix, so it is kept, on one
 * line, bounded, with every value of the credential being connected masked first.
 * Only the connect page sees it: the caller passes the credential it just received,
 * and a call without one (refresh, a later discovery, the log) keeps the status
 * alone.
 */
import type { CredentialSecret } from '@vaubaan/plugin-sdk';
import {
  isCredentialRefusal,
  isUpstreamAuthError,
  isUpstreamHttpError,
  type UpstreamAuthError,
} from '@vaubaan/shared';

import {
  ConnectError,
  OAuthBrokerUnavailableError,
  oneLine,
  ServiceUnreachableError,
} from './errors';
import { OAuth2RegistrationError, OAuth2TokenError } from './oauth2';
import { OAuth2ClientMissing } from './oauth2-clients';
import { OAuthBrokerError } from './oauth-broker';

/** An OAuth `error` code is a token of the protocol (RFC 6749 §5.2), never free text. */
const OAUTH_ERROR_CODE = /^[a-z_]{1,40}$/;
/** An error class name is shown only when it looks like one. */
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9]{0,40}$/;

/** A credential value shorter than this is not masked (an empty field, a port). */
const MASKED_MIN_LENGTH = 4;
export const MASK = '[credential]';

/** Every string the credential carries (a token, a password, a user name, a key file). */
function credentialValues(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (typeof value === 'string') {
    if (value.length >= MASKED_MIN_LENGTH) into.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) credentialValues(item, into);
  } else if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) credentialValues(item, into);
  }
  return into;
}

/** The sentence with each value of the credential, as is and URL-encoded, replaced by `MASK`. */
export function maskCredential(sentence: string, credential: CredentialSecret): string {
  const values = [...credentialValues(credential)].flatMap((v) => [v, encodeURIComponent(v)]);
  // Longest first: a value that contains another is masked whole.
  values.sort((a, b) => b.length - a.length);
  let masked = sentence;
  for (const value of values) masked = masked.split(value).join(MASK);
  return masked;
}

/** The plugin's sentence of a rejection at connect time: masked, one bounded line, with its status. */
function connectSentence(err: UpstreamAuthError, credential: CredentialSecret): string {
  const line = oneLine(maskCredential(err.message, credential));
  const status = `HTTP ${err.upstreamStatus}`;
  return line.includes(status) ? line : `${line} (${status})`;
}

/**
 * The reason of a service failure in the gateway's words. `connecting`: the
 * credential the person is connecting right now, given only by the connect page's
 * checks (`verify`, the first discovery): a rejection then keeps the plugin's
 * sentence, masked.
 */
export function serviceFailureReason(err: unknown, connecting?: CredentialSecret): string {
  if (isCredentialRefusal(err)) return oneLine(err.message);
  if (isUpstreamAuthError(err)) {
    if (connecting !== undefined && err.message.trim() !== '') {
      return connectSentence(err, connecting);
    }
    return `the service rejected the credential (HTTP ${err.upstreamStatus})`;
  }
  if (isUpstreamHttpError(err)) return `the service answered HTTP ${err.status}`;
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
  if (err instanceof OAuth2ClientMissing) return 'no OAuth client is registered for this service';
  // The broker's failure, in the gateway's words (the message never quotes the broker).
  if (err instanceof OAuthBrokerError || err instanceof OAuthBrokerUnavailableError) {
    return oneLine(err.message);
  }
  if (err instanceof ConnectError) return err.code;
  if (err instanceof ServiceUnreachableError) return 'the service could not be reached';
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return 'the service did not answer in time';
  }
  if (err instanceof TypeError) return 'the service could not be reached';
  if (err instanceof Error && ERROR_NAME.test(err.name))
    return `the service call failed (${err.name})`;
  return 'the service call failed';
}

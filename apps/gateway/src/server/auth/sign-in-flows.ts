/**
 * One sign-in attempt, whatever the kind of the provider: OpenID Connect (the
 * relying party, `relying-party.ts`, then the claim mapping) or GitHub
 * (`github.ts`). Both start with a `state` and a PKCE verifier of their own
 * (OpenID Connect adds a nonce) and finish into the same `IdentityClaims`.
 *
 * The identity a provider produces is always of its own issuer: an ID token
 * whose `iss` is not the provider's issuer is refused here, whatever the
 * library already checked, because a user is (issuer, subject) and the
 * provider of a user is found by that issuer (sessions end when it is removed,
 * its groups count for the admin rule).
 */
import { issuerKey, type AdminGroup, type SignInProvider } from '../config/sign-in';
import { mapClaims, type IdentityClaims } from './claims';
import { LoginError } from './errors';
import { GithubSignIn } from './github';
import {
  callbackUrl,
  type CustomFetch,
  type LoginChecks,
  type RelyingPartyFactory,
  type StartedLogin,
} from './relying-party';

export interface FinishedSignIn {
  readonly identity: IdentityClaims;
  /** Problems for the server log (a userinfo failure, a team name that cannot be read). */
  readonly warnings: readonly string[];
}

export interface SignInFlow {
  start(): Promise<StartedLogin>;
  /** `callback` must be rebuilt from `public_url` + the request's query string. */
  finish(callback: URL, checks: LoginChecks): Promise<FinishedSignIn>;
}

export interface SignInFlows {
  /**
   * The flow of `provider`. `adminGroup`: the admin rule's group, resolved against
   * the providers configured now; a GitHub provider reads that team when it is its own.
   */
  for(provider: SignInProvider, adminGroup: AdminGroup | null): SignInFlow;
  /** The callback to register at the provider. */
  callbackUrl(providerId: string): URL;
}

export interface SignInFlowsDeps {
  readonly publicUrl: URL;
  readonly relyingParties: RelyingPartyFactory;
  readonly fetch?: CustomFetch;
}

export function createSignInFlows(deps: SignInFlowsDeps): SignInFlows {
  return {
    callbackUrl: (providerId) => callbackUrl(deps.publicUrl, providerId),
    for(provider, adminGroup) {
      const redirectUri = callbackUrl(deps.publicUrl, provider.id);
      if (provider.kind === 'github') {
        const teams = adminGroup?.provider === provider.id ? [adminGroup.name] : [];
        const github = new GithubSignIn(provider, { redirectUri, teams, fetch: deps.fetch });
        return {
          start: () => github.start(),
          finish: (callback, checks) => github.finish(callback, checks),
        };
      }
      const rp = deps.relyingParties.for(provider, redirectUri);
      return {
        start: () => rp.start(),
        async finish(callback, checks) {
          const finished = await rp.finish(callback, checks);
          const identity = mapClaims(finished.claims, provider.claims, {
            userinfoFailed: finished.userinfoFailed,
          });
          if (issuerKey(identity.issuer) !== issuerKey(provider.issuer)) {
            throw new LoginError(
              'idp-error',
              `the ID token was issued by ${identity.issuer}, not by the issuer of provider '${provider.id}' (${issuerKey(provider.issuer)})`,
            );
          }
          return { identity, warnings: finished.warnings };
        },
      };
    },
  };
}

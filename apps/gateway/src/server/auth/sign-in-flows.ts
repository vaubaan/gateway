/**
 * One sign-in attempt, whatever the kind of the sign-in provider: OpenID Connect (the
 * relying party, `relying-party.ts`, then the claim mapping) or GitHub
 * (`github.ts`). Both start with a `state` and a PKCE verifier of their own
 * (OpenID Connect adds a nonce) and finish into the same `IdentityClaims`.
 *
 * The identity a sign-in provider produces is always of its own issuer: an ID token
 * whose `iss` is not the sign-in provider's issuer is refused here, whatever the
 * library already checked, because a user is (issuer, subject) and the
 * provider of a user is found by that issuer (sessions end when it is removed,
 * its groups count for the administrators).
 */
import { issuerKey, type AdminGroup, type SignInProvider } from '../config/sign-in';
import { mapClaims, type IdentityClaims } from './claims';
import { LoginError } from './errors';
import { GithubSignIn } from './github';
import { InstalledOidcSignIn, installedProviderOf } from './installed-sign-in';
import { loopbackRedirectUri } from './loopback-uri';
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
   * The flow of `provider`. `adminGroups`: the designated administrators' groups,
   * resolved against the sign-in providers configured now; a GitHub provider reads the teams
   * that are its own.
   */
  for(signInProvider: SignInProvider, adminGroups: readonly AdminGroup[]): SignInFlow;
  /** The callback to register at the sign-in provider. */
  callbackUrl(signInProviderId: string): URL;
  /** Where an installed client comes back: `http://127.0.0.1:<port>/oauth/loopback`. */
  loopbackUri(): URL;
}

export interface SignInFlowsDeps {
  readonly publicUrl: URL;
  readonly relyingParties: RelyingPartyFactory;
  readonly fetch?: CustomFetch;
}

export function createSignInFlows(deps: SignInFlowsDeps): SignInFlows {
  return {
    callbackUrl: (signInProviderId) => callbackUrl(deps.publicUrl, signInProviderId),
    loopbackUri: () => loopbackRedirectUri(deps.publicUrl),
    for(signInProvider, adminGroups) {
      // An installed client comes back on the loopback, at the public URL's port
      // (ADR local-instance-carries-installed-oauth-clients).
      const installed = installedProviderOf(signInProvider);
      const redirectUri = installed
        ? loopbackRedirectUri(deps.publicUrl)
        : callbackUrl(deps.publicUrl, signInProvider.id);
      if (signInProvider.kind === 'oidc' && (installed === 'google' || installed === 'microsoft')) {
        const flow = new InstalledOidcSignIn(signInProvider, installed, {
          redirectUri,
          fetch: deps.fetch,
        });
        return {
          start: () => flow.start(),
          finish: (callback, checks) => flow.finish(callback, checks),
        };
      }
      if (signInProvider.kind === 'local') {
        // Sign-in accounts sign in on the form of the sign-in page (`local-handlers.ts`),
        // never through a redirect: nothing to start, nothing to finish.
        throw new LoginError(
          'sign-in-provider-unknown',
          `sign-in provider '${signInProvider.id}' keeps sign-in accounts: it has no redirect flow`,
        );
      }
      if (signInProvider.kind === 'github') {
        const teams = adminGroups
          .filter((g) => g.signInProvider === signInProvider.id)
          .map((g) => g.name);
        const github = new GithubSignIn(signInProvider, { redirectUri, teams, fetch: deps.fetch });
        return {
          start: () => github.start(),
          finish: (callback, checks) => github.finish(callback, checks),
        };
      }
      const rp = deps.relyingParties.for(signInProvider, redirectUri);
      return {
        start: () => rp.start(),
        async finish(callback, checks) {
          const finished = await rp.finish(callback, checks);
          const identity = mapClaims(finished.claims, signInProvider.claims, {
            userinfoFailed: finished.userinfoFailed,
          });
          if (issuerKey(identity.issuer) !== issuerKey(signInProvider.issuer)) {
            throw new LoginError(
              'idp-error',
              `the ID token was issued by ${identity.issuer}, not by the issuer of sign-in provider '${signInProvider.id}' (${issuerKey(signInProvider.issuer)})`,
            );
          }
          return { identity, warnings: finished.warnings };
        },
      };
    },
  };
}

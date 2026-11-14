/**
 * Upstream calls of the `outlook` provider — Microsoft Graph v1.0 — and
 * resource discovery.
 *
 * Spec     : docs/spec/vaubaan-gateway.md §2.4 — the credential arrives
 *            decrypted in the context, is used for one call, and is never
 *            returned.
 * Handbook : docs/handbook/providers/outlook.md.
 * ADR      : docs/decisions/outlook-through-the-oauth-broker-microsoft-provider.md.
 *
 * Rules:
 *   - the call is read by `readOutlookCall`, the classifier's own reader:
 *     what is sent is built from what it returned, never from `args`;
 *   - `describe_zones` is answered from the mailbox resource;
 *   - every other tool is one to a few requests through `graph` (`httpJson`):
 *     401 / 403 `UpstreamAuthError`, another status `UpstreamHttpError`, an
 *     answer that is not JSON or not the shape a guard reads
 *     `UpstreamProtocolError`;
 *   - every path segment is a value of its grammar, checked again by
 *     `pathSegment` and percent-encoded;
 *   - what Microsoft answers is untrusted: discovery reads the account's
 *     address through the strict parser.
 */

import {
  CredentialRefusal,
  ExecutorRefusal,
  UpstreamAuthError,
  declining,
  expectCredentialKind,
  isRecord,
  type AccountContext,
  type ExecuteContext,
  type Guard,
  type McpToolResult,
  type Resource,
} from '@vaubaan/plugin-sdk';

import { parseAddress } from './address.ts';
import { executeCalendar } from './calendar.ts';
import { readOutlookCall } from './call.ts';
import { missingScopes, scopesNotGrantedMessage } from './credential.ts';
import { graph } from './graph.ts';
import { mailboxRefOf } from './identifiers.ts';
import { CALENDAR_TOOLS, PROVIDER_ID } from './identity.ts';
import { executeMail } from './mail.ts';

/**
 * Mail domains that are not a company's: an account there does not make its
 * domain internal. Microsoft's consumer domains, and the common free mail
 * providers a personal Microsoft account may be registered with.
 */
export const CONSUMER_DOMAINS: ReadonlySet<string> = new Set([
  'outlook.com',
  'outlook.fr',
  'outlook.de',
  'outlook.es',
  'outlook.it',
  'outlook.be',
  'hotmail.com',
  'hotmail.fr',
  'hotmail.de',
  'hotmail.es',
  'hotmail.it',
  'hotmail.be',
  'hotmail.co.uk',
  'live.com',
  'live.fr',
  'live.de',
  'live.be',
  'live.co.uk',
  'live.it',
  'msn.com',
  'passport.com',
  'windowslive.com',
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.fr',
  'icloud.com',
  'me.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
  'gmx.de',
  'orange.fr',
  'free.fr',
  'laposte.net',
]);

/** What a person reads when Graph refuses to read the account at discovery. */
export const PROFILE_REFUSED =
  'Microsoft refused to read this account (User.Read). An administrator of the organisation may have to consent to the app, or its policy blocks it; then refresh the account.';

/** What a person reads when Microsoft names the account by no address. */
export const NO_ADDRESS =
  'Microsoft names this account by no e-mail address (neither mail nor userPrincipalName is one): it cannot be connected as a mailbox.';

type Args = Readonly<Record<string, unknown>>;

// eslint-disable-next-line no-control-regex -- control characters are what this removes
const CONTROL = /[\u0000-\u001f\u007f]/g;

/** A name shown to people, its control characters made spaces. */
function printable(text: string): string {
  return text.replace(CONTROL, ' ');
}

/** Refuses, before any request, a token Microsoft issued with fewer permissions than asked. */
function expectRequiredScopes(ctx: AccountContext): void {
  const { scopes } = expectCredentialKind(PROVIDER_ID, ctx.credential, 'oauth2');
  const missing = missingScopes(scopes);
  if (missing.length > 0) throw new CredentialRefusal(scopesNotGrantedMessage(missing), 403);
}

export function executeOutlook(
  ctx: ExecuteContext,
  tool: string,
  args: Args,
): Promise<McpToolResult> {
  return declining(async () => {
    const read = readOutlookCall(tool, args, ctx.resources);
    if ('denied' in read) throw new ExecutorRefusal(read.denied);
    return CALENDAR_TOOLS.has(tool) ? executeCalendar(ctx, read.call) : executeMail(ctx, read.call);
  });
}

// ─── Discovery ──────────────────────────────────────────────────────────────

interface Me {
  readonly displayName?: unknown;
  readonly mail?: unknown;
  readonly userPrincipalName?: unknown;
}

const isMe: Guard<Me> = (x): x is Me => isRecord(x);

/**
 * The mailbox of the account, from `GET /me`: one resource whose ref is the
 * address (`mail`, else `userPrincipalName`) lower-cased with `@` written
 * `~`. Its metadata carries `account_email` and the owner-edited zoning
 * lists, `internal_domains` seeded with the address's domain unless it is a
 * consumer one. A token granted fewer permissions than asked is refused
 * first, in the gateway's words.
 */
export async function discoverOutlookResources(ctx: AccountContext): Promise<readonly Resource[]> {
  expectRequiredScopes(ctx);
  let me: Me | null;
  try {
    me = await graph(ctx, 'GET', '/me', {
      query: { $select: 'id,displayName,mail,userPrincipalName' },
      guard: isMe,
    });
  } catch (err) {
    if (err instanceof UpstreamAuthError && err.upstreamStatus === 403) {
      throw new CredentialRefusal(PROFILE_REFUSED, 403);
    }
    throw err;
  }
  return [mailboxResource(me ?? {})];
}

/** The mailbox resource of a `/me` answer; a `CredentialRefusal` when it names no address. */
export function mailboxResource(me: Me): Resource {
  const address = parseAddress(me.mail) ?? parseAddress(me.userPrincipalName);
  if (address === null) throw new CredentialRefusal(NO_ADDRESS, 403);
  const name =
    typeof me.displayName === 'string' && me.displayName.trim() !== ''
      ? printable(me.displayName.trim().slice(0, 120))
      : null;
  return {
    provider: PROVIDER_ID,
    ref: mailboxRefOf(address.address),
    displayName: name === null ? address.address : `${name} <${address.address}>`,
    metadata: {
      account_email: address.address,
      internal_domains: CONSUMER_DOMAINS.has(address.domain) ? [] : [address.domain],
      allowlist_domains: [],
      allowlist_addresses: [],
    },
  };
}

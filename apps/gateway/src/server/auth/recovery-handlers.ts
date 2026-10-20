/**
 * The recovery page's endpoints (ADR administrators-live-in-the-instance §9). No web
 * session: whoever holds the master key. Origin-checked, and one instance-wide window
 * (the bootstrap token's: ten attempts per ten minutes) for the challenge and the proof.
 *
 *   POST /api/recover/challenge   → `{ challenge }`, the challenge cookie
 *   POST /api/recover/proof       `{ proof }` → `{ ok }`, the recovery session's cookie
 *   POST /api/recover/name        the one act of a recovery session: name an administrator
 */
import { randomBytes } from 'node:crypto';

import type { SessionStore } from '../compose/ports';
import type { Logger } from '../logging';
import { AdministratorsError, ADMINISTRATORS_ERROR_MESSAGES } from './administrators';
import { LocalAccountError } from './errors';
import { AUTH_LIMITS, readForm } from './handlers';
import type { LocalAccountsService } from './local-accounts';
import { forbiddenOriginResponse, isSameOrigin } from './origin';
import { CHALLENGE_COOKIE, type NameRequest, type RecoveryService } from './recovery';
import type { SignInProvidersService } from './sign-in-providers';
import { createThrottle, type ThrottleDeps } from './throttle';
import { clearCookie } from './cookies';

export const RECOVER_PAGE = '/admin/recover';
/** `?done=<id>`: what the naming did, read once by the page. */
export const RECOVER_DONE_PARAM = 'done';
const DONE_TTL_MS = 5 * 60_000;

/** What the page shows once after a naming: never stored past five minutes. */
export interface RecoveryOutcome {
  readonly named: Record<string, unknown>;
  /** For an address of local accounts: the link that creates its account, shown once. */
  readonly accountLink?: string;
  readonly problem?: string;
}

export interface RecoveryHandlers {
  recoverChallenge(request: Request): Promise<Response>;
  recoverProof(request: Request): Promise<Response>;
  recoverName(request: Request): Promise<Response>;
}

export interface RecoveryHandlerDeps extends ThrottleDeps {
  readonly publicUrl: URL;
  readonly recovery: RecoveryService;
  readonly providers: Pick<SignInProvidersService, 'view'>;
  readonly accounts: Pick<LocalAccountsService, 'createLink'>;
  readonly sessions: SessionStore;
  readonly logger: Logger;
}

function json(status: number, body: unknown, cookies: readonly string[] = []): Response {
  const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(JSON.stringify(body), { status, headers });
}

/** The outcome of a naming, read and deleted by the page. */
export async function takeRecoveryOutcome(
  sessions: SessionStore,
  id: string | null,
): Promise<RecoveryOutcome | null> {
  if (!id) return null;
  const outcome = (await sessions.get(`recover-done:${id}`)) as RecoveryOutcome | null;
  await sessions.delete(`recover-done:${id}`);
  return outcome;
}

export function createRecoveryHandlers(deps: RecoveryHandlerDeps): RecoveryHandlers {
  const admitted = createThrottle(deps);

  async function done(outcome: RecoveryOutcome, cookies: readonly string[]): Promise<Response> {
    const id = randomBytes(18).toString('base64url');
    await deps.sessions.set(`recover-done:${id}`, outcome, DONE_TTL_MS);
    const headers = new Headers({
      Location: `${RECOVER_PAGE}?${RECOVER_DONE_PARAM}=${id}`,
      'Cache-Control': 'no-store',
    });
    for (const cookie of cookies) headers.append('Set-Cookie', cookie);
    return new Response(null, { status: 303, headers });
  }

  return {
    async recoverChallenge(request) {
      if (!isSameOrigin(request.headers, deps.publicUrl)) return forbiddenOriginResponse();
      if (!(await admitted(request, 'recover', null, AUTH_LIMITS.bootstrapPerInstance))) {
        return json(429, { error: 'too-many-attempts' });
      }
      const { challenge, setCookie } = await deps.recovery.challenge();
      return json(200, { challenge }, [setCookie]);
    },

    async recoverProof(request) {
      if (!isSameOrigin(request.headers, deps.publicUrl)) return forbiddenOriginResponse();
      if (!(await admitted(request, 'recover', null, AUTH_LIMITS.bootstrapPerInstance))) {
        return json(429, { error: 'too-many-attempts' });
      }
      let proof = '';
      try {
        const body = (await request.json()) as { proof?: unknown };
        proof = typeof body.proof === 'string' ? body.proof : '';
      } catch {
        return json(400, { error: 'invalid-request' });
      }
      const opened = await deps.recovery.prove(request.headers, proof);
      const clear = clearCookie(CHALLENGE_COOKIE);
      if (!opened) return json(403, { ok: false }, [clear]);
      return json(200, { ok: true }, [clear, opened.setCookie]);
    },

    async recoverName(request) {
      if (!isSameOrigin(request.headers, deps.publicUrl)) return forbiddenOriginResponse();
      if (!(await deps.recovery.isOpen(request.headers))) {
        return new Response(null, {
          status: 303,
          headers: { Location: RECOVER_PAGE, 'Cache-Control': 'no-store' },
        });
      }
      const form = await readForm(request);
      if (!form) return json(400, { error: 'invalid-request' });
      const field = (name: string): string => {
        const value = form.get(name);
        return typeof value === 'string' ? value.trim() : '';
      };
      const kind = field('kind');
      const provider = field('provider');
      let target: NameRequest;
      if (kind === 'user') target = { kind, userId: field('user') };
      else if (kind === 'group') target = { kind, provider, group: field('group') };
      else target = { kind: 'email', provider, email: field('email').toLowerCase() };
      try {
        const { named, clearCookie: clear } = await deps.recovery.name(request.headers, target);
        let accountLink: string | undefined;
        if (target.kind === 'email' && (await deps.providers.view(provider))?.kind === 'local') {
          // No mail may be set: the link that creates the account is shown once.
          const issued = await deps.accounts.createLink({
            kind: 'invite',
            providerId: provider,
            email: target.email,
            createdBy: 'recovery',
          });
          accountLink = issued.url.href;
        }
        return done({ named, ...(accountLink ? { accountLink } : {}) }, [clear]);
      } catch (err) {
        const problem =
          err instanceof AdministratorsError
            ? ADMINISTRATORS_ERROR_MESSAGES[err.code]
            : err instanceof LocalAccountError
              ? err.sentence
              : 'Nobody was named. Open the recovery page again.';
        deps.logger.warn('recovery naming refused', {
          detail: err instanceof Error ? err.message : String(err),
        });
        return done({ named: {}, problem }, [clearCookie(CHALLENGE_COOKIE)]);
      }
    },
  };
}

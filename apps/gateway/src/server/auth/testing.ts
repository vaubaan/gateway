/**
 * Test helpers of the authentication module. Not for production.
 */
import { base32Decode, totpCode, totpStepOf } from '../crypto/totp';
import type { Store } from '../store';
import type { ConfigRepo } from '../store/repositories/config';
import { ENROL_PAGE, SECOND_FACTOR_PAGE } from './local-handlers';
import type { SessionService } from './session-service';

/**
 * Switches a provider saved in Settings on without a test beside the session: the
 * state a passed test then "Switch on" leaves (ADR administrators-live-in-the-instance,
 * §5), for tests whose subject is not the switch.
 */
export async function switchOnForTests(
  config: Pick<ConfigRepo, 'set' | 'get'>,
  id: string,
): Promise<void> {
  const raw = await config.get(`sign_in_state.${id}`);
  const current = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  await config.set(
    `sign_in_state.${id}`,
    JSON.stringify({ ...current, enabled: true, changed_at: null }),
  );
}

/** What `passSecondFactor` drives: the root's step store, factors and handlers. */
export interface SecondFactorRig {
  readonly store: Pick<Store, 'secondFactors' | 'db'>;
  readonly auth: {
    readonly sessions: Pick<SessionService, 'peekLocalStep'>;
    readonly handlers: {
      enrolAtSignIn(request: Request): Promise<Response>;
      secondFactorLogin(request: Request): Promise<Response>;
    };
  };
}

/** Whether a response sends the browser to the second factor's step of a sign-in. */
export function isSecondFactorStep(response: Response): boolean {
  const location = response.headers.get('location') ?? '';
  return location.startsWith(ENROL_PAGE) || location.startsWith(SECOND_FACTOR_PAGE);
}

/**
 * Answers the second factor's step of a sign-in as the person's authenticator app
 * would (ADR administrators-live-in-the-instance, §7): the enrolment with a code of
 * the secret the step holds, or the code of the enrolled secret. A code is never
 * accepted twice in one time step; a test signing one person in twice within thirty
 * seconds is not about that, so the last accepted step is forgotten first.
 * Returns the response of the step's form, or `null` when there is no step.
 */
export async function passSecondFactor(
  rig: SecondFactorRig,
  publicUrl: string,
  cookie: string,
  nowMs: number = Date.now(),
): Promise<Response | null> {
  const headers = new Headers({ cookie });
  const step = await rig.auth.sessions.peekLocalStep(headers);
  if (!step) return null;
  let secret = step.step === 'enrol' ? (step.totpSecret ?? null) : null;
  if (step.step === 'second-factor') {
    secret = await rig.store.secondFactors.readSecret(step.userId, 'totp');
    rig.store.db
      .prepare('UPDATE user_second_factors SET last_step = NULL WHERE user_id = ?')
      .run(step.userId);
  }
  const bytes = secret ? base32Decode(secret) : null;
  if (!bytes) return null;
  const request = new Request(
    `${publicUrl}/auth/factor/${step.step === 'enrol' ? 'enrol' : 'code'}`,
    {
      method: 'POST',
      headers: {
        cookie,
        origin: publicUrl,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ code: totpCode(bytes, totpStepOf(nowMs)) }).toString(),
    },
  );
  return step.step === 'enrol'
    ? rig.auth.handlers.enrolAtSignIn(request)
    : rig.auth.handlers.secondFactorLogin(request);
}

/**
 * A sign-in's response, carried through the gateway's second factor as the person
 * would carry it (`passSecondFactor`), and through the recovery codes shown once:
 * the redirect to where the sign-in was going, with the cookies `absorb` received.
 * A response that asks no factor is returned as it is.
 */
export async function throughSecondFactor(
  rig: SecondFactorRig,
  publicUrl: string,
  response: Response,
  browser: { cookie(): string; absorb(response: Response): void },
  nowMs?: number,
): Promise<Response> {
  if (!isSecondFactorStep(response)) return response;
  const answered = await passSecondFactor(rig, publicUrl, browser.cookie(), nowMs);
  if (!answered) return response;
  browser.absorb(answered);
  const location = new URL(answered.headers.get('location') ?? '/', publicUrl);
  if (location.pathname !== '/settings/security') return answered;
  const headers = new Headers({ Location: location.searchParams.get('return_to') ?? '/' });
  for (const cookie of answered.headers.getSetCookie()) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 303, headers });
}

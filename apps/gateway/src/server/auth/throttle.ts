/**
 * The windows of the anonymous sign-in endpoints (see
 * docs/handbook/authentication.md): one per client address when it is
 * known, and one for the whole instance. Shared by the redirect sign-ins
 * (`handlers.ts`) and the forms of the local accounts (`local-handlers.ts`).
 */
import type { RateLimiter } from '../compose/ports';
import { UNKNOWN_CLIENT } from '../http/client-ip';
import type { Logger } from '../logging';

export interface Window {
  readonly limit: number;
  readonly windowMs: number;
}

export interface ThrottleDeps {
  readonly rateLimiter: RateLimiter;
  readonly clientIp: (headers: Headers) => string;
  readonly logger: Logger;
}

export type Throttle = (
  request: Request,
  scope: string,
  perAddress: Window | null,
  perInstance: Window,
) => Promise<boolean>;

/**
 * Takes one slot of each window that applies: the per-address one only when the
 * address is known (an unknown address would be one window for everybody, which the
 * instance-wide window already is). `true` when every window had room.
 */
export function createThrottle(deps: ThrottleDeps): Throttle {
  return async (request, scope, perAddress, perInstance) => {
    const address = deps.clientIp(request.headers);
    if (perAddress && address !== UNKNOWN_CLIENT) {
      const taken = await deps.rateLimiter.take(
        `auth:${scope}:ip:${address}`,
        perAddress.limit,
        perAddress.windowMs,
      );
      if (!taken.allowed) {
        deps.logger.warn('sign-in throttled', { scope, window: 'address' });
        return false;
      }
    }
    const taken = await deps.rateLimiter.take(
      `auth:${scope}:instance`,
      perInstance.limit,
      perInstance.windowMs,
    );
    if (!taken.allowed) deps.logger.warn('sign-in throttled', { scope, window: 'instance' });
    return taken.allowed;
  };
}

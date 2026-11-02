/**
 * Host-agnostic HTTP handlers of a person's devices (`Request → Response`, never `next`).
 * The route files under `src/app/api/notifications/**` are one-line adapters over these.
 *
 *   POST /api/notifications/devices               this browser's subscription (JSON, from
 *                                                 the page's script) → 201 { device }
 *   POST /api/notifications/devices/:id/rename    the Settings form → 303 to the page
 *   POST /api/notifications/devices/:id/remove    the Settings form, asked first → 303
 *
 * Rename and remove are form posts, as every act the design system asks first
 * (`ConfirmSubmit`): the page needs no script for them.
 *
 * Order of the checks (spec §6), the same on the three routes:
 *
 *   1. a bearer was presented          → 403 `wrong-credential-kind` (a device is added
 *                                         by its person, in a human session; an agent
 *                                         holding a token cannot subscribe anything)
 *   2. origin, then a user session     → `guardMutation` with the role `user`
 */
import type { BearerKind } from '@vaubaan/gateway-core';

import { guardMutation, refusalResponse, type Authenticator, type RefusalWording } from '../auth';
import { readBoundedText } from '../http/bounded-body';
import type { UserRecord } from '../store/types';
import type { DeviceService } from './device-service';

/** Settings → You → Notifications. */
export const NOTIFICATIONS_PAGE = '/settings/notifications';
/** The routes, by the device they act on. */
export const DEVICES_API = '/api/notifications/devices';
export const deviceActionPath = (deviceId: string, act: 'rename' | 'remove'): string =>
  `${DEVICES_API}/${encodeURIComponent(deviceId)}/${act}`;

/** The field of the rename form. */
export const LABEL_FIELD = 'label';
/** What the page reads after a form: `?done=<act>` or `?problem=<code>`. */
export const DONE_PARAM = 'done';
export const PROBLEM_PARAM = 'problem';

const REFUSALS: RefusalWording = {
  field: 'message',
  noSession: 'Sign in first.',
  forbidden: 'Devices belong to a person who signed in.',
};

/** A subscription is a URL and two keys: a few hundred bytes; anything far larger is refused. */
export const MAX_ADD_BODY_BYTES = 8 * 1024;

export interface DeviceHandlerDeps {
  readonly publicUrl: URL;
  /** Read at each request: the root builds the authentication after this module. */
  readonly authenticator: () => Authenticator;
  readonly service: DeviceService;
}

export interface DeviceHandlers {
  add(request: Request): Promise<Response>;
  rename(request: Request, deviceId: string): Promise<Response>;
  remove(request: Request, deviceId: string): Promise<Response>;
}

type SignedIn =
  | { readonly ok: true; readonly user: UserRecord }
  | { readonly ok: false; readonly response: Response };

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...NO_STORE },
  });
}

function backToPage(query: string): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: `${NOTIFICATIONS_PAGE}?${query}`, ...NO_STORE },
  });
}

function bearerRefusal(request: Request): Response | null {
  if (request.headers.get('authorization') === null) return null;
  const expected: BearerKind = 'human-session';
  return json(403, {
    error: 'wrong-credential-kind',
    expected,
    message: 'A device is added and removed by its person, in a human session.',
  });
}

async function formField(request: Request, name: string): Promise<string | null> {
  try {
    const value = (await request.formData()).get(name);
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

export function createDeviceHandlers(deps: DeviceHandlerDeps): DeviceHandlers {
  /** Steps 1 and 2: the person behind the request, or the answer that refuses it. */
  async function signedIn(request: Request): Promise<SignedIn> {
    const refused = bearerRefusal(request);
    if (refused) return { ok: false, response: refused };
    const guard = await guardMutation(
      request,
      { publicUrl: deps.publicUrl, authenticator: deps.authenticator() },
      'user',
    );
    if (!guard.ok) return { ok: false, response: refusalResponse(guard, REFUSALS) };
    return { ok: true, user: guard.principal.user };
  }

  return {
    async add(request) {
      const session = await signedIn(request);
      if (!session.ok) return session.response;
      const text = await readBoundedText(request, MAX_ADD_BODY_BYTES);
      if (text === null) return json(413, { error: 'too-large' });
      let body: unknown;
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        return json(400, { error: 'invalid-request' });
      }
      const { subscription, label } = (typeof body === 'object' && body !== null ? body : {}) as {
        subscription?: unknown;
        label?: unknown;
      };
      const result = await deps.service.add(session.user, { subscription, label });
      if (!result.ok) {
        // The code only: the page words it (`NOTIFICATION_WORDS.problems`).
        return json(result.problem === 'too-many-devices' ? 409 : 400, { error: result.problem });
      }
      return json(201, { device: result.device });
    },

    async rename(request, deviceId) {
      const session = await signedIn(request);
      if (!session.ok) return session.response;
      const result = await deps.service.rename(
        session.user,
        deviceId,
        await formField(request, LABEL_FIELD),
      );
      return backToPage(result.ok ? `${DONE_PARAM}=renamed` : `${PROBLEM_PARAM}=${result.problem}`);
    },

    async remove(request, deviceId) {
      const session = await signedIn(request);
      if (!session.ok) return session.response;
      const result = await deps.service.remove(session.user, deviceId);
      return backToPage(result.ok ? `${DONE_PARAM}=removed` : `${PROBLEM_PARAM}=${result.problem}`);
    },
  };
}

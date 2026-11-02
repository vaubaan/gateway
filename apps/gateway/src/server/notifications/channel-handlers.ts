/**
 * Host-agnostic HTTP handlers of a person's messaging addresses and mail switch (`Request →
 * Response`, never `next`). The route files under `src/app/api/notifications/**` are
 * one-line adapters over these. Every one is a form post of Settings → Notifications and
 * answers 303 back to it, `?done=<act>` or `?problem=<code>` (and `&status=<n>` for a test
 * message the service refused): the page needs no script.
 *
 *   POST /api/notifications/addresses               kind, label, url → the test message
 *                                                    leaves; stored only on a 2xx
 *   POST /api/notifications/addresses/:id/remove    asked first (`ConfirmSubmit`)
 *   POST /api/notifications/mail                    mail=on (anything else: off)
 *
 * The checks are the devices' (`handlers.ts`): a bearer is refused, then origin and a user
 * session. A form is read to `MAX_FORM_BYTES` at most.
 */
import { readBoundedText } from '../http/bounded-body';
import type { AddressProblem, AddressService } from './address-service';
import { backToPage, done, PROBLEM_PARAM, signedIn, type SignInDeps } from './handlers';
import type { MailChannel, MailProblem } from './mail-channel';

export const ADDRESSES_API = '/api/notifications/addresses';
export const addressRemovePath = (addressId: string): string =>
  `${ADDRESSES_API}/${encodeURIComponent(addressId)}/remove`;
export const MAIL_API = '/api/notifications/mail';

/** The fields of the forms. */
export const ADDRESS_FIELDS = { kind: 'kind', label: 'label', url: 'url' } as const;
export const MAIL_FIELD = 'mail';
/** The HTTP status of a refused test message, beside `?problem=test-failed`. */
export const STATUS_PARAM = 'status';

/** A kind, a label and a URL of 2048 characters, form-encoded: well under this. */
export const MAX_FORM_BYTES = 8 * 1024;

export interface ChannelHandlerDeps extends SignInDeps {
  readonly addresses: AddressService;
  readonly mail: MailChannel;
}

export interface ChannelHandlers {
  addAddress(request: Request): Promise<Response>;
  removeAddress(request: Request, addressId: string): Promise<Response>;
  setMail(request: Request): Promise<Response>;
}

/** The form's fields, or `null` when the body is too large or not a form. */
async function boundedForm(request: Request): Promise<URLSearchParams | null> {
  const text = await readBoundedText(request, MAX_FORM_BYTES);
  return text === null ? null : new URLSearchParams(text);
}

const problem = (code: AddressProblem | MailProblem, status?: number | null): Response =>
  backToPage(
    `${PROBLEM_PARAM}=${code}${status === undefined || status === null ? '' : `&${STATUS_PARAM}=${status}`}`,
  );

export function createChannelHandlers(deps: ChannelHandlerDeps): ChannelHandlers {
  return {
    async addAddress(request) {
      const session = await signedIn(request, deps);
      if (!session.ok) return session.response;
      const form = await boundedForm(request);
      if (form === null) return problem('invalid-address');
      const result = await deps.addresses.add(session.user, {
        kind: form.get(ADDRESS_FIELDS.kind),
        label: form.get(ADDRESS_FIELDS.label),
        url: form.get(ADDRESS_FIELDS.url),
      });
      return result.ok ? done('address-added') : problem(result.problem, result.status);
    },

    async removeAddress(request, addressId) {
      const session = await signedIn(request, deps);
      if (!session.ok) return session.response;
      const result = await deps.addresses.remove(session.user, addressId);
      return result.ok ? done('address-removed') : problem(result.problem);
    },

    async setMail(request) {
      const session = await signedIn(request, deps);
      if (!session.ok) return session.response;
      const form = await boundedForm(request);
      // Anything but `on` switches off: off is always safe.
      const result = await deps.mail.set(session.user, form?.get(MAIL_FIELD) === 'on');
      if (!result.ok) return problem(result.problem);
      return done(result.on ? 'mail-on' : 'mail-off');
    },
  };
}

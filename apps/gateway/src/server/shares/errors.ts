/**
 * Errors of the share acts. A `ShareError` carries a closed code (what the
 * interface keys its sentence on), an HTTP status and an optional `detail`
 * that is safe to show to the owner (the unknown ids they sent).
 */
export const SHARE_ERROR_CODES = [
  'not-found',
  'account-revoked',
  'account-unowned',
  'account-personal',
  'service-unknown',
  'target-unknown',
  'target-ambiguous',
  'target-is-owner',
  'restriction-empty',
  'risk-unknown',
] as const;

export type ShareErrorCode = (typeof SHARE_ERROR_CODES)[number];

export const SHARE_ERROR_MESSAGES: Readonly<Record<ShareErrorCode, string>> = {
  'not-found': 'This account or this access does not exist, or the account is not yours.',
  'account-revoked': 'This account is disconnected; nobody can be given access to it.',
  'account-unowned':
    'This account has no owner any more: nobody can give access to it until an administrator names a new owner.',
  'account-personal':
    'This account is its owner’s own place on the gateway: nobody else can be given access to it.',
  'service-unknown': 'The service of this account is not available on this gateway.',
  'target-unknown':
    'Nobody matches. A person is known to the gateway once they have signed in; a team must exist.',
  'target-ambiguous':
    'Several people carry this email. Ask an administrator for a team, and give access to the team instead.',
  'target-is-owner':
    'They already own this account — as its owner, or as a member of the team that owns it — and need no access.',
  'restriction-empty': 'Tick at least one permission: an access with none allows nothing.',
  'risk-unknown': "Some permissions are not in this service's catalog; no access was given.",
};

const STATUS_BY_CODE: Readonly<Record<ShareErrorCode, number>> = {
  'not-found': 404,
  'account-revoked': 409,
  'account-unowned': 409,
  'account-personal': 409,
  'service-unknown': 409,
  'target-unknown': 400,
  'target-ambiguous': 409,
  'target-is-owner': 400,
  'restriction-empty': 400,
  'risk-unknown': 400,
};

/**
 * Is this the `ShareError` of that code? By shape, not by `instanceof`: a page is
 * bundled apart from the code that built the composition root, so the class a page
 * imports is not the one a service threw (handbook web-app, Invariants, "A page
 * recognises a service error by shape"). Services and handlers live in the root's own graph and may use `instanceof`.
 */
export function isShareError(err: unknown, code: ShareErrorCode): boolean {
  return err instanceof Error && err.name === 'ShareError' && 'code' in err && err.code === code;
}

export class ShareError extends Error {
  readonly status: number;

  constructor(
    readonly code: ShareErrorCode,
    readonly detail: string | null = null,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'ShareError';
    this.status = STATUS_BY_CODE[code];
  }
}

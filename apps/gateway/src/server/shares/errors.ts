/**
 * Errors of the share acts. A `ShareError` carries a closed code (what the
 * interface keys its sentence on), an HTTP status and an optional `detail`
 * that is safe to show to the owner (the unknown ids they sent).
 */
export const SHARE_ERROR_CODES = [
  'not-found',
  'connection-revoked',
  'connection-unowned',
  'provider-unknown',
  'target-unknown',
  'target-ambiguous',
  'target-is-owner',
  'restriction-empty',
  'risk-unknown',
] as const;

export type ShareErrorCode = (typeof SHARE_ERROR_CODES)[number];

export const SHARE_ERROR_MESSAGES: Readonly<Record<ShareErrorCode, string>> = {
  'not-found': 'This connection or share does not exist, or the connection is not yours.',
  'connection-revoked': 'This connection is revoked; it cannot be shared.',
  'connection-unowned':
    'This connection has no owner any more: nobody can share it until an operator reassigns an owner.',
  'provider-unknown': 'The provider of this connection is not available on this instance.',
  'target-unknown':
    'Nobody matches this target. A user is known to the instance once they have signed in; a group must exist.',
  'target-ambiguous':
    'Several users carry this email. Ask an operator to share through a group instead.',
  'target-is-owner': 'The target already owns this connection and needs no share.',
  'restriction-empty': 'Tick at least one risk: an empty restriction authorizes nothing.',
  'risk-unknown': "Some risks are not in this provider's catalog; nothing was shared.",
};

const STATUS_BY_CODE: Readonly<Record<ShareErrorCode, number>> = {
  'not-found': 404,
  'connection-revoked': 409,
  'connection-unowned': 409,
  'provider-unknown': 409,
  'target-unknown': 400,
  'target-ambiguous': 409,
  'target-is-owner': 400,
  'restriction-empty': 400,
  'risk-unknown': 400,
};

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

/**
 * Errors of the users administration. A `UserAdminError` carries a closed code
 * (what the interface keys its sentence on) and an HTTP status.
 */
export const USER_ADMIN_ERROR_CODES = [
  'not-found',
  'already-deactivated',
  'not-deactivated',
  'cannot-deactivate-self',
] as const;

export type UserAdminErrorCode = (typeof USER_ADMIN_ERROR_CODES)[number];

export const USER_ADMIN_ERROR_MESSAGES: Readonly<Record<UserAdminErrorCode, string>> = {
  'not-found': 'This user does not exist on this instance.',
  'already-deactivated': 'This user is already deactivated; nothing was changed.',
  'not-deactivated': 'This user is active; there is nothing to reactivate.',
  'cannot-deactivate-self':
    'You cannot deactivate your own account: you would lose the session this very act needs. Ask another operator.',
};

const STATUS_BY_CODE: Readonly<Record<UserAdminErrorCode, number>> = {
  'not-found': 404,
  'already-deactivated': 409,
  'not-deactivated': 409,
  'cannot-deactivate-self': 409,
};

export class UserAdminError extends Error {
  readonly status: number;

  constructor(readonly code: UserAdminErrorCode) {
    super(code);
    this.name = 'UserAdminError';
    this.status = STATUS_BY_CODE[code];
  }
}

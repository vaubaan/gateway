/**
 * Errors of the users administration. A `UserAdminError` carries a closed code
 * (what the interface keys its sentence on) and an HTTP status.
 */
export const USER_ADMIN_ERROR_CODES = [
  'not-found',
  'already-deactivated',
  'not-deactivated',
  'cannot-deactivate-self',
  'invitation-email-invalid',
  'invitation-exists',
  'invitation-not-found',
] as const;

export type UserAdminErrorCode = (typeof USER_ADMIN_ERROR_CODES)[number];

export const USER_ADMIN_ERROR_MESSAGES: Readonly<Record<UserAdminErrorCode, string>> = {
  'not-found': 'This person does not exist on this gateway.',
  'already-deactivated': 'This person is already deactivated; nothing was changed.',
  'not-deactivated': 'This person is active; there is nothing to reactivate.',
  'cannot-deactivate-self':
    'You cannot deactivate yourself: you would lose the session this very act needs. Ask another administrator.',
  'invitation-email-invalid': 'This is not an email address; nothing was invited.',
  'invitation-exists': 'This address is already invited; nothing was changed.',
  'invitation-not-found': 'This address is not invited; nothing was removed.',
};

const STATUS_BY_CODE: Readonly<Record<UserAdminErrorCode, number>> = {
  'not-found': 404,
  'already-deactivated': 409,
  'not-deactivated': 409,
  'cannot-deactivate-self': 409,
  'invitation-email-invalid': 400,
  'invitation-exists': 409,
  'invitation-not-found': 404,
};

export class UserAdminError extends Error {
  readonly status: number;

  constructor(readonly code: UserAdminErrorCode) {
    super(code);
    this.name = 'UserAdminError';
    this.status = STATUS_BY_CODE[code];
  }
}

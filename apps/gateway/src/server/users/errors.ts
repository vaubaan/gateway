/**
 * Errors of the users administration. A `UserAdminError` carries a closed code
 * (what the interface keys its sentence on) and an HTTP status.
 */
import type { LimitReached } from '../limits';

export const USER_ADMIN_ERROR_CODES = [
  'not-found',
  'already-deactivated',
  'not-deactivated',
  'cannot-deactivate-self',
  'invitation-email-invalid',
  'invitation-exists',
  'invitation-not-found',
  'limit-reached',
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
  'limit-reached':
    'This gateway holds as many people as its ceiling allows: nobody new is added until somebody is deactivated or the ceiling is raised.',
};

const STATUS_BY_CODE: Readonly<Record<UserAdminErrorCode, number>> = {
  'not-found': 404,
  'already-deactivated': 409,
  'not-deactivated': 409,
  'cannot-deactivate-self': 409,
  'invitation-email-invalid': 400,
  'invitation-exists': 409,
  'invitation-not-found': 404,
  'limit-reached': 409,
};

export class UserAdminError extends Error {
  readonly status: number;
  /** What the page says: the code's sentence, or a more precise one (a ceiling's count). */
  readonly sentence: string;

  constructor(
    readonly code: UserAdminErrorCode,
    sentence?: string,
  ) {
    super(sentence ? `${code}: ${sentence}` : code);
    this.name = 'UserAdminError';
    this.status = STATUS_BY_CODE[code];
    this.sentence = sentence ?? USER_ADMIN_ERROR_MESSAGES[code];
  }
}

/** The refusal of one more person by the ceiling of users (spec §4.3 bis). */
export function userLimitError(reached: LimitReached): UserAdminError {
  return new UserAdminError(
    'limit-reached',
    `${reached.message} Nobody new is added until somebody is deactivated or the ceiling is raised.`,
  );
}

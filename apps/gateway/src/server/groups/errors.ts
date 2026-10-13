/**
 * Errors of the local-groups administration. A `GroupError` carries a closed
 * code (what the interface keys its sentence on) and an HTTP status.
 */
export const GROUP_ERROR_CODES = [
  'not-found',
  'name-invalid',
  'name-taken',
  'name-reserved',
  'not-local',
  'user-unknown',
  'user-ambiguous',
] as const;

/** Longest name of a local group; the `name-invalid` sentence states it. */
export const GROUP_NAME_MAX_LENGTH = 80;

export type GroupErrorCode = (typeof GROUP_ERROR_CODES)[number];

export const GROUP_ERROR_MESSAGES: Readonly<Record<GroupErrorCode, string>> = {
  'not-found': 'This group or this member does not exist.',
  'name-invalid': `A group name is 1 to ${GROUP_NAME_MAX_LENGTH} characters, without control characters.`,
  'name-taken':
    'A group already has this name (local, or claimed by the identity provider). A name designates one group.',
  'name-reserved':
    'This is the group of the admin rule: its membership is granted by the identity provider only.',
  'not-local':
    'This group comes from the identity provider: its members are replaced at each sign-in and cannot be edited here.',
  'user-unknown':
    'No active user has this email. A user is known to the instance once they have signed in.',
  'user-ambiguous': 'Several users carry this email; none was added.',
};

const STATUS_BY_CODE: Readonly<Record<GroupErrorCode, number>> = {
  'not-found': 404,
  'name-invalid': 400,
  'name-taken': 409,
  'name-reserved': 409,
  'not-local': 409,
  'user-unknown': 400,
  'user-ambiguous': 409,
};

export class GroupError extends Error {
  readonly status: number;

  constructor(readonly code: GroupErrorCode) {
    super(code);
    this.name = 'GroupError';
    this.status = STATUS_BY_CODE[code];
  }
}

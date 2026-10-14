/**
 * The invitation list (spec §0 "Invitation", §4.2 People; migration 0014): the email
 * addresses an administrator allowed to sign in, instance-wide, through any sign-in
 * provider that verified the address. Who decides is the users module; this is the
 * table. Addresses are compared lower-cased.
 */

import type { Iso } from '../types.ts';
import { nowIso, type RepoContext } from './context.ts';

export interface InvitationRecord {
  /** Lower-cased. */
  readonly email: string;
  /** The administrator's user id, or `bootstrap` for the install token. */
  readonly invitedBy: string;
  readonly createdAt: Iso;
}

export interface InvitationsRepo {
  /** `null` when the address is already invited (the first invitation is kept). */
  add(email: string, invitedBy: string): Promise<InvitationRecord | null>;
  /** The removed invitation, or `null` when the address was not invited. */
  remove(email: string): Promise<InvitationRecord | null>;
  get(email: string): Promise<InvitationRecord | null>;
  /** Newest first. */
  list(): Promise<InvitationRecord[]>;
}

interface InvitationRow {
  email: string;
  invited_by: string;
  created_at: string;
}

function toRecord(row: InvitationRow): InvitationRecord {
  return { email: row.email, invitedBy: row.invited_by, createdAt: row.created_at };
}

export function createInvitationsRepo(ctx: RepoContext): InvitationsRepo {
  const { db } = ctx;
  const insert = db.prepare<[string, string, string]>(
    `INSERT INTO invitations (email, invited_by, created_at) VALUES (?, ?, ?)
     ON CONFLICT (email) DO NOTHING`,
  );
  const byEmail = db.prepare<[string], InvitationRow>(
    'SELECT email, invited_by, created_at FROM invitations WHERE email = ?',
  );
  const remove = db.prepare<[string]>('DELETE FROM invitations WHERE email = ?');
  const all = db.prepare<[], InvitationRow>(
    'SELECT email, invited_by, created_at FROM invitations ORDER BY created_at DESC, email',
  );
  const normalize = (email: string): string => email.trim().toLowerCase();

  return {
    async add(email, invitedBy) {
      const key = normalize(email);
      if (insert.run(key, invitedBy, nowIso(ctx)).changes === 0) return null;
      const row = byEmail.get(key);
      return row ? toRecord(row) : null;
    },
    async remove(email) {
      const key = normalize(email);
      const row = byEmail.get(key);
      if (!row) return null;
      return remove.run(key).changes > 0 ? toRecord(row) : null;
    },
    async get(email) {
      const row = byEmail.get(normalize(email));
      return row ? toRecord(row) : null;
    },
    async list() {
      return all.all().map(toRecord);
    },
  };
}

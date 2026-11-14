/**
 * The invitation list (spec §0 "Invitation", §4.2 People; see
 * docs/handbook/authentication.md): administrators allow an email
 * address to sign in, through any sign-in provider that verified it. An
 * invitation sends nothing and signs nobody in; it is read at each sign-in
 * (`admission.ts`). Removing one stops the next sign-ins of that address that
 * nothing else admits; a session already open runs to its end (8 hours at
 * most), and deactivation is what stops a person at once.
 *
 * Audited: `invitation-added` / `invitation-removed` on `instance-config` /
 * `invitations`, the address in `after` / `before`.
 *
 * This service does not authorize: its handlers do (`guardMutation(…, 'operator')`).
 */
import type { AuditWriter } from '@vaubaan/gateway-core';
import { BOOTSTRAP_ACTOR_ID } from '@vaubaan/gateway-core';

import type { CeilingCheck } from '../limits';
import type { Logger } from '../logging';
import type { Store } from '../store';
import { toIso, type Clock } from '../store/clock';
import type { Iso } from '../store/types';
import { UserAdminError, userLimitError } from './errors';

/** The object id of an invitation entry in the administrative audit. */
export const INVITATIONS_OBJECT_ID = 'invitations';
/** RFC 5321's limit on a path, which bounds an address. */
const MAX_EMAIL_LENGTH = 254;
/** One `@`, something on each side, a dot in the domain, no white space or control character. */
// eslint-disable-next-line no-control-regex -- refusing control characters is the point
const EMAIL = /^[^\s@\u0000-\u001f\u007f]+@[^\s@\u0000-\u001f\u007f]+\.[^\s@\u0000-\u001f\u007f]+$/;

export interface InvitationView {
  readonly email: string;
  /** The administrator's display name or email, "Bootstrap token" for the install token, or `null` when unknown. */
  readonly invitedBy: string | null;
  readonly createdAt: Iso;
  /** Somebody has signed in with this address (through any provider). */
  readonly signedIn: boolean;
}

export interface InvitationServiceDeps {
  readonly store: Pick<Store, 'invitations' | 'users'>;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly logger: Logger;
  /**
   * The `limits.users` ceiling (spec §4.3 bis): inviting an address no active person
   * holds invites a new person. Absent: no ceiling.
   */
  readonly ceilings?: CeilingCheck;
}

/** The address as stored: trimmed, lower-cased; `null` when it is not an address. */
export function normalizeInvitedEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH || !EMAIL.test(email)) return null;
  return email;
}

export class InvitationService {
  constructor(private readonly deps: InvitationServiceDeps) {}

  async list(): Promise<InvitationView[]> {
    const invitations = await this.deps.store.invitations.list();
    const views: InvitationView[] = [];
    for (const invitation of invitations) {
      const [inviter, holders] = await Promise.all([
        invitation.invitedBy === BOOTSTRAP_ACTOR_ID
          ? Promise.resolve(null)
          : this.deps.store.users.getById(invitation.invitedBy),
        this.deps.store.users.findByEmail(invitation.email),
      ]);
      views.push({
        email: invitation.email,
        invitedBy:
          invitation.invitedBy === BOOTSTRAP_ACTOR_ID
            ? 'Bootstrap token'
            : inviter
              ? (inviter.displayName ?? inviter.email)
              : null,
        createdAt: invitation.createdAt,
        signedIn: holders.length > 0,
      });
    }
    return views;
  }

  async isInvited(email: string): Promise<boolean> {
    return (await this.deps.store.invitations.get(email)) !== null;
  }

  async invite(actorId: string, rawEmail: string): Promise<string> {
    const email = normalizeInvitedEmail(rawEmail);
    if (!email) throw new UserAdminError('invitation-email-invalid');
    await this.refuseNewPerson(email);
    const added = await this.deps.store.invitations.add(email, actorId);
    if (!added) throw new UserAdminError('invitation-exists');
    await this.audit(actorId, 'invitation-added', null, { email });
    this.deps.logger.info('address invited', { actor: actorId });
    return email;
  }

  /** An address already held by an active person adds nobody; any other is refused at the ceiling. */
  private async refuseNewPerson(email: string): Promise<void> {
    const reached = await this.deps.ceilings?.refusal('users');
    if (!reached) return;
    const holders = await this.deps.store.users.findByEmail(email);
    if (holders.some((user) => user.status === 'active')) return;
    this.deps.logger.warn('invitation refused at the ceiling of users', {
      count: reached.count,
      ceiling: reached.limit,
    });
    throw userLimitError(reached);
  }

  async remove(actorId: string, rawEmail: string): Promise<string> {
    const email = rawEmail.trim().toLowerCase();
    const removed = await this.deps.store.invitations.remove(email);
    if (!removed) throw new UserAdminError('invitation-not-found');
    await this.audit(actorId, 'invitation-removed', { email: removed.email }, null);
    this.deps.logger.info('invitation removed', { actor: actorId });
    return removed.email;
  }

  private async audit(
    actorId: string,
    act: 'invitation-added' | 'invitation-removed',
    before: unknown,
    after: unknown,
  ): Promise<void> {
    try {
      await this.deps.audit.write({
        kind: 'admin',
        ts: toIso(this.deps.clock.now()),
        user_id: actorId,
        act,
        object: { type: 'instance-config', id: INVITATIONS_OBJECT_ID },
        before,
        after,
      });
    } catch (err) {
      // The list changed; a missing entry must at least be loud.
      this.deps.logger.error('audit entry not written for a saved configuration change', {
        actor: actorId,
        object: INVITATIONS_OBJECT_ID,
        err,
      });
    }
  }
}

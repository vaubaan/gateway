/**
 * Mail as a channel (spec §4.2 bis "Mail is a channel when the instance delivers mail
 * (§4.3), switched on by the person"): available when the instance has a mail transport
 * that sends plain notices (`LinkMailer.sendNotice`), sent to the person's own address
 * (`users.email`, the address their sign-in gave), only once they switched it on. Switching
 * is audited (`mail-notifications-changed`), never with the address.
 *
 * One plain-text mail per notification: the subject says which of the two things happened
 * (the mailer adds the instance's name), the body is the payload's body and the absolute
 * url. Nothing else of the notification, and nothing of a call.
 */
import type { AuditWriter } from '@vaubaan/gateway-core';

import type { LinkMailer } from '../auth/local-handlers';
import type { Logger } from '../logging';
import type { Clock } from '../store/clock';
import { toIso } from '../store/clock';
import type { NotificationMailRepo } from '../store/repositories/notification-mail';
import type { UserRecord } from '../store/types';
import { buildPayload, type Notification, type NotificationKind } from './notification';
import type { Notifier } from './notifier';

/** The mail transport as notifications use it: plain notices only. */
export type NoticeMailer = Required<Pick<LinkMailer, 'sendNotice'>>;

/** The mailer, when it sends notices; `null` when the instance does not deliver mail. */
export function noticeMailerOf(mailer: LinkMailer | undefined): NoticeMailer | null {
  const send = mailer?.sendNotice?.bind(mailer);
  return send ? { sendNotice: send } : null;
}

/** An address a mail can go to: one `@`, no space. Anything else reads as none. */
export function mailAddressOf(user: UserRecord): string | null {
  const email = user.email.trim();
  return /^[^\s@]+@[^\s@]+$/.test(email) ? email : null;
}

export type MailStatus =
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'no-address' }
  | { readonly kind: 'available'; readonly address: string; readonly on: boolean };

export const MAIL_PROBLEMS = ['mail-unavailable', 'no-mail-address'] as const;
export type MailProblem = (typeof MAIL_PROBLEMS)[number];

export type MailSwitchResult =
  | { readonly ok: true; readonly on: boolean }
  | { readonly ok: false; readonly problem: MailProblem };

const SUBJECTS: Readonly<Record<NotificationKind, string>> = {
  'request-opened': 'Something waits for you',
  'account-needs-reconnecting': 'Something stopped without you',
  'mission-orphaned': 'Something stopped without you',
  'mission-account-lost': 'Something stopped without you',
  'mission-revoked': 'Something stopped without you',
  'backup-failed': 'Something stopped without you',
  'master-key-recovery': 'An administrator was named with the master key',
  'plugin-signer-added': 'A trusted plugin signer was added',
};

/** The mail of one notification: built from its payload only. */
export function notificationMail(
  notification: Notification,
  publicUrl: URL,
): { subject: string; text: string } {
  const payload = buildPayload(notification);
  return {
    subject: SUBJECTS[notification.kind],
    text: [
      payload.body,
      '',
      new URL(payload.url, publicUrl).href,
      '',
      'You receive this mail because you switched mail notifications on in Settings → Notifications.',
    ].join('\n'),
  };
}

export interface MailChannelDeps {
  readonly mail: NotificationMailRepo;
  readonly mailer: NoticeMailer | null;
  readonly audit: AuditWriter;
  readonly clock: Clock;
}

export class MailChannel {
  constructor(private readonly deps: MailChannelDeps) {}

  get available(): boolean {
    return this.deps.mailer !== null;
  }

  async status(user: UserRecord): Promise<MailStatus> {
    if (!this.available) return { kind: 'unavailable' };
    const address = mailAddressOf(user);
    if (address === null) return { kind: 'no-address' };
    return {
      kind: 'available',
      address,
      on: (await this.deps.mail.switchedOnAt(user.id)) !== null,
    };
  }

  async set(user: UserRecord, on: boolean): Promise<MailSwitchResult> {
    // Off is always allowed: a person may switch off what they can no longer receive.
    if (on && !this.available) return { ok: false, problem: 'mail-unavailable' };
    if (on && mailAddressOf(user) === null) return { ok: false, problem: 'no-mail-address' };
    const wasOn = await this.deps.mail.set(user.id, on);
    if (wasOn !== on) {
      await this.deps.audit.write({
        kind: 'admin',
        ts: toIso(this.deps.clock.now()),
        user_id: user.id,
        act: 'mail-notifications-changed',
        object: { type: 'user', id: user.id },
        before: { on: wasOn },
        after: { on },
      });
    }
    return { ok: true, on };
  }

  /** Who receives mail notifications: nobody while the instance delivers no mail. */
  async switchedOn(): Promise<ReadonlySet<string>> {
    return this.available ? this.deps.mail.switchedOn() : new Set();
  }
}

export interface MailNotifierDeps {
  readonly mail: Pick<NotificationMailRepo, 'switchedOnAt'>;
  readonly users: { getById(id: string): Promise<UserRecord | null> };
  readonly mailer: NoticeMailer | null;
  readonly publicUrl: URL;
  readonly logger: Logger;
}

/** The kind "mail": one plain mail to the person's address, when they switched it on. */
export function createMailNotifier(deps: MailNotifierDeps): Notifier {
  return {
    async notify(userId, notification) {
      if (deps.mailer === null) return;
      if ((await deps.mail.switchedOnAt(userId)) === null) return;
      const user = await deps.users.getById(userId);
      const to = user ? mailAddressOf(user) : null;
      if (to === null) return;
      const { subject, text } = notificationMail(notification, deps.publicUrl);
      try {
        await deps.mailer.sendNotice({ to, subject, text });
      } catch {
        // The mailer logged it, without the address; never retried.
        deps.logger.warn('notification not delivered', {
          channel: 'mail',
          kind: notification.kind,
        });
      }
    },
  };
}

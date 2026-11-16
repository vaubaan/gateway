/**
 * What a notification is and what it says (spec §4.2 bis): the instance's name, the kind,
 * the mission's or account's name and, for a request, the tool by its title; and where
 * opening it leads. Nothing else, by construction: the type has no field for an argument,
 * a fingerprint, a secret value, a resource name or a person's name, and the payload is
 * built from these fields only (`notification.property.test.ts` holds it).
 *
 * The words are the instance's, not a page's: a notification is read on a lock screen,
 * outside the interface, by the person it is addressed to. Pure.
 */

import type { RequestKind } from '@vaubaan/shared';

export const NOTIFICATION_KINDS = [
  'request-opened',
  'account-needs-reconnecting',
  'mission-orphaned',
  'mission-account-lost',
  'mission-revoked',
  'backup-failed',
  'master-key-recovery',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** A request the creator may answer: a claim, an approval request, a permission request. */
export type RequestNotificationKind = RequestKind;

/** What a notification is about, and where opening it leads. */
export type NotificationBody = { readonly path: string } & (
  | {
      readonly kind: 'request-opened';
      readonly request: RequestNotificationKind;
      readonly mission: string;
      /** The tool by its plugin's title ("Merge a pull request"), else its name; `null` for none. */
      readonly tool: string | null;
    }
  | { readonly kind: 'account-needs-reconnecting'; readonly account: string }
  | { readonly kind: 'mission-orphaned'; readonly mission: string }
  | { readonly kind: 'mission-account-lost'; readonly mission: string }
  | { readonly kind: 'mission-revoked'; readonly mission: string }
  | { readonly kind: 'backup-failed' }
  | { readonly kind: 'master-key-recovery' }
);

/**
 * A notification: its body, and the instance's name (or the host of its public URL
 * without one). `path` is a path of the instance (`/r/<id>`, `/missions/<id>`…).
 */
export type Notification = NotificationBody & { readonly instance: string };

/** What the service worker receives, decrypted, and shows (`public/sw.js`). */
export interface PushPayload {
  readonly title: string;
  readonly body: string;
  /** A path of the instance; the worker resolves it against its own origin. */
  readonly url: string;
  /**
   * Groups notifications of one subject: a later one replaces an earlier one on the lock
   * screen. The path is unique per subject and names nothing.
   */
  readonly tag: string;
}

/** A name shown in a notification: one line, and short enough for a lock screen. */
export const NAME_MAX = 80;

/** A name on one line, cut to `NAME_MAX`. */
export function line(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > NAME_MAX ? `${flat.slice(0, NAME_MAX - 1)}…` : flat;
}

const REQUEST_WORDS: Readonly<Record<RequestNotificationKind, string>> = {
  claim: 'asks for more budget',
  approval: 'asks for your approval',
  permission: 'asks for a permission',
};

function bodyOf(notification: Notification): string {
  switch (notification.kind) {
    case 'request-opened': {
      const tool = notification.tool === null ? '' : ` to ${line(notification.tool)}`;
      return `${line(notification.mission)} ${REQUEST_WORDS[notification.request]}${tool}. Open it to answer.`;
    }
    case 'account-needs-reconnecting':
      return `${line(notification.account)} stopped serving: the service refused its credential. Reconnect it.`;
    case 'mission-orphaned':
      return `${line(notification.mission)} stopped: you no longer hold what it accepted.`;
    case 'mission-account-lost':
      return `An account no longer serves ${line(notification.mission)}: calls through it are refused.`;
    case 'mission-revoked':
      return `${line(notification.mission)} was stopped by someone else.`;
    case 'backup-failed':
      return 'The scheduled backup failed: nothing was uploaded.';
    case 'master-key-recovery':
      return 'An administrator was named with the master key. If it was not one of you, rotate it.';
  }
}

/** The payload of a notification: built from its fields only, never from anything else. */
export function buildPayload(notification: Notification): PushPayload {
  return {
    title: line(notification.instance),
    body: bodyOf(notification),
    url: notification.path,
    tag: notification.path,
  };
}

/** The bytes the transport encrypts: the payload as JSON. */
export function serializePayload(notification: Notification): string {
  return JSON.stringify(buildPayload(notification));
}

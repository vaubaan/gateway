/**
 * The events that notify (spec §4.2 bis "What notifies"), as the modules that cause them
 * see them: one method per event, each returning at once. The module that records the
 * event calls it after its write committed, never inside its transaction, and awaits
 * nothing: who to tell, what to say and the delivery happen in the background
 * (`dispatch.ts`). A failure there never reaches the caller.
 *
 * Every module takes this port optionally and defaults to `NO_NOTIFICATIONS`, so a test
 * of one module needs no notifier, and nothing in a module depends on a notification.
 */
import type { RequestNotificationKind } from './notification';

export interface RequestOpenedEvent {
  readonly requestId: string;
  readonly missionId: string;
  readonly request: RequestNotificationKind;
  /** The tool the request is about, as the protocol names it; `null` when none. */
  readonly tool: string | null;
}

export interface NotificationEvents {
  /** A request opened in its creator's inbox (claim, approval request, permission request). */
  requestOpened(event: RequestOpenedEvent): void;
  /** An account turned `expired`: its credential was rejected and could not be refreshed. */
  accountNeedsReconnecting(accountId: string): void;
  /**
   * A mission became orphaned through the act of `actorId` (its derived verdict changed); its
   * creator is told when it was somebody else's act.
   */
  missionOrphaned(missionId: string, actorId: string): void;
  /**
   * An account of a mission stopped serving it through the act of `actorId` (disconnected,
   * an access withdrawn) while the mission keeps running on its others; its creator is told
   * when it was somebody else's act.
   */
  missionAccountLost(missionId: string, actorId: string): void;
  /** A mission was revoked by `actorId`; its creator is told when it was somebody else. */
  missionRevoked(missionId: string, actorId: string): void;
  /** A scheduled backup failed and uploaded nothing. */
  backupFailed(): void;
  /** An administrator was named through the recovery by the master key. */
  masterKeyRecovered(): void;
  /** A signer was added to the ones the instance trusts for its private plugins. */
  pluginSignerAdded(signer: string): void;
}

const ignore = (): void => undefined;

/** The events of a module wired without notifications (tests, a command). */
export const NO_NOTIFICATIONS: NotificationEvents = {
  requestOpened: ignore,
  accountNeedsReconnecting: ignore,
  missionOrphaned: ignore,
  missionAccountLost: ignore,
  missionRevoked: ignore,
  backupFailed: ignore,
  masterKeyRecovered: ignore,
  pluginSignerAdded: ignore,
};

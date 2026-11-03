/**
 * The messaging addresses a person receives notifications at (migration 0031; spec §4.2
 * bis). The URL — an incoming webhook, a secret of the person — is sealed under the master
 * key with `notification-address:<id>` as associated data; nothing else of it is stored but
 * its SHA-256 salted with the person's id, which makes one URL one row per person.
 *
 * Keyed by user (**[inv: lookups-keyed-by-parent]**): an address is removed or read with its
 * user only, and one of another user reads as missing. Only the notifier opens a URL
 * (`destinationsOf`); a record never carries it.
 */

import { createHash } from 'node:crypto';

import { withImmediateTransaction } from '../db.ts';
import { openText, sealText } from '../encryptor.ts';
import type { Iso } from '../types.ts';
import { nowIso, parseEnum, type RepoContext } from './context.ts';

/** The services an address may belong to: a closed set, one message format each. */
export const ADDRESS_KINDS = ['slack', 'teams', 'discord', 'ntfy', 'generic'] as const;
export type AddressKind = (typeof ADDRESS_KINDS)[number];

/** An address as its person sees it: never the URL. */
export interface NotificationAddressRecord {
  readonly id: string;
  readonly userId: string;
  readonly kind: AddressKind;
  readonly label: string;
  readonly createdAt: Iso;
  readonly lastDeliveredAt: Iso | null;
  readonly lastFailureAt: Iso | null;
  /** The service's HTTP status of the last failure; `null` when it never answered or was refused. */
  readonly lastFailureStatus: number | null;
}

/** An address with its URL opened: for the notifier only. */
export interface AddressDestination {
  readonly addressId: string;
  readonly kind: AddressKind;
  readonly url: string;
}

/** What one delivery to an address came to, recorded on its row. */
export type AddressDeliveryRecord =
  { readonly kind: 'delivered' } | { readonly kind: 'failed'; readonly status: number | null };

/** An address is reached with its user only. */
export interface AddressKey {
  readonly userId: string;
  readonly addressId: string;
}

export interface NotificationAddressesRepo {
  /** Adds the address; `null` when the person already has this URL. */
  add(input: {
    readonly userId: string;
    readonly kind: AddressKind;
    readonly label: string;
    readonly url: string;
  }): Promise<NotificationAddressRecord | null>;
  /** Whether the person already has this URL (checked before the test message leaves). */
  has(userId: string, url: string): Promise<boolean>;
  /** The person's addresses, newest first. */
  listForUser(userId: string): Promise<NotificationAddressRecord[]>;
  countForUser(userId: string): Promise<number>;
  get(key: AddressKey): Promise<NotificationAddressRecord | null>;
  /** The removed address; `null` when the person has no such address. */
  remove(key: AddressKey): Promise<NotificationAddressRecord | null>;
  /** Every address of the person, URL opened. */
  destinationsOf(userId: string): Promise<AddressDestination[]>;
  recordDelivery(key: AddressKey, outcome: AddressDeliveryRecord): Promise<void>;
  /** How many addresses each person has (Administration → People). */
  countsByUser(): Promise<ReadonlyMap<string, number>>;
}

interface AddressRow {
  id: string;
  user_id: string;
  kind: string;
  label: string;
  created_at: string;
  last_delivered_at: string | null;
  last_failure_at: string | null;
  last_failure_status: number | null;
}

interface SealedRow {
  id: string;
  kind: string;
  url_blob: Buffer;
  key_version: number;
}

const COLUMNS = `id, user_id, kind, label, created_at, last_delivered_at, last_failure_at,
  last_failure_status`;

/** The associated data of an address's sealed URL. */
export function addressUrlAd(id: string): string {
  return `notification-address:${id}`;
}

/**
 * The one-way digest that makes a URL one row per person; the URL is never stored clear.
 * Salted with the person's id: a guessable URL (a ntfy topic) is not reversed with one
 * dictionary for every row of a stolen store.
 */
export function addressUrlDigest(userId: string, url: string): string {
  return createHash('sha256').update(`${userId}\0${url}`, 'utf8').digest('hex');
}

function kindOf(raw: string): AddressKind {
  return parseEnum(ADDRESS_KINDS, raw, 'notification_addresses.kind');
}

function toRecord(row: AddressRow): NotificationAddressRecord {
  return {
    id: row.id,
    userId: row.user_id,
    kind: kindOf(row.kind),
    label: row.label,
    createdAt: row.created_at,
    lastDeliveredAt: row.last_delivered_at,
    lastFailureAt: row.last_failure_at,
    lastFailureStatus: row.last_failure_status,
  };
}

export function createNotificationAddressesRepo(ctx: RepoContext): NotificationAddressesRepo {
  const { db, encryptor } = ctx;
  const byKey = db.prepare<[string, string], AddressRow>(
    `SELECT ${COLUMNS} FROM notification_addresses WHERE id = ? AND user_id = ?`,
  );
  const byUser = db.prepare<[string], AddressRow>(
    `SELECT ${COLUMNS} FROM notification_addresses WHERE user_id = ?
     ORDER BY created_at DESC, id DESC`,
  );
  const countOne = db.prepare<[string], { n: number }>(
    'SELECT COUNT(*) AS n FROM notification_addresses WHERE user_id = ?',
  );
  const byDigest = db.prepare<[string, string], { id: string }>(
    'SELECT id FROM notification_addresses WHERE user_id = ? AND url_digest = ?',
  );
  const sealedOf = db.prepare<[string], SealedRow>(
    `SELECT id, kind, url_blob, key_version FROM notification_addresses
     WHERE user_id = ? ORDER BY created_at, id`,
  );
  const insert = db.prepare<[string, string, string, string, string, Buffer, number, string]>(
    `INSERT INTO notification_addresses
       (id, user_id, kind, label, url_digest, url_blob, key_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const removeStmt = db.prepare<[string, string]>(
    'DELETE FROM notification_addresses WHERE id = ? AND user_id = ?',
  );
  const delivered = db.prepare<[string, string, string]>(
    'UPDATE notification_addresses SET last_delivered_at = ? WHERE id = ? AND user_id = ?',
  );
  const failed = db.prepare<[string, number | null, string, string]>(
    `UPDATE notification_addresses SET last_failure_at = ?, last_failure_status = ?
     WHERE id = ? AND user_id = ?`,
  );
  const counts = db.prepare<[], { user_id: string; count: number }>(
    'SELECT user_id, COUNT(*) AS count FROM notification_addresses GROUP BY user_id',
  );

  return {
    async add({ userId, kind, label, url }) {
      const id = ctx.newId();
      // Sealed before the transaction: the encryptor is asynchronous, the driver is not.
      const sealed = await sealText(encryptor, addressUrlAd(id), url);
      const digest = addressUrlDigest(userId, url);
      const now = nowIso(ctx);
      const written = withImmediateTransaction(db, () => {
        if (byDigest.get(userId, digest)) return false;
        insert.run(id, userId, kind, label, digest, sealed.blob, sealed.keyVersion, now);
        return true;
      });
      if (!written) return null;
      const row = byKey.get(id, userId);
      if (!row) throw new Error(`notification_addresses: '${id}' was not written`);
      return toRecord(row);
    },
    async has(userId, url) {
      return byDigest.get(userId, addressUrlDigest(userId, url)) !== undefined;
    },
    async listForUser(userId) {
      return byUser.all(userId).map(toRecord);
    },
    async countForUser(userId) {
      return countOne.get(userId)?.n ?? 0;
    },
    async get({ userId, addressId }) {
      const row = byKey.get(addressId, userId);
      return row ? toRecord(row) : null;
    },
    async remove({ userId, addressId }) {
      return withImmediateTransaction(db, () => {
        const row = byKey.get(addressId, userId);
        if (!row) return null;
        removeStmt.run(addressId, userId);
        return toRecord(row);
      });
    },
    async destinationsOf(userId) {
      const out: AddressDestination[] = [];
      for (const row of sealedOf.all(userId)) {
        const url = await openText(encryptor, addressUrlAd(row.id), {
          blob: row.url_blob,
          keyVersion: row.key_version,
        });
        out.push({ addressId: row.id, kind: kindOf(row.kind), url });
      }
      return out;
    },
    async recordDelivery({ userId, addressId }, outcome) {
      const now = nowIso(ctx);
      if (outcome.kind === 'delivered') delivered.run(now, addressId, userId);
      else failed.run(now, outcome.status, addressId, userId);
    },
    async countsByUser() {
      return new Map(counts.all().map((row) => [row.user_id, row.count]));
    },
  };
}

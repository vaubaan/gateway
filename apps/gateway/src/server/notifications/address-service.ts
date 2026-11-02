/**
 * A person's messaging addresses (spec §4.2 bis "A messaging address is a secret of the
 * person, sealed, never shown back, checked on entry by a test notification"): listed, added
 * and removed by that person only, every call keyed by the signed-in user.
 *
 * Adding posts a test message at once and stores the address only when the service took it
 * (2xx); otherwise the person reads the status, never the URL. Adding and removing are
 * audited (`address-added`, `address-removed`) with the id, kind and label, never the URL.
 * An administrator reads how many addresses a person has, never which (`countsByUser`).
 */
import type { AuditWriter } from '@vaubaan/gateway-core';

import type { Clock } from '../store/clock';
import { toIso } from '../store/clock';
import type {
  NotificationAddressesRepo,
  NotificationAddressRecord,
} from '../store/repositories/notification-addresses';
import type { UserRecord } from '../store/types';
import { parseLabel } from './device-service';
import { checkAddressUrl, isAddressKind, type AddressKind } from './messaging/address-rules';
import { testMessage } from './messaging/messages';
import type { MessagingTransport } from './messaging/transport';

/**
 * Addresses per person: every notification posts to each, one after the other, so the list
 * stays short (a team channel, a personal topic…). Beyond it, remove one first.
 */
export const ADDRESSES_MAX = 10;

/** What a page shows of an address: never the URL. */
export interface AddressView {
  readonly id: string;
  readonly kind: AddressKind;
  readonly label: string;
  readonly created_at: string;
  readonly last_delivered_at: string | null;
  readonly last_failure_at: string | null;
  readonly last_failure_status: number | null;
}

export const ADDRESS_PROBLEMS = [
  'invalid-kind',
  'invalid-label',
  'invalid-address',
  'wrong-host',
  'private-destination',
  'already-added',
  'too-many-addresses',
  'test-failed',
  'address-not-found',
] as const;
export type AddressProblem = (typeof ADDRESS_PROBLEMS)[number];

export type AddressResult =
  | { readonly ok: true; readonly address: AddressView }
  | {
      readonly ok: false;
      readonly problem: AddressProblem;
      /** For `test-failed`: the service's HTTP status, `null` when it never answered. */
      readonly status?: number | null;
    };

export interface AddressServiceDeps {
  readonly addresses: NotificationAddressesRepo;
  readonly transport: MessagingTransport;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  /** The instance's name, in the test message. */
  readonly instanceName: () => Promise<string>;
  /** Where the test message leads: the Settings page, absolute. */
  readonly settingsUrl: string;
}

export function addressViewOf(record: NotificationAddressRecord): AddressView {
  return {
    id: record.id,
    kind: record.kind,
    label: record.label,
    created_at: record.createdAt,
    last_delivered_at: record.lastDeliveredAt,
    last_failure_at: record.lastFailureAt,
    last_failure_status: record.lastFailureStatus,
  };
}

export class AddressService {
  constructor(private readonly deps: AddressServiceDeps) {}

  async list(user: UserRecord): Promise<AddressView[]> {
    return (await this.deps.addresses.listForUser(user.id)).map(addressViewOf);
  }

  async add(
    user: UserRecord,
    input: { kind: unknown; label: unknown; url: unknown },
  ): Promise<AddressResult> {
    if (!isAddressKind(input.kind)) return { ok: false, problem: 'invalid-kind' };
    const kind = input.kind;
    const label = parseLabel(input.label);
    if (label === null) return { ok: false, problem: 'invalid-label' };
    const checked = checkAddressUrl(kind, typeof input.url === 'string' ? input.url : '');
    if (!checked.ok) return { ok: false, problem: checked.problem };
    const url = checked.url.href;
    // Checked before the test message: two adds racing for the last place may both pass
    // (accepted, as for the devices).
    if ((await this.deps.addresses.countForUser(user.id)) >= ADDRESSES_MAX) {
      return { ok: false, problem: 'too-many-addresses' };
    }
    if (await this.deps.addresses.has(user.id, url)) return { ok: false, problem: 'already-added' };

    const message = testMessage(await this.deps.instanceName(), this.deps.settingsUrl);
    const outcome = await this.deps.transport.send(kind, url, message);
    if (outcome.kind === 'refused') {
      if (outcome.refusal === 'unresolved')
        return { ok: false, problem: 'test-failed', status: null };
      return { ok: false, problem: outcome.refusal };
    }
    if (outcome.kind === 'failed') {
      return { ok: false, problem: 'test-failed', status: outcome.status };
    }

    const record = await this.deps.addresses.add({ userId: user.id, kind, label, url });
    if (record === null) return { ok: false, problem: 'already-added' };
    // The test message was the first delivery.
    await this.deps.addresses.recordDelivery(
      { userId: user.id, addressId: record.id },
      { kind: 'delivered' },
    );
    await this.audit(user, 'address-added', null, {
      address_id: record.id,
      kind: record.kind,
      label: record.label,
    });
    const stored = await this.deps.addresses.get({ userId: user.id, addressId: record.id });
    return { ok: true, address: addressViewOf(stored ?? record) };
  }

  async remove(user: UserRecord, addressId: string): Promise<AddressResult> {
    const record = await this.deps.addresses.remove({ userId: user.id, addressId });
    if (!record) return { ok: false, problem: 'address-not-found' };
    await this.audit(
      user,
      'address-removed',
      { address_id: record.id, kind: record.kind, label: record.label },
      null,
    );
    return { ok: true, address: addressViewOf(record) };
  }

  /** How many addresses each person has: for an administrator, never which. */
  countsByUser(): Promise<ReadonlyMap<string, number>> {
    return this.deps.addresses.countsByUser();
  }

  private audit(
    user: UserRecord,
    act: 'address-added' | 'address-removed',
    before: Record<string, unknown> | null,
    after: Record<string, unknown> | null,
  ): Promise<void> {
    return this.deps.audit.write({
      kind: 'admin',
      ts: toIso(this.deps.clock.now()),
      user_id: user.id,
      act,
      object: { type: 'user', id: user.id },
      before,
      after,
      delegated_client_id: null,
    });
  }
}

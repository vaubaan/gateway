/**
 * The instance identifier of community telemetry (spec §9; ADR
 * telemetry-two-levels-behind-a-vercel-collector, amendment 2026-11-02).
 *
 * 128 random bits, hex, drawn the first time a profile needs one and kept in
 * `instance_config` as `telemetry.instance_id`. It travels in the daily
 * instance profile only (level `usage-stats`), never with a call. An
 * administrator sees it on Admin → Telemetry and can regenerate it there.
 *
 * Read from the store on every use, never held in memory: every replica of a
 * deployment sends the same identifier, and a regeneration on one is seen by
 * all. A restore from a backup brings the identifier of the backup back.
 */
import { randomBytes } from 'node:crypto';

import { INSTANCE_ID_PATTERN } from '@vaubaan/telemetry';

import type { ConfigRepo } from '../store/repositories/config';

export const TELEMETRY_INSTANCE_ID_KEY = 'telemetry.instance_id';
/** `object.id` of the audit entry of a regeneration. */
export const INSTANCE_ID_CONFIG_OBJECT_ID = 'telemetry-instance-id';

export interface InstanceIdentifierDeps {
  readonly store: Pick<ConfigRepo, 'get' | 'set'>;
  /** 16 random bytes (tests). */
  readonly randomBytes?: () => Buffer;
}

export class InstanceIdentifier {
  constructor(private readonly deps: InstanceIdentifierDeps) {}

  /** The stored identifier, or `null` when none was drawn yet. Never draws one. */
  async peek(): Promise<string | null> {
    const stored = await this.deps.store.get(TELEMETRY_INSTANCE_ID_KEY);
    return stored !== null && INSTANCE_ID_PATTERN.test(stored) ? stored : null;
  }

  /**
   * The identifier the profile carries: the stored one, or a new one drawn
   * and stored now. A value that is not 32 hex characters is replaced.
   */
  async current(): Promise<string> {
    const stored = await this.peek();
    if (stored !== null) return stored;
    const drawn = this.draw();
    await this.deps.store.set(TELEMETRY_INSTANCE_ID_KEY, drawn);
    // Read back: two first uses racing settle on the value that was stored last.
    return (await this.peek()) ?? drawn;
  }

  /** The administrator's regeneration: a new identifier replaces the stored one. */
  async regenerate(): Promise<{ before: string | null; after: string }> {
    const before = await this.peek();
    const after = this.draw();
    await this.deps.store.set(TELEMETRY_INSTANCE_ID_KEY, after);
    return { before, after };
  }

  private draw(): string {
    return (this.deps.randomBytes ?? (() => randomBytes(16)))().toString('hex');
  }
}

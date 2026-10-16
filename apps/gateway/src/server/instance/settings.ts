/**
 * Who names this instance (spec §4.3, §4.2). The rule every setting shared by
 * the mounted configuration and the Administration page follows (telemetry's
 * toggle, the sign-in providers, the company apps):
 *
 *   1. the configuration sets `instance_name` (file or environment)
 *        → that name, and the Administration field is read-only;
 *   2. otherwise the name an administrator saved, stored as `instance.name`
 *      in `instance_config`;
 *   3. otherwise no name: the interface shows the host of the public URL.
 *
 * Read from the store on every call, with no copy kept in memory: the shell
 * asks once per page, one indexed read of the embedded store, and a name saved
 * by another replica is seen at the next page.
 */
import { checkInstanceName, type InstanceConfig, type InstanceNameCheck } from '../config';
import type { ConfigRepo } from '../store/repositories/config';

export const INSTANCE_NAME_KEY = 'instance.name';
/** `object.id` of the audit entry of a change. */
export const INSTANCE_NAME_OBJECT_ID = 'instance-name';

/** Where the name comes from. */
export type InstanceNameSource = 'config' | 'admin' | 'default';

/** How the interface names this instance. */
export interface InstanceIdentity {
  /** What the shell prints: the name, or the host of the public URL when there is none. */
  readonly label: string;
  /** The name set by the configuration or by an administrator; `null` when none is. */
  readonly name: string | null;
  /** The host of the public URL, kept visible beside the name. */
  readonly host: string;
  readonly source: InstanceNameSource;
}

/** What one change records, before and after (the audit entry's `before` / `after`). */
export interface InstanceNameState {
  readonly name: string | null;
  readonly source: InstanceNameSource;
}

export class InstanceNameLockedError extends Error {
  constructor() {
    super(
      'instance_name is set by the mounted configuration; change it there ' +
        '(instance_name / VAUBAAN_INSTANCE_NAME)',
    );
    this.name = 'InstanceNameLockedError';
  }
}

export class InvalidInstanceNameError extends Error {
  constructor(readonly problem: Exclude<InstanceNameCheck, { ok: true }>['problem']) {
    super(`invalid instance name: ${problem}`);
    this.name = 'InvalidInstanceNameError';
  }
}

export interface InstanceNameDeps {
  readonly config: Pick<InstanceConfig, 'instanceName' | 'publicUrl'>;
  readonly store: Pick<ConfigRepo, 'get' | 'set' | 'delete'>;
}

export class InstanceNameService {
  constructor(private readonly deps: InstanceNameDeps) {}

  /** True when the mounted configuration names the instance: Administration cannot change it. */
  isLocked(): boolean {
    return this.deps.config.instanceName !== null;
  }

  /** The effective name, its source, and the host it stands beside. */
  async identity(): Promise<InstanceIdentity> {
    const { name, source } = await this.state();
    const host = this.deps.config.publicUrl.host;
    return { label: name ?? host, name, host, source };
  }

  /**
   * An administrator's change: `raw` is trimmed and checked; blank clears the
   * name (the host is shown again). Refused while the configuration decides.
   * Returns the state before and after, for the audit entry.
   */
  async setName(raw: string): Promise<{ before: InstanceNameState; after: InstanceNameState }> {
    if (this.isLocked()) throw new InstanceNameLockedError();
    const before = await this.state();
    if (raw.trim() === '') {
      await this.deps.store.delete(INSTANCE_NAME_KEY);
    } else {
      const check = checkInstanceName(raw);
      if (!check.ok) throw new InvalidInstanceNameError(check.problem);
      await this.deps.store.set(INSTANCE_NAME_KEY, check.name);
    }
    const after = await this.state();
    return { before, after };
  }

  private async state(): Promise<InstanceNameState> {
    const configured = this.deps.config.instanceName;
    if (configured !== null) return { name: configured, source: 'config' };
    const stored = await this.deps.store.get(INSTANCE_NAME_KEY);
    // A stored value is checked again: a row written by hand never reaches the page unchecked.
    const check = stored === null ? null : checkInstanceName(stored);
    return check?.ok ? { name: check.name, source: 'admin' } : { name: null, source: 'default' };
  }
}

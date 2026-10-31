/**
 * Setup mode (ADR master-key-generated-and-handed-over-by-the-instance,
 * amendment): the process started without its master key because the
 * configuration names a restore (`restore.from`), the store is empty and the
 * key file is absent. No composition root exists; the setup page receives the
 * key file, writes it, and `complete()` runs the normal boot — the first-boot
 * restore with every verification, then the store opens.
 *
 * The state lives on `globalThis`, like the root's handle: the proxy, the
 * pages and the routes read it from their own module graphs. This module
 * imports types only, so the proxy's bundle stays small.
 */
import type { BuildInfo, SetupConfig } from '../config';
import type { Logger, Redactor } from '../logging';
import type { RateLimiter } from '../compose/ports';
import type { SetupMissesFile } from './misses';

export interface SetupRefusal {
  /** What the boot said when the received key did not complete it; never the source, never the key. */
  readonly message: string;
  readonly at: string;
}

export interface SetupState {
  readonly config: SetupConfig;
  /** Where the key file goes, as the configuration names it. */
  readonly masterKeyFile: string;
  readonly logger: Logger;
  readonly redactor: Redactor;
  readonly build: BuildInfo;
  readonly startedAt: Date;
  readonly rateLimiter: RateLimiter;
  /** Wrong bootstrap tokens presented, this start and the earlier ones (`missesFile`). */
  misses: number;
  /** Where `misses` is kept across restarts: next to the key file. */
  readonly missesFile: SetupMissesFile;
  lastRefusal: SetupRefusal | null;
  /** Builds the composition root with the key now on disk; rejects when the boot refuses. */
  complete(): Promise<void>;
}

/** Thrown by `getRoot()` while the instance waits for its key. */
export class SetupModeError extends Error {
  constructor() {
    super('the instance is in setup mode: it waits for its master key on the setup page');
    this.name = 'SetupModeError';
  }
}

const SETUP_KEY = Symbol.for('vaubaan.gateway.setup');

type GlobalWithSetup = typeof globalThis & { [SETUP_KEY]?: SetupState };

export function publishSetup(state: SetupState): void {
  (globalThis as GlobalWithSetup)[SETUP_KEY] = state;
}

export function currentSetup(): SetupState | null {
  return (globalThis as GlobalWithSetup)[SETUP_KEY] ?? null;
}

export function clearSetup(): void {
  delete (globalThis as GlobalWithSetup)[SETUP_KEY];
}

/** The paths the proxy lets through in setup mode; everything else goes to the setup page. */
export const SETUP_PAGE = '/admin/bootstrap';
export const SETUP_KEY_ACTION = '/api/setup/master-key';
const SETUP_PATHS = /^\/(?:admin\/bootstrap$|api\/setup\/|healthz$|ops\/stats$|_next\/|favicon)/;

export function servedInSetupMode(pathname: string): boolean {
  return SETUP_PATHS.test(pathname);
}

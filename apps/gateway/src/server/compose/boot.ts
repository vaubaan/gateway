/**
 * Boot: build the root before the server accepts a request, or exit — or
 * start in setup mode.
 *
 * Called from `instrumentation.ts#register()` (Node runtime only, not during
 * `next build`). Next.js waits for `register()` before serving, so a
 * configuration error here means the container stops with a non-zero exit
 * code and a message naming every missing or invalid key (spec §4.3).
 *
 * Setup mode (ADR master-key-generated-and-handed-over-by-the-instance,
 * amendment): when the master key file is absent, `restore.from` is set and
 * the store is empty, no root is built; the setup page receives the key and
 * completes the boot (`server/setup/`).
 */
import { buildInfoFromEnv, ConfigError, secretValues, type LoadOptions } from '../config';
import { createLogger, createRedactor, guardConsole } from '../logging';
import { SlidingWindowRateLimiter } from '../rate-limit';
import { currentSetup, publishSetup } from '../setup/state';
import { loadBootConfig, loadBootConfigOrSetup } from './boot-config';
import { getRoot, rootStarted, type RootDeps } from './root';

/**
 * Routes Next.js's own error printing through the redactor of the built root — or
 * of the setup state —, with error messages withheld (`logging/console-guard.ts`).
 * Called by `instrumentation.ts` after a successful boot; a failed boot has exited before.
 */
export async function guardFrameworkLogging(): Promise<void> {
  const setup = currentSetup();
  if (setup) {
    guardConsole(setup.redactor);
    return;
  }
  const root = await getRoot();
  guardConsole(createRedactor(secretValues(root.config)));
}

export interface BootIo {
  readonly stderr: (text: string) => void;
  readonly exit: (code: number) => void;
}

const defaultIo: BootIo = {
  stderr: (text) => process.stderr.write(text),
  exit: (code) => process.exit(code),
};

export const EXIT_CONFIG_ERROR = 78; // EX_CONFIG from sysexits(3)
export const EXIT_BOOT_ERROR = 1;

/** What a start reads its configuration from (tests: an environment of their own). */
export interface BootDeps extends RootDeps {
  readonly env?: LoadOptions['env'];
  readonly readFile?: LoadOptions['readFile'];
}

export type BootState = 'ready' | 'setup';

/**
 * Starts the instance: the composition root, or setup mode. With an injected
 * `loadConfig` (tests), or a root already started in this process (the demo
 * builds it before the server starts), the root is what it is and setup mode
 * never applies.
 */
export async function startInstance(deps: BootDeps = {}): Promise<BootState> {
  const { env, readFile, ...rootDeps } = deps;
  if (rootDeps.loadConfig || rootStarted()) {
    await getRoot(rootDeps);
    return 'ready';
  }
  const outcome = loadBootConfigOrSetup({ env, readFile });
  if (outcome.kind === 'ready') {
    const { loaded } = outcome;
    await getRoot({ ...rootDeps, loadConfig: () => loaded });
    return 'ready';
  }
  const { setup, env: snapshot } = outcome;
  const redactor = createRedactor(secretValues(setup.config));
  const logger = createLogger({
    level: setup.config.log.level,
    redact: redactor,
    write: rootDeps.logWrite,
  }).child({ component: 'gateway' });
  // The path of the key file and whether an install token exists: never a value.
  const keyFilePath = setup.masterKeyFile;
  const hasInstallToken = setup.config.bootstrapToken !== null;
  logger.warn('starting in setup mode: the master key file is absent and a restore is configured', {
    key_file: keyFilePath,
    store_path: setup.config.store.path,
    public_origin: setup.config.publicUrl.origin,
    has_install_token: hasInstallToken,
    remedy: 'open /admin/bootstrap and hand the gateway the key file of the copy',
  });
  publishSetup({
    config: setup.config,
    masterKeyFile: setup.masterKeyFile,
    logger,
    redactor,
    build: rootDeps.build ?? buildInfoFromEnv(),
    startedAt: new Date(),
    rateLimiter: new SlidingWindowRateLimiter(),
    misses: 0,
    lastRefusal: null,
    complete: async () => {
      await getRoot({
        ...rootDeps,
        loadConfig: () => loadBootConfig({ env: snapshot, readFile, scrub: false }),
      });
    },
  });
  return 'setup';
}

export async function bootOrExit(deps?: BootDeps, io: BootIo = defaultIo): Promise<void> {
  try {
    await startInstance(deps);
  } catch (err) {
    if (err instanceof ConfigError) {
      io.stderr(
        `${err.message}\n\nSee deploy/config/gateway.example.yaml and deploy/config/.env.example for every key.\n`,
      );
      io.exit(EXIT_CONFIG_ERROR);
      return;
    }
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    io.stderr(`Gateway failed to start: ${message}\n`);
    io.exit(EXIT_BOOT_ERROR);
  }
}

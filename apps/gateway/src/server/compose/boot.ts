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
import { publishLocalMode } from '../http/local-mode';
import { createLogger, createRedactor, guardConsole } from '../logging';
import { SlidingWindowRateLimiter } from '../rate-limit';
import { setupMissesFile } from '../setup/misses';
import { currentSetup, publishSetup } from '../setup/state';
import { loadBootConfig, loadBootConfigOrSetup, localBootstrapToken } from './boot-config';
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
  /** Where a local instance prints its setup link (the process: standard output). */
  readonly stdout?: (text: string) => void;
}

/**
 * The lines a local instance prints while its setup is not finished: the link that
 * opens it, token in the fragment (ADR local-mode-for-an-instance-on-this-computer).
 * Printed on standard output, never through the logger, which redacts the token.
 */
export function localSetupAnnouncement(publicUrl: URL, token: string): string {
  const link = `${publicUrl.href.replace(/\/+$/, '')}/admin/bootstrap#token=${token}`;
  return [
    '',
    'Vaubaan runs on this computer. Open this link to set it up:',
    '',
    `  ${link}`,
    '',
    'The link changes at each start and stops working once the setup is finished.',
    '',
    '',
  ].join('\n');
}

/** Prints the setup link of a local instance whose bootstrap is still open. */
async function announceLocalSetup(
  config: {
    readonly local: boolean;
    readonly publicUrl: URL;
    readonly bootstrapToken: string | null;
  },
  open: () => Promise<boolean>,
  token: string,
  stdout: (text: string) => void,
): Promise<void> {
  if (!config.local || config.bootstrapToken !== token) return;
  if (!(await open())) return;
  stdout(localSetupAnnouncement(config.publicUrl, token));
}

const defaultStdout = (text: string): void => {
  process.stdout.write(text);
};

export type BootState = 'ready' | 'setup';

/**
 * Starts the instance: the composition root, or setup mode. With an injected
 * `loadConfig` (tests), or a root already started in this process (the demo
 * builds it before the server starts), the root is what it is and setup mode
 * never applies.
 */
export async function startInstance(deps: BootDeps = {}): Promise<BootState> {
  const { env, readFile, stdout = defaultStdout, ...rootDeps } = deps;
  if (rootDeps.loadConfig || rootStarted()) {
    await getRoot(rootDeps);
    return 'ready';
  }
  // Used only by a local instance that sets no token; the same for this whole start.
  const token = localBootstrapToken();
  const outcome = loadBootConfigOrSetup({ env, readFile, localBootstrapToken: token });
  if (outcome.kind === 'ready') {
    const { loaded } = outcome;
    const root = await getRoot({ ...rootDeps, loadConfig: () => loaded });
    await announceLocalSetup(
      loaded.config,
      async () => (await root.auth.bootstrap.state()).status === 'active',
      token,
      stdout,
    );
    return 'ready';
  }
  const { setup, env: snapshot } = outcome;
  const redactor = createRedactor(secretValues(setup.config));
  const logger = createLogger({
    level: setup.config.log.level,
    redact: redactor,
    write: rootDeps.logWrite,
  }).child({ component: 'gateway' });
  // The path of the key file and whether a bootstrap token is configured: never a value.
  const keyFilePath = setup.masterKeyFile;
  const bootstrapConfigured = setup.config.bootstrapToken !== null;
  logger.warn('starting in setup mode: the master key file is absent and a restore is configured', {
    key_file: keyFilePath,
    store_path: setup.config.store.path,
    public_origin: setup.config.publicUrl.origin,
    bootstrap_configured: bootstrapConfigured,
    remedy: 'open /admin/bootstrap and hand the gateway the key file of the copy',
  });
  publishLocalMode(setup.config.local);
  const missesFile = setupMissesFile(setup.masterKeyFile, logger);
  publishSetup({
    config: setup.config,
    masterKeyFile: setup.masterKeyFile,
    logger,
    redactor,
    build: rootDeps.build ?? buildInfoFromEnv(),
    startedAt: new Date(),
    rateLimiter: new SlidingWindowRateLimiter(),
    misses: missesFile.read(),
    missesFile,
    lastRefusal: null,
    complete: async () => {
      await getRoot({
        ...rootDeps,
        loadConfig: () =>
          loadBootConfig({ env: snapshot, readFile, scrub: false, localBootstrapToken: token }),
      });
    },
  });
  // Setup mode is before any store: its bootstrap cannot have been revoked yet.
  await announceLocalSetup(setup.config, async () => true, token, stdout);
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

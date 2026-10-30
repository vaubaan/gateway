/**
 * Entry point: `node src/main.ts` (Node runs the TypeScript as is, so the
 * image holds the very source a reviewer reads). Reads two environment
 * variables, and the `unattested` platform its secrets:
 *
 *   OAUTH_BROKER_PLATFORM  set by the release image to Confidential Space;
 *                          `unattested` without an enclave, `local` for development
 *   OAUTH_BROKER_CONFIG    the operator's JSON configuration (src/config.ts)
 *   OAUTH_BROKER_SECRET_*  `unattested` only (src/platform/unattested.ts)
 *
 * Any failure at start stops the process with a named, non-sensitive reason.
 */
import { startBroker } from './app.ts';
import { parseConfig } from './config.ts';
import { createLogger, errorKind } from './log.ts';
import { selectPlatform } from './platform/index.ts';
import { PROVIDERS } from './providers.ts';

const log = createLogger();

process.on('uncaughtException', (error) => {
  log.warn('uncaught_exception', { kind: errorKind(error) });
  process.exit(1);
});
process.on('unhandledRejection', (error) => {
  log.warn('unhandled_rejection', { kind: errorKind(error) });
  process.exit(1);
});

try {
  const config = parseConfig(process.env.OAUTH_BROKER_CONFIG ?? '', PROVIDERS);
  const platform = selectPlatform(process.env.OAUTH_BROKER_PLATFORM, config.platform);
  // The configuration and the platform's name are all this process needs from its environment.
  delete process.env.OAUTH_BROKER_CONFIG;
  const running = await startBroker({ config, providers: PROVIDERS, platform, log });
  const stop = (): void => {
    void running.close().then(() => process.exit(0));
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
} catch (error) {
  // Config and platform errors carry a message written here, naming no secret.
  const reason =
    error instanceof Error && /^(Config|Platform)Error$/.test(error.name) ? error.message : '';
  log.warn('start_failed', { kind: errorKind(error), reason });
  process.exit(1);
}

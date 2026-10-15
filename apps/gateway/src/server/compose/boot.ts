/**
 * Boot: build the root before the server accepts a request, or exit.
 *
 * Called from `instrumentation.ts#register()` (Node runtime only, not during
 * `next build`). Next.js waits for `register()` before serving, so a
 * configuration error here means the container stops with a non-zero exit
 * code and a message naming every missing or invalid key (spec §4.3).
 */
import { ConfigError, secretValues } from '../config';
import { createRedactor, guardConsole } from '../logging';
import { getRoot, type RootDeps } from './root';

/**
 * Routes Next.js's own error printing through the redactor of the built root, with
 * error messages withheld (`logging/console-guard.ts`). Called by `instrumentation.ts`
 * after a successful boot; a failed boot has exited before.
 */
export async function guardFrameworkLogging(): Promise<void> {
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

export async function bootOrExit(deps?: RootDeps, io: BootIo = defaultIo): Promise<void> {
  try {
    await getRoot(deps);
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

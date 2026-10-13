/**
 * What the demo refuses to start next to, decided before anything is opened.
 *
 * The demo signs anybody in without a password and answers every provider
 * from memory: it must never be mistaken for, or started beside, a real
 * instance. It therefore refuses a production environment and any sign that
 * the shell it runs in is configured for a real instance. It never reads the
 * instance configuration itself (`demo-instance.ts` builds its own, in
 * memory), so the refusal is a guard against a mistake, not a dependency.
 */
import { CONFIG_FILE_ENV } from '../../src/server/config';

/** The variable carrying a real instance's `public_url`. */
const PUBLIC_URL_ENV = 'VAUBAAN_PUBLIC_URL';
export const DEFAULT_DEMO_PORT = 3210;

export class DemoRefusal extends Error {
  constructor(message: string) {
    super(`The demo refuses to start: ${message}`);
    this.name = 'DemoRefusal';
  }
}

/** Throws a `DemoRefusal` naming the first reason the demo may not run in `env`. */
export function assertDemoAllowed(env: Record<string, string | undefined>): void {
  if (env.NODE_ENV === 'production') {
    throw new DemoRefusal(
      'NODE_ENV is "production". The demo signs anybody in without a password; it is for a developer machine only.',
    );
  }
  if (env[CONFIG_FILE_ENV]) {
    throw new DemoRefusal(
      `${CONFIG_FILE_ENV} is set (${env[CONFIG_FILE_ENV]}): this shell is configured for a real instance. Unset it, or use another shell.`,
    );
  }
  if (env[PUBLIC_URL_ENV]) {
    throw new DemoRefusal(
      `${PUBLIC_URL_ENV} is set (${env[PUBLIC_URL_ENV]}): this shell is configured for a real instance. Unset it, or use another shell.`,
    );
  }
}

/** `DEMO_PORT`, or the default; `0` lets the system pick a free port (the smoke test). */
export function demoPort(env: Record<string, string | undefined>): number {
  const raw = env.DEMO_PORT;
  if (raw === undefined || raw === '') return DEFAULT_DEMO_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new DemoRefusal(`DEMO_PORT must be a TCP port, got '${raw}'.`);
  }
  return port;
}

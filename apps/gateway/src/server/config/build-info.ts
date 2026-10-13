/**
 * Build stamps of the running image, for the boot log and `/healthz`.
 *
 * `next.config.ts` freezes them into the bundle at build time; outside a
 * build (tests, `next dev` without the variables) both read `dev`. Read here
 * because the configuration module is the only place that touches the
 * process environment.
 */
export interface BuildInfo {
  readonly version: string;
  readonly commit: string;
}

const UNSTAMPED = 'dev';

export function buildInfoFromEnv(): BuildInfo {
  return {
    version: process.env.NEXT_PUBLIC_GATEWAY_VERSION || UNSTAMPED,
    commit: process.env.NEXT_PUBLIC_COMMIT_SHA || UNSTAMPED,
  };
}

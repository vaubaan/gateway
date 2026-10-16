/**
 * Footer of every page: the version of the running gateway and the commit it
 * was built from — the same two stamps `/healthz` answers and telemetry
 * reports as `gateway_version` (`server/config/build-info.ts`). An unstamped
 * build (`next dev`, tests) says `dev`. Server component.
 */
import { buildInfoFromEnv, type BuildInfo } from '@/server/config/build-info';

import styles from './shell.module.css';

export function BuildFooter({ build = buildInfoFromEnv() }: { build?: BuildInfo }) {
  return (
    <footer className={styles.buildFooter} data-testid="build-footer">
      Vaubaan Gateway <span data-testid="gateway-version">{build.version}</span> ·{' '}
      <span data-testid="gateway-commit">{build.commit}</span>
    </footer>
  );
}

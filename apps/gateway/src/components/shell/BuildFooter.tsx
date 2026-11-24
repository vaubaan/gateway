/**
 * Footer of every page: the version of the running gateway and the commit it
 * was built from — the same two stamps `/healthz` answers and telemetry
 * reports as `gateway_version` (`server/config/build-info.ts`). An unstamped
 * build (`next dev`, tests) says `dev`. An instance in local mode adds that it
 * answers on this computer only. Server component.
 */
import { buildInfoFromEnv, type BuildInfo } from '@/server/config/build-info';
import { publishedLocalMode } from '@/server/http/local-mode';

import styles from './shell.styles';

export function BuildFooter({
  build = buildInfoFromEnv(),
  local = publishedLocalMode(),
}: {
  build?: BuildInfo;
  local?: boolean;
}) {
  return (
    <footer className={styles.buildFooter} data-testid="build-footer">
      Vaubaan Gateway <span data-testid="gateway-version">{build.version}</span> ·{' '}
      <span data-testid="gateway-commit">{build.commit}</span>
      {local ? (
        <>
          {' '}
          · <span data-testid="local-mode">Answers on this computer only</span>
        </>
      ) : null}
    </footer>
  );
}

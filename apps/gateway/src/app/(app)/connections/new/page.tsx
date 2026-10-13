/**
 * `/connections/new` — "Connect a provider": the providers a user can connect
 * right now, that is the registered plugins whose company app is configured
 * (or that need none). The list is the plugin registry's; nothing is
 * enumerated here.
 */
import Link from 'next/link';

import styles from '@/components/connections/connections.module.css';
import {
  credentialKindLabel,
  ExperimentalBadge,
  NoticeBanner,
} from '@/components/connections/parts';
import { Banner, Stack } from '@/components/ui';
import {
  firstParam,
  requireUser,
  takeNotice,
  type PageSearchParams,
} from '@/lib/connections/session';
import { CONNECTIONS_PATH, NEW_CONNECTION_PATH, PROVIDER_APPS_PAGE } from '@/server/connections';

export const dynamic = 'force-dynamic';

export default async function ConnectProviderPage({
  searchParams,
}: {
  searchParams: PageSearchParams;
}) {
  const params = await searchParams;
  const { root, principal } = await requireUser();
  const notice = await takeNotice(root, principal.sessionId, params);
  const providers = await root.connections.service.providers();
  const available = providers.filter((p) => p.configured);
  const unavailable = providers.filter((p) => !p.configured);
  const returnTo = firstParam(params.return_to);
  const suffix = returnTo ? `?return_to=${encodeURIComponent(returnTo)}` : '';

  return (
    <Stack gap="var(--space-6)">
      <div>
        <p className={styles.muted}>
          <Link href={CONNECTIONS_PATH}>Connections</Link> / Connect a provider
        </p>
        <h1>Connect a provider</h1>
        <p className={styles.muted}>
          You authenticate at the provider through the app your company registered; the credential
          comes back to this instance, is encrypted, and stays under your name.
        </p>
      </div>

      <NoticeBanner notice={notice} />

      {available.length === 0 ? (
        <Banner tone="warning" title="No provider can be connected yet">
          An operator must register the company app of at least one provider
          {principal.isOperator ? (
            <>
              {' '}
              — <Link href={PROVIDER_APPS_PAGE}>Administration → Provider apps</Link>.
            </>
          ) : (
            '.'
          )}
        </Banner>
      ) : (
        <ul className={styles.providerList}>
          {available.map((p) => (
            <li key={p.id}>
              <Link
                href={`${NEW_CONNECTION_PATH}/${encodeURIComponent(p.id)}${suffix}`}
                className={styles.providerCard}
              >
                <span className={styles.providerName}>
                  {p.displayName}
                  {p.experimental && <ExperimentalBadge />}
                </span>
                {p.description && <span className={styles.muted}>{p.description}</span>}
                <span className={styles.muted}>{credentialKindLabel(p.kind)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {unavailable.length > 0 && (
        <p className={styles.muted}>
          Not available yet (no company app registered):{' '}
          {unavailable.map((p) => p.displayName).join(', ')}.
          {principal.isOperator && (
            <>
              {' '}
              <Link href={PROVIDER_APPS_PAGE}>Register them in Administration → Provider apps</Link>
              .
            </>
          )}
        </p>
      )}
    </Stack>
  );
}

/**
 * `/providers/<id>` — the reference of one plugin (spec §4.2 "Providers"): a
 * compact header (what it is, in the plugin's own words, and three facts),
 * then the sections behind tabs (`provider-view.tsx`): presets compared side
 * by side, the risk catalog, the data model, the tools.
 *
 * Generated from the plugin registry (`server/providers/reference.ts`): no
 * provider has a hand-written page. Every risk and every preset has an anchor
 * (`#risk-<id>`, `#preset-<id>`) the other pages link to.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { credentialKindLabel, ExperimentalBadge } from '@/components/connections/parts';
import { ValidationBadge } from '@/components/telemetry/ValidationBadge';
import { Badge, Stack } from '@/components/ui';
import { requirePrincipal } from '@/lib/auth/session';
import { PROVIDERS_PATH } from '@/server/providers/links';
import { providerReference, type EnvironmentReference } from '@/server/providers/reference';

import styles from '../providers.module.css';
import { ProviderView } from './provider-view';

export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ id: string }>;
}

/** Where the environment of a call comes from, in a few words; the Data model tab says it in full. */
const ENVIRONMENT_SOURCE_WORDS: Readonly<Record<EnvironmentReference['source'], string>> = {
  call: 'Read from each call.',
  'resource-label': 'Set by the label of each resource.',
  none: 'None: every risk is accepted once.',
};

export default async function ProviderPage({ params }: Props) {
  const { root } = await requirePrincipal();
  const { id } = await params;
  const reference = providerReference(root.registry, id);
  if (!reference) notFound();
  const validation = await root.telemetry.stats.statusFor(reference.id);
  const { environment } = reference;

  return (
    <Stack gap="var(--space-5)">
      <header className={styles.head}>
        <p className={styles.crumbs}>
          <Link href={PROVIDERS_PATH}>Providers</Link> / {reference.name}
        </p>
        <div className={styles.titleRow}>
          <h1>{reference.name}</h1>
          <span className={styles.badges}>
            {reference.experimental && <ExperimentalBadge />}
            <ValidationBadge status={validation} />
          </span>
          <span className={styles.versions}>
            plugin {reference.version}
            {reference.catalog_version !== null && (
              <>
                {' '}
                · catalog v{reference.catalog_version}
                {reference.catalog_date ? ` · ${reference.catalog_date}` : ''}
              </>
            )}
            {reference.docs_url && (
              <>
                {' · '}
                <a href={reference.docs_url} className={styles.link} rel="noreferrer">
                  maintainer notes
                </a>
              </>
            )}
          </span>
        </div>
        <p className={styles.lead} data-testid="provider-summary">
          {reference.summary ?? reference.description ?? 'This plugin ships no description.'}
        </p>
        <dl className={styles.facts}>
          {reference.summary && reference.description && (
            <div>
              <dt>Connects to</dt>
              <dd>{reference.description}</dd>
            </div>
          )}
          <div>
            <dt>Credential</dt>
            <dd>
              {credentialKindLabel(reference.credential_kind)} — encrypted at rest, never shown
            </dd>
          </div>
          <div>
            <dt>Environments</dt>
            <dd>
              {environment.envs.length > 0 && (
                <span className={styles.factBadges}>
                  {environment.envs.map((env) => (
                    <Badge key={env} mono>
                      {env}
                    </Badge>
                  ))}
                </span>
              )}
              {ENVIRONMENT_SOURCE_WORDS[environment.source]}
            </dd>
          </div>
        </dl>
      </header>
      <ProviderView reference={reference} />
    </Stack>
  );
}

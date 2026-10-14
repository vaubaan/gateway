/**
 * `/reference/<id>` — the reference of one service (spec §4.2 "Providers"):
 * what it is in the plugin's own words, then its permissions compared across
 * its presets, its tools, and how it is modelled, behind tabs
 * (`service-view.tsx`).
 *
 * Generated from the plugin registry (`server/providers/reference.ts`): no
 * service has a hand-written page. Every permission and every preset has an
 * anchor (`#risk-<id>`, `#preset-<id>`) the other pages link to; the ids are
 * the protocol's and are printed as it spells them.
 */
import { notFound } from 'next/navigation';

import { credentialKindLabel } from '@/components/connections/parts';
import { ValidationBadge } from '@/components/telemetry/ValidationBadge';
import {
  Disclosure,
  EnvTag,
  KeyValue,
  Mono,
  PageHeader,
  ServiceMark,
  SummaryLine,
  Tag,
} from '@/components/ui';
import { requirePrincipal } from '@/lib/auth/session';
import { ACCOUNT_WORDS, ENVIRONMENT_WORDS } from '@/lib/vocabulary';
import { providerCards, providerReference } from '@/server/providers/reference';

import { catalogSize, ReferenceFrame } from '../frame';
import styles from '../reference.module.css';
import { ServiceView } from './service-view';

export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ id: string }>;
}

export default async function ServiceReferencePage({ params }: Props) {
  const { root } = await requirePrincipal();
  const { id } = await params;
  const reference = providerReference(root.registry, id);
  if (!reference) notFound();
  const validation = await root.telemetry.stats.statusFor(reference.id);
  const { environment } = reference;

  return (
    <ReferenceFrame cards={providerCards(root.registry)}>
      <PageHeader
        level={2}
        mark={<ServiceMark name={reference.name} size="lg" />}
        title={reference.name}
        status={reference.experimental ? <Tag>{ACCOUNT_WORDS.experimental}</Tag> : undefined}
        lede={
          <span data-testid="provider-summary">
            {reference.summary ?? reference.description ?? 'This service ships no description.'}
          </span>
        }
      />
      <div className={styles.facts}>
        <SummaryLine
          items={[
            { label: catalogSize(reference) },
            {
              label: `connects through: ${reference.credential_kinds.map(credentialKindLabel).join(' or ')}`,
            },
          ]}
        />
        <Disclosure
          id="reference:service-facts"
          show="About this service"
          hide="Hide what is said about this service"
          testId="service-facts"
        >
          <KeyValue
            items={[
              ...(reference.summary && reference.description
                ? [{ term: 'Connects to', value: reference.description }]
                : []),
              {
                term: 'Credential',
                value: `${reference.credential_kinds.map(credentialKindLabel).join(' or ')} · encrypted at rest, never shown`,
              },
              {
                term: 'Environments',
                value: (
                  <span className={styles.inline}>
                    {environment.envs.map((env) => (
                      <EnvTag key={env} env={env} />
                    ))}
                    {ENVIRONMENT_WORDS[environment.source]}
                  </span>
                ),
              },
              {
                term: 'Version',
                value: (
                  <span className={styles.inline}>
                    <Mono>{`plugin ${reference.version}`}</Mono>
                    {reference.catalog_version !== null && (
                      <Mono>
                        {`catalog v${reference.catalog_version}${
                          reference.catalog_date ? ` · ${reference.catalog_date}` : ''
                        }`}
                      </Mono>
                    )}
                    {reference.docs_url && (
                      <a href={reference.docs_url} rel="noreferrer">
                        maintainer notes
                      </a>
                    )}
                    <ValidationBadge status={validation} />
                  </span>
                ),
              },
            ]}
          />
        </Disclosure>
      </div>
      <ServiceView reference={reference} />
    </ReferenceFrame>
  );
}

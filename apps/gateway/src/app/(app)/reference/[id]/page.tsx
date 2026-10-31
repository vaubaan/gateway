/**
 * `/reference/<id>` — the reference of one service (spec §4.2 "Providers"):
 * what it is in the plugin's own words, then its permissions compared across
 * the trust levels, its tools, and how it is modelled, behind tabs
 * (`service-view.tsx`).
 *
 * Generated from the plugin registry (`server/providers/reference.ts`): no
 * service has a hand-written page. Every permission and every macro-action has
 * an anchor (`#risk-<id>`, `#macro-<id>`) the other pages link to; the ids are
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
  Section,
  ServiceMark,
  SummaryLine,
} from '@/components/ui';
import { requirePrincipal } from '@/lib/auth/session';
import { ENVIRONMENT_WORDS } from '@/lib/vocabulary';
import { gitRemoteBase } from '@/server/git/paths';
import { providerCards, providerReference } from '@/lib/providers/reference';

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
  const gitRemote = root.registry.get(reference.id)?.plugin.gitRemote;

  return (
    <ReferenceFrame cards={providerCards(root.registry)}>
      <PageHeader
        level={2}
        mark={<ServiceMark name={reference.name} icon={reference.icon} size="lg" />}
        title={reference.name}
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
              label: `connects through: ${credentialKindLabel(reference.credential_kind)}`,
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
                value: `${credentialKindLabel(reference.credential_kind)} · encrypted at rest, never shown`,
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
      {gitRemote && (
        <Section id="git" title="Git" testId="reference-git">
          <div className={styles.wrapAnywhere}>
            <p>
              This gateway is the git remote of the repositories a mission holds:{' '}
              <Mono>{`${gitRemoteBase(root.config.publicUrl)}<owner>/<repo>.git`}</Mono>, the
              mission key as the password. Clone and fetch are relayed to {reference.name} as they
              are; a push is decided ref by ref, every ref of it, like a call of the tool{' '}
              <Mono>{gitRemote.pushTool}</Mono>, and a clone or fetch like{' '}
              <Mono>{gitRemote.fetchTool}</Mono>.
            </p>
            <ul className={styles.gitAbilities} data-testid="reference-git-abilities">
              {(gitRemote.abilities ?? []).map((ability) => (
                <li key={ability.risk_id}>
                  {ability.words} — <Mono href={`#risk-${ability.risk_id}`}>{ability.risk_id}</Mono>
                </li>
              ))}
            </ul>
            <p className={styles.quiet}>
              The gateway decides on refs and changed paths, never on the content of the code: it
              does not read the pack. A push the provider cannot compare in full is refused; split
              it. Git LFS, signed pushes, push options and <Mono>--atomic</Mono> are not served.
            </p>
          </div>
        </Section>
      )}
    </ReferenceFrame>
  );
}

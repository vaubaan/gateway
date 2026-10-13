/**
 * `/providers/<id>` — the reference of one plugin (spec §4.2 "Providers"):
 * what it does in plain words, its data model as a tree, its risk catalog
 * entry by entry (label, reason, vector, environment scoping, what it
 * matches), its presets fully expanded, and its tools.
 *
 * Generated from the plugin registry (`server/providers/reference.ts`): no
 * provider has a hand-written page. Every risk and every preset has an anchor
 * (`#risk-<id>`, `#preset-<id>`) the other pages link to.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { credentialKindLabel, ExperimentalBadge } from '@/components/connections/parts';
import { GateBadge, SeverityBadge } from '@/components/risk/RiskBadges';
import {
  RiskIdLink,
  RiskMarkerNotes,
  RiskMarkers,
  VectorBadges,
  VectorLegend,
} from '@/components/risk/RiskExplain';
import { ValidationBadge } from '@/components/telemetry/ValidationBadge';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Stack,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
} from '@/components/ui';
import { requirePrincipal } from '@/lib/auth/session';
import {
  DEPRECATED_NOTE,
  FALLBACK_NOTE,
  formatRate,
  type RiskFamily,
} from '@/server/missions/catalog-view';
import {
  PROVIDERS_PATH,
  REFERENCE_SECTIONS,
  riskAnchor,
  riskReferencePath,
} from '@/server/providers/links';
import {
  CARDINALITY_WORDS,
  providerReference,
  TOKEN_HANDOUT_NOTE,
  TOOL_RISKS_NOTE,
  type EntityNode,
  type PresetLine,
  type PresetReference,
  type ProviderReference,
  type RiskReference,
} from '@/server/providers/reference';

import styles from '../providers.module.css';

export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ id: string }>;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export default async function ProviderPage({ params }: Props) {
  const { root } = await requirePrincipal();
  const { id } = await params;
  const reference = providerReference(root.registry, id);
  if (!reference) notFound();
  const validation = await root.telemetry.stats.statusFor(reference.id);
  const { counts } = reference;

  return (
    <Stack gap="var(--space-6)">
      <div>
        <p className={styles.muted}>
          <Link href={PROVIDERS_PATH}>Providers</Link> / {reference.name}
        </p>
        <h1>{reference.name}</h1>
        <span className={styles.badges}>
          {reference.experimental && <ExperimentalBadge />}
          <ValidationBadge status={validation} />
          <Badge mono>plugin {reference.version}</Badge>
          {reference.catalog_version !== null && (
            <Badge mono>
              catalog v{reference.catalog_version}
              {reference.catalog_date ? ` · ${reference.catalog_date}` : ''}
            </Badge>
          )}
        </span>
        <p className={styles.lead} data-testid="provider-summary">
          {reference.summary ?? reference.description ?? 'This plugin ships no description.'}
        </p>
        <dl className={styles.facts}>
          {reference.summary && reference.description && (
            <>
              <dt>Connects to</dt>
              <dd>{reference.description}</dd>
            </>
          )}
          <dt>Credential</dt>
          <dd>{credentialKindLabel(reference.credential_kind)} — encrypted at rest, never shown</dd>
          <dt>Size</dt>
          <dd>
            {plural(counts.risks, 'risk', 'risks')}
            {counts.risk_ids !== counts.risks &&
              ` (${counts.risk_ids} ids once each environment is counted)`}
            , {plural(counts.presets, 'preset', 'presets')}, {plural(counts.tools, 'tool', 'tools')}
          </dd>
          {reference.docs_url && (
            <>
              <dt>Maintainer notes</dt>
              <dd>
                <a href={reference.docs_url} className={styles.link} rel="noreferrer">
                  modelling handbook of the plugin
                </a>{' '}
                (source repository)
              </dd>
            </>
          )}
        </dl>
        <nav className={styles.toc} aria-label="On this page">
          <a href={`#${REFERENCE_SECTIONS.legend}`}>How to read a risk</a>
          <a href={`#${REFERENCE_SECTIONS.dataModel}`}>Data model</a>
          <a href={`#${REFERENCE_SECTIONS.risks}`}>Risk catalog ({counts.risks})</a>
          <a href={`#${REFERENCE_SECTIONS.presets}`}>Presets ({counts.presets})</a>
          <a href={`#${REFERENCE_SECTIONS.tools}`}>Tools ({counts.tools})</a>
        </nav>
      </div>

      <Card id={REFERENCE_SECTIONS.legend}>
        <CardHeader>
          <CardTitle>How to read a risk</CardTitle>
        </CardHeader>
        <CardBody>
          <Stack gap="var(--space-3)">
            <p className={styles.text}>
              A risk is one thing a human may accept for an agent: “open a pull request”, “write a
              production variable”. A mission lists the risks it accepts, each with a{' '}
              <strong>quota</strong> (actions per period), a <strong>rate limit</strong> and a{' '}
              <strong>gate</strong> (auto, or your approval for each action). A call that touches a
              risk the mission does not list is refused. Each risk carries six badges — its{' '}
              <em>vector</em>. They explain the risk and order the lists; nothing is decided from
              them.
            </p>
            <VectorLegend />
            <p className={styles.text}>
              A badge in a plain tone is the mildest value of its axis; a highlighted one is further
              up the scale; the text of the badge always says which. <strong>Account-scoped</strong>{' '}
              risks are accepted once. <strong>Environment-scoped</strong> risks are accepted
              separately in each environment they list, and can never be accepted in an environment
              they do not list.
            </p>
            <p className={styles.text}>
              <Badge tone="warning">fallback</Badge> {FALLBACK_NOTE.replace(/^Fallback: /, '')}
            </p>
            <p className={styles.text}>
              <Badge tone="warning">deprecated</Badge>{' '}
              {DEPRECATED_NOTE.replace(/^Deprecated: /, '')}
            </p>
          </Stack>
        </CardBody>
      </Card>

      <Card id={REFERENCE_SECTIONS.dataModel}>
        <CardHeader>
          <CardTitle>Data model</CardTitle>
        </CardHeader>
        <CardBody>
          <Stack gap="var(--space-4)">
            <p className={styles.text}>
              How the plugin pictures the provider: the things that exist there and how they nest.
              Every risk below is written over these entities. A resource of a connection is one of
              them, named by its ref; a mission selects resources, and a call names the resource it
              acts on.
            </p>
            <EnvironmentFacts reference={reference} />
            {reference.planes.map((plane) => (
              <section key={plane.slug} aria-label={`Plane ${plane.slug}`}>
                <h3 className={styles.planeTitle}>
                  Plane <code className={styles.mono}>{plane.slug}</code>{' '}
                  <span className={styles.muted}>
                    {plural(plane.entity_count, 'entity', 'entities')}
                  </span>
                </h3>
                {plane.description && <p className={styles.text}>{plane.description}</p>}
                <EntityTree nodes={plane.roots} />
              </section>
            ))}
            <p className={styles.muted}>
              Cardinalities:{' '}
              {Object.entries(CARDINALITY_WORDS)
                .map(([name, words]) => `${name} — ${words}`)
                .join('; ')}
              .
            </p>
          </Stack>
        </CardBody>
      </Card>

      <section id={REFERENCE_SECTIONS.risks} className={styles.section}>
        <h2>Risk catalog</h2>
        <p className={styles.text}>
          {plural(counts.risks, 'entry', 'entries')}, in the order: reads, writes, irreversible
          writes. An entry is touched when a call matches one of its patterns; a call may touch
          several, and a mission must accept all of them.
        </p>
        {reference.risk_groups.map((group) => (
          <section key={group.kind} aria-label={group.title} className={styles.group}>
            <h3 className={styles.groupTitle}>
              {group.title} <span className={styles.muted}>({group.entries.length})</span>{' '}
              <span className={styles.hint}>{group.hint}</span>
            </h3>
            <div className={styles.entries}>
              {group.entries.map((entry) => (
                <RiskEntryCard key={entry.base_id} entry={entry} />
              ))}
            </div>
          </section>
        ))}
      </section>

      <section id={REFERENCE_SECTIONS.presets} className={styles.section}>
        <h2>Presets</h2>
        <p className={styles.text}>
          A preset is a starting point shipped by the plugin: a list of risks with default quotas,
          rate limits and gates. Picking one never grants more than you hold on the connection, and
          the mission stores the resulting list, not the preset: a preset changed in a later version
          does not change an existing mission. Each preset is shown here against the whole catalog;
          at mission creation it is bounded by your authority and by the resources you select.
        </p>
        {reference.presets.map((preset) => (
          <PresetCard key={preset.id} preset={preset} />
        ))}
      </section>

      <Card id={REFERENCE_SECTIONS.tools}>
        <CardHeader>
          <CardTitle>Tools ({counts.tools})</CardTitle>
        </CardHeader>
        <CardBody>
          <Stack gap="var(--space-3)">
            <p className={styles.text}>
              What an agent can call through a mission that carries a {reference.name} connection.{' '}
              {TOOL_RISKS_NOTE}{' '}
              <a href={`#${REFERENCE_SECTIONS.risks}`} className={styles.link}>
                See the risk catalog
              </a>
              .
            </p>
            {reference.tools.some((tool) => tool.hands_token) && (
              <p className={styles.text} data-testid="token-handout-note">
                <Badge tone="danger">hands a token to the agent</Badge>{' '}
                {TOKEN_HANDOUT_NOTE.replace(/^Hands a token to the agent: /, '')}
              </p>
            )}
            {reference.experimental && (
              <p className={styles.text}>
                This plugin is experimental: it is kept out of the default connect and issuance
                flows, and its tools are not listed to agents.
              </p>
            )}
          </Stack>
        </CardBody>
        {reference.tools.length === 0 ? (
          <div className={styles.empty}>This plugin declares no tool.</div>
        ) : (
          <div className={styles.tableWrap}>
            <Table>
              <Thead>
                <Tr>
                  <Th>Tool</Th>
                  <Th>What it does</Th>
                  <Th>Arguments</Th>
                  <Th>Risks</Th>
                </Tr>
              </Thead>
              <Tbody>
                {reference.tools.map((tool) => (
                  <Tr key={tool.name}>
                    <Td>
                      <code className={styles.mono}>{tool.name}</code>
                    </Td>
                    <Td>{tool.description}</Td>
                    <Td>
                      {tool.required.length === 0 && tool.optional.length === 0 && (
                        <span className={styles.muted}>none</span>
                      )}
                      {tool.required.map((name) => (
                        <code key={name} className={styles.arg}>
                          {name}
                        </code>
                      ))}
                      {tool.optional.map((name) => (
                        <code key={name} className={`${styles.arg} ${styles.argOptional}`}>
                          {name}?
                        </code>
                      ))}
                    </Td>
                    <Td>
                      {tool.declared_risks === null ? (
                        <span className={styles.muted}>depends on the arguments</span>
                      ) : (
                        <>
                          {tool.hands_token && (
                            <div>
                              <Badge tone="danger">
                                <span title={TOKEN_HANDOUT_NOTE}>hands a token to the agent</span>
                              </Badge>
                            </div>
                          )}
                          {tool.declared_risks.map((riskId) => (
                            <div key={riskId}>
                              <RiskIdLink riskId={riskId} />
                            </div>
                          ))}
                        </>
                      )}
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          </div>
        )}
      </Card>
    </Stack>
  );
}

function EnvironmentFacts({ reference }: { reference: ProviderReference }) {
  const { environment } = reference;
  return (
    <dl className={styles.facts} data-testid="provider-environment">
      <dt>Environment</dt>
      <dd>{environment.explanation}</dd>
      {environment.envs.length > 0 && (
        <>
          <dt>Environments known</dt>
          <dd className={styles.badges}>
            {environment.envs.map((env) => (
              <Badge key={env} mono>
                {env}
              </Badge>
            ))}
          </dd>
        </>
      )}
      <dt>Carried by</dt>
      <dd>
        {environment.carriers.length === 0 ? (
          'no entity of the model'
        ) : (
          <>
            {environment.carriers.map((carrier) => (
              <code key={carrier} className={styles.arg}>
                {carrier}
              </code>
            ))}
            <span className={styles.muted}>
              {' '}
              (marked “carries the environment” below
              {environment.source === 'none' &&
                ' — in the model only: no risk of this catalog is environment-scoped'}
              )
            </span>
          </>
        )}
      </dd>
    </dl>
  );
}

function EntityTree({ nodes }: { nodes: readonly EntityNode[] }) {
  if (nodes.length === 0) return null;
  return (
    <ul className={styles.tree}>
      {nodes.map((node) => (
        <li key={node.name}>
          <div className={styles.entity}>
            <span className={styles.entityHead}>
              <code className={styles.entityName}>{node.name}</code>
              <span className={styles.muted}>{node.cardinalities.join(' · ')}</span>
              {node.carries_env && <Badge tone="info">carries the environment</Badge>}
            </span>
            <span className={styles.entityText}>{node.description}</span>
          </div>
          <EntityTree nodes={node.children} />
        </li>
      ))}
    </ul>
  );
}

function RiskEntryCard({ entry }: { entry: RiskReference }) {
  const [first] = entry.variants;
  return (
    <article id={entry.anchor} className={styles.entry} data-testid={entry.anchor}>
      <h4 className={styles.entryTitle}>
        {entry.label} <RiskMarkers fallback={entry.fallback} deprecated={entry.deprecated} />
        {entry.hands_token && (
          <Badge tone="danger">
            <span title={TOKEN_HANDOUT_NOTE}>hands a token to the agent</span>
          </Badge>
        )}
      </h4>
      <p className={styles.entryId}>
        <code className={styles.mono}>{entry.base_id}</code>{' '}
        <a href={`#${entry.anchor}`} className={styles.anchor} aria-label="Link to this risk">
          #
        </a>
      </p>
      <p className={styles.text}>{entry.reason}</p>
      <RiskMarkerNotes fallback={entry.fallback} deprecated={entry.deprecated} />
      {entry.hands_token && <p className={styles.handout}>{TOKEN_HANDOUT_NOTE}</p>}
      {entry.replaced_by && (
        <p className={styles.muted}>
          Replaced by{' '}
          <a href={riskReferencePath(entry.replaced_by) ?? '#'} className={styles.link}>
            <code className={styles.mono}>{entry.replaced_by}</code>
          </a>
          .
        </p>
      )}
      <dl className={styles.entryFacts}>
        <dt>Scope</dt>
        <dd>
          {entry.env_scoped ? (
            <>
              Environment-scoped — accepted separately in{' '}
              {entry.variants.map((risk) => (
                <code key={risk.risk_id} className={styles.arg}>
                  {risk.risk_id}
                </code>
              ))}
              . Refused on a resource of any other environment, or with no environment.
            </>
          ) : (
            'Account-scoped — accepted once, whatever the environment of the resource.'
          )}
        </dd>
        <dt>Profile</dt>
        <dd>
          {entry.vector_varies && entry.variants.length > 1 ? (
            <ul className={styles.variants}>
              {entry.variants.map((risk) => (
                <li key={risk.risk_id}>
                  <Badge mono>{risk.env ?? 'account'}</Badge>
                  <SeverityBadge level={risk.level} />
                  <VectorBadges vector={risk.vector} />
                </li>
              ))}
            </ul>
          ) : (
            first && (
              <span className={styles.badges}>
                <SeverityBadge level={first.level} />
                <VectorBadges vector={first.vector} />
              </span>
            )
          )}
        </dd>
        <dt>Matches</dt>
        <dd>
          <ul className={styles.patterns}>
            {entry.patterns.map(({ pattern, words }) => (
              <li key={pattern}>
                <span>{words}</span>
                <code className={styles.pattern}>{pattern}</code>
              </li>
            ))}
          </ul>
        </dd>
        {entry.rate_ceiling_per_minute !== null && (
          <>
            <dt>Ceiling</dt>
            <dd>
              At most {entry.rate_ceiling_per_minute} actions per minute, whatever a mission asks: a
              limit of the plugin that no mission can raise.
            </dd>
          </>
        )}
      </dl>
    </article>
  );
}

function PresetRows({ lines }: { lines: readonly PresetLine[] }) {
  return (
    <>
      {lines.map(({ risk, quota, rate_limit, gate }) => (
        <Tr key={risk.risk_id}>
          <Td>
            <a href={`#${riskAnchor(risk.base_id)}`} className={styles.link}>
              {risk.label}
            </a>
            <div className={styles.mono}>{risk.risk_id}</div>
          </Td>
          <Td>
            {risk.env ? <Badge mono>{risk.env}</Badge> : <span className={styles.muted}>—</span>}
          </Td>
          <Td>{quota}</Td>
          <Td>{formatRate(rate_limit)}</Td>
          <Td>
            <GateBadge gate={gate} />
          </Td>
        </Tr>
      ))}
    </>
  );
}

function NotIncluded({ families }: { families: readonly RiskFamily[] }) {
  if (families.length === 0) {
    return <p className={styles.text}>Not included: nothing — the preset covers the catalog.</p>;
  }
  return (
    <div data-testid="preset-not-included">
      <h4 className={styles.subTitle}>
        Not included <span className={styles.muted}>({families.length})</span>
      </h4>
      <ul className={styles.excluded}>
        {families.map((family) => {
          const envs = family.variants.flatMap((risk) => (risk.env === null ? [] : [risk.env]));
          return (
            <li key={family.base_id}>
              <a href={`#${riskAnchor(family.base_id)}`} className={styles.link}>
                {family.label}
              </a>
              {envs.map((env) => (
                <Badge key={env} mono>
                  {env}
                </Badge>
              ))}
              <RiskMarkers fallback={family.fallback} deprecated={family.deprecated} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function PresetCard({ preset }: { preset: PresetReference }) {
  const total = preset.auto.length + preset.approval.length;
  return (
    <Card id={preset.anchor} data-testid={preset.anchor} className={styles.preset}>
      <CardHeader>
        <CardTitle>
          {preset.label}{' '}
          <a href={`#${preset.anchor}`} className={styles.anchor} aria-label="Link to this preset">
            #
          </a>
        </CardTitle>
        <span className={styles.muted}>
          {plural(total, 'risk', 'risks')}
          {preset.approval.length > 0 && ` · ${preset.approval.length} under approval`} · id{' '}
          <code className={styles.mono}>{preset.id}</code>
        </span>
      </CardHeader>
      <CardBody>
        <p className={styles.text}>{preset.description}</p>
      </CardBody>
      <div className={styles.tableWrap}>
        <Table>
          <Thead>
            <Tr>
              <Th>Risk accepted</Th>
              <Th>Environment</Th>
              <Th>Quota per period</Th>
              <Th>Rate limit</Th>
              <Th>Gate</Th>
            </Tr>
          </Thead>
          <Tbody>
            <PresetRows lines={preset.auto} />
            <PresetRows lines={preset.approval} />
          </Tbody>
        </Table>
      </div>
      <CardBody>
        <NotIncluded families={preset.not_included} />
      </CardBody>
    </Card>
  );
}

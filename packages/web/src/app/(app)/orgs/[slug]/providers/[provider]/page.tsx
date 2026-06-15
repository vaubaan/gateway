/**
 * Provider info page — comprehensive, standardised documentation for one
 * provider exposed by the Vaubaan Gateway.
 *
 * Route   : `/orgs/[slug]/providers/[provider]`.
 * Spec    : docs/spec/gateway-risk-model.md §1, §2, §4.
 * Linked from : `/orgs/[slug]/providers` (the "Info" button on each card).
 *
 * The page is paramétré by the provider slug (`github`, `vercel`,
 * `supabase`, `railway`, `bash`). For each, it renders 5 sections :
 *  1. Header        — name + 1-line pitch.
 *  2. Data-model    — mermaid ER-style diagram auto-generated from the
 *                     provider package's `<provider>DataModel` export.
 *  3. Risk catalog  — every entry from `risk-catalog.yaml` with vector
 *                     mini-badges and the colorised `default_gate`.
 *  4. Tools mapping — every MCP tool exposed by the gateway.
 *  5. Setup         — how the provider is connected to Vaubaan (short),
 *                     with a link to the canonical YAML on GitHub.
 *
 * Catalog source : `getCatalog(provider)` (Next.js cache) reads the
 * YAML at build/boot — the page degrades gracefully if the catalog is
 * absent (warning banner + tools+data-model still shown).
 */

import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';

import type { RiskEntry, RiskGate, RiskVector } from '@vaubaan/shared';

import { getSupabaseServer } from '@/lib/supabase/server';
import { getCatalog } from '@/lib/risk-catalog/loader';
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Code,
  Row,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
} from '@/components/ui';
import { MermaidDiagram } from '@/components/providers/MermaidDiagram';
import { dataModelToMermaid } from '@/components/providers/data-model-to-mermaid';
import {
  PROVIDER_INFO,
  isProviderSlug,
  type ProviderInfo,
} from '@/components/providers/provider-info';

export const dynamic = 'force-dynamic';

const GITHUB_BLOB_BASE = 'https://github.com/sbw-vaubaan/vaubaan-gateway/blob/main/';

const GATE_TONE: Record<RiskGate, BadgeTone> = {
  allow: 'success',
  confirm: 'warning',
  deny: 'danger',
};

/** Sort key for risks : deny > confirm > allow > (fallbacks last by id). */
const GATE_ORDER: Record<RiskGate, number> = { deny: 0, confirm: 1, allow: 2 };

/** Narrow `string | readonly string[]` to a concrete string[] for rendering. */
function toMatchesArray(matches: string | readonly string[]): readonly string[] {
  return typeof matches === 'string' ? [matches] : matches;
}

export default async function ProviderInfoPage({
  params,
}: {
  params: Promise<{ slug: string; provider: string }>;
}) {
  const { slug, provider } = await params;

  if (!isProviderSlug(provider)) notFound();
  const info = PROVIDER_INFO[provider];

  const supabase = await getSupabaseServer();
  const { data: user } = await supabase.auth.getUser();
  if (!user.user) redirect('/login');

  const { data: org } = await supabase
    .from('organizations')
    .select('id, name, slug')
    .eq('slug', slug)
    .maybeSingle<{ id: string; name: string; slug: string }>();
  if (!org) notFound();

  const catalog = getCatalog(provider);
  const entries: RiskEntry[] = catalog ? catalog.entries.map((e) => e.entry) : [];
  // Sort entries by gate severity (deny first), then by id (catalog order is
  // already meaningful but we want deny entries pinned to the top so the
  // reviewer's eye lands there).
  const sortedEntries = [...entries].sort((a, b) => {
    const gateDiff = GATE_ORDER[a.default_gate] - GATE_ORDER[b.default_gate];
    if (gateDiff !== 0) return gateDiff;
    return a.id.localeCompare(b.id);
  });

  const mermaidSource = dataModelToMermaid(info.dataModel);
  const yamlGithubUrl = `${GITHUB_BLOB_BASE}${info.catalogPath}`;
  const handbookGithubUrl = `${GITHUB_BLOB_BASE}${info.handbook}`;

  return (
    <main>
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          marginBottom: 'var(--space-6)',
          flexWrap: 'wrap',
          gap: 'var(--space-3)',
        }}
      >
        <div>
          <Row gap="var(--space-3)">
            <h1 style={{ margin: 0 }}>{info.label}</h1>
            <Badge tone={info.kind === 'host' ? 'info' : 'neutral'}>{info.kind}</Badge>
          </Row>
          <p
            style={{
              margin: 'var(--space-2) 0 0',
              color: 'var(--text-muted)',
              fontSize: 'var(--text-sm)',
            }}
          >
            {info.pitch}
          </p>
        </div>
        <Link href={`/orgs/${org.slug}/providers`} style={{ color: 'var(--text-muted)' }}>
          ← all providers
        </Link>
      </header>

      <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
        <DataModelCard info={info} mermaidSource={mermaidSource} />
        <RiskCatalogCard
          info={info}
          entries={sortedEntries}
          catalogLoaded={catalog !== undefined}
        />
        <ToolsMappingCard info={info} entries={sortedEntries} />
        <SetupCard
          info={info}
          yamlGithubUrl={yamlGithubUrl}
          handbookGithubUrl={handbookGithubUrl}
        />
      </div>
    </main>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 2 — data-model diagram
// ─────────────────────────────────────────────────────────────────────────────

function DataModelCard({ info, mermaidSource }: { info: ProviderInfo; mermaidSource: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Data model</CardTitle>
        <Badge tone="neutral">
          {info.dataModel.planes.length} plane{info.dataModel.planes.length === 1 ? '' : 's'}
        </Badge>
      </CardHeader>
      <CardBody>
        <p
          style={{
            margin: '0 0 var(--space-3)',
            color: 'var(--text-muted)',
            fontSize: 'var(--text-sm)',
          }}
        >
          The declarative entity graph used by the policy engine. Every catalog pattern targets
          entities declared here ; a CI lint forbids unknown names. Cardinality glyphs :{' '}
          <Code>1</Code> = exactly one, <Code>N</Code> = bounded list, <Code>*</Code> = unbounded.
        </p>
        <MermaidDiagram source={mermaidSource} />
        <details style={{ marginTop: 'var(--space-3)' }}>
          <summary
            style={{
              cursor: 'pointer',
              fontSize: 'var(--text-sm)',
              color: 'var(--text-muted)',
            }}
          >
            Plane descriptions ({info.dataModel.planes.length})
          </summary>
          <ul
            style={{
              listStyle: 'none',
              padding: 0,
              margin: 'var(--space-3) 0 0',
              display: 'grid',
              gap: 'var(--space-3)',
            }}
          >
            {info.dataModel.planes.map((plane) => (
              <li key={plane.slug}>
                <Row gap="var(--space-2)">
                  <strong>plane:</strong>
                  <Code>{plane.slug}</Code>
                </Row>
                {plane.description && (
                  <p
                    style={{
                      margin: 'var(--space-1) 0 0',
                      color: 'var(--text-muted)',
                      fontSize: 'var(--text-sm)',
                    }}
                  >
                    {plane.description}
                  </p>
                )}
                <ul
                  style={{
                    listStyle: 'none',
                    padding: 0,
                    margin: 'var(--space-2) 0 0 var(--space-3)',
                    fontSize: 'var(--text-sm)',
                    color: 'var(--text-muted)',
                  }}
                >
                  {plane.entities.map((entity) => (
                    <li key={`${plane.slug}-${entity.name}`} style={{ marginBottom: 4 }}>
                      <Code>{entity.name}</Code>
                      <span style={{ color: 'var(--text-subtle)' }}> — {entity.description}</span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </details>
      </CardBody>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 3 — risk catalog table
// ─────────────────────────────────────────────────────────────────────────────

function RiskCatalogCard({
  info,
  entries,
  catalogLoaded,
}: {
  info: ProviderInfo;
  entries: readonly RiskEntry[];
  catalogLoaded: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Risk catalog</CardTitle>
        <Row gap="var(--space-2)">
          <Badge tone="neutral">{entries.length} entries</Badge>
          <Badge tone={catalogLoaded ? 'success' : 'danger'}>
            {catalogLoaded ? 'loaded' : 'not loaded'}
          </Badge>
        </Row>
      </CardHeader>
      <CardBody>
        {!catalogLoaded ? (
          <p style={{ color: 'var(--accent-danger-fg)', margin: 0 }}>
            Catalog could not be loaded — the page falls back to the data-model and tools sections.
            Check that <Code>{info.catalogPath}</Code> is present and valid.
          </p>
        ) : entries.length === 0 ? (
          <p style={{ color: 'var(--text-subtle)', margin: 0 }}>No entries declared.</p>
        ) : (
          <>
            <p
              style={{
                margin: '0 0 var(--space-3)',
                color: 'var(--text-muted)',
                fontSize: 'var(--text-sm)',
              }}
            >
              Each entry maps a slice pattern (= a path on the data model + an action) to a default
              gate (<Badge tone="success">allow</Badge> <Badge tone="warning">confirm</Badge>{' '}
              <Badge tone="danger">deny</Badge>) and a 6D vector (reversibility · blast · data ·
              cost · visibility · persistence).
            </p>
            <Table>
              <Thead>
                <Tr>
                  <Th>Risk</Th>
                  <Th>Gate</Th>
                  <Th>Why</Th>
                  <Th>Vector</Th>
                  <Th>Env scope</Th>
                </Tr>
              </Thead>
              <Tbody>
                {entries.map((entry) => (
                  <Tr key={entry.id}>
                    <Td style={{ verticalAlign: 'top' }}>
                      <div>
                        <Code>{entry.id}</Code>
                      </div>
                      <div
                        style={{
                          marginTop: 2,
                          fontSize: 'var(--text-xs)',
                          color: 'var(--text-muted)',
                        }}
                      >
                        {entry.label}
                      </div>
                      {entry.deprecated && (
                        <div style={{ marginTop: 4 }}>
                          <Badge tone="danger">deprecated</Badge>
                          {entry.replaced_by && (
                            <span
                              style={{
                                marginLeft: 6,
                                fontSize: 'var(--text-xs)',
                                color: 'var(--text-muted)',
                              }}
                            >
                              → <Code>{entry.replaced_by}</Code>
                            </span>
                          )}
                        </div>
                      )}
                    </Td>
                    <Td style={{ verticalAlign: 'top' }}>
                      <Badge tone={GATE_TONE[entry.default_gate]}>{entry.default_gate}</Badge>
                    </Td>
                    <Td
                      style={{
                        verticalAlign: 'top',
                        fontSize: 'var(--text-sm)',
                        color: 'var(--text-muted)',
                        maxWidth: 360,
                      }}
                    >
                      {entry.reason}
                    </Td>
                    <Td style={{ verticalAlign: 'top' }}>
                      <VectorBadges vector={entry.vector} />
                      <details style={{ marginTop: 6 }}>
                        <summary
                          style={{
                            cursor: 'pointer',
                            fontSize: 'var(--text-xs)',
                            color: 'var(--text-subtle)',
                          }}
                        >
                          slice patterns
                        </summary>
                        <ul
                          style={{
                            listStyle: 'none',
                            padding: 0,
                            margin: '4px 0 0',
                            fontSize: 'var(--text-xs)',
                            color: 'var(--text-muted)',
                          }}
                        >
                          {toMatchesArray(entry.matches).map((m) => (
                            <li key={m} style={{ marginBottom: 2 }}>
                              <Code>{m}</Code>
                            </li>
                          ))}
                        </ul>
                      </details>
                    </Td>
                    <Td style={{ verticalAlign: 'top', fontSize: 'var(--text-xs)' }}>
                      {entry.acceptable_in_envs && entry.acceptable_in_envs.length > 0 ? (
                        <Row gap="4px">
                          {entry.acceptable_in_envs.map((e) => (
                            <Badge key={e} tone="info">
                              {e}
                            </Badge>
                          ))}
                        </Row>
                      ) : (
                        <span style={{ color: 'var(--text-subtle)' }}>any</span>
                      )}
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          </>
        )}
      </CardBody>
    </Card>
  );
}

// 6D vector → mini-badges row.
function VectorBadges({ vector }: { vector: RiskVector }) {
  const axes: Array<{ key: string; value: string; tone: BadgeTone }> = [
    { key: 'rev', value: vector.reversibility, tone: reversibilityTone(vector.reversibility) },
    { key: 'blast', value: vector.blast, tone: blastTone(vector.blast) },
    { key: 'data', value: vector.data, tone: dataTone(vector.data) },
    { key: 'cost', value: vector.cost, tone: costTone(vector.cost) },
    { key: 'vis', value: vector.visibility, tone: visibilityTone(vector.visibility) },
    { key: 'pers', value: vector.persistence, tone: persistenceTone(vector.persistence) },
  ];
  return (
    <Row gap="4px">
      {axes.map((axis) => (
        <Badge key={axis.key} tone={axis.tone}>
          <span style={{ opacity: 0.6, fontSize: '0.85em' }}>{axis.key}:</span> {axis.value}
        </Badge>
      ))}
    </Row>
  );
}

function reversibilityTone(v: RiskVector['reversibility']): BadgeTone {
  if (v === 'reversible') return 'success';
  if (v === 'costly') return 'warning';
  return 'danger';
}
function blastTone(v: RiskVector['blast']): BadgeTone {
  if (v === 'single') return 'success';
  if (v === 'env') return 'info';
  if (v === 'account') return 'warning';
  return 'danger';
}
function dataTone(v: RiskVector['data']): BadgeTone {
  if (v === 'metadata') return 'neutral';
  if (v === 'data') return 'info';
  if (v === 'secret' || v === 'pii') return 'danger';
  return 'neutral';
}
function costTone(v: RiskVector['cost']): BadgeTone {
  if (v === 'free') return 'success';
  if (v === 'moderate') return 'warning';
  return 'danger';
}
function visibilityTone(v: RiskVector['visibility']): BadgeTone {
  if (v === 'internal') return 'success';
  if (v === 'team') return 'info';
  return 'danger';
}
function persistenceTone(v: RiskVector['persistence']): BadgeTone {
  if (v === 'stateless') return 'success';
  if (v === 'session') return 'info';
  return 'warning';
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 4 — tools mapping
// ─────────────────────────────────────────────────────────────────────────────

function ToolsMappingCard({
  info,
  entries,
}: {
  info: ProviderInfo;
  entries: readonly RiskEntry[];
}) {
  const writeRisks = entries.filter((e) => e.default_gate !== 'allow').length;
  return (
    <Card>
      <CardHeader>
        <CardTitle>MCP tools</CardTitle>
        <Badge tone="neutral">{info.tools.length}</Badge>
      </CardHeader>
      <CardBody>
        <p
          style={{
            margin: '0 0 var(--space-3)',
            color: 'var(--text-muted)',
            fontSize: 'var(--text-sm)',
          }}
        >
          Tools the gateway exposes for this provider. At call time, the classifier emits one or
          more slices ; the catalog intersects those slices with the {entries.length} entries above
          ({writeRisks} require confirmation or are denied by default). For <Code>{info.slug}</Code>
          , the R/W distinction lives at{' '}
          {info.slug === 'bash' ? (
            <>
              the policy layer — every call goes through <Code>ssh__exec</Code> ; a regex whitelist
              (<Code>isReadAllowed</Code>) decides R vs W on the command string.
            </>
          ) : (
            <>
              the classifier (<Code>risk-classifier.ts</Code>).
            </>
          )}
        </p>
        <Table>
          <Thead>
            <Tr>
              <Th>Tool</Th>
              <Th>Required args</Th>
              <Th>Description</Th>
            </Tr>
          </Thead>
          <Tbody>
            {info.tools.map((tool) => (
              <Tr key={tool.name}>
                <Td style={{ verticalAlign: 'top' }}>
                  <Code>{tool.name}</Code>
                </Td>
                <Td
                  style={{
                    verticalAlign: 'top',
                    fontSize: 'var(--text-xs)',
                    color: 'var(--text-muted)',
                  }}
                >
                  {(tool.inputSchema.required ?? []).length === 0 ? (
                    <span style={{ color: 'var(--text-subtle)' }}>—</span>
                  ) : (
                    <Row gap="4px">
                      {(tool.inputSchema.required ?? []).map((arg) => (
                        <Code key={arg}>{arg}</Code>
                      ))}
                    </Row>
                  )}
                </Td>
                <Td
                  style={{
                    verticalAlign: 'top',
                    fontSize: 'var(--text-sm)',
                    color: 'var(--text-muted)',
                  }}
                >
                  {tool.description}
                </Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      </CardBody>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 5 — setup / external links
// ─────────────────────────────────────────────────────────────────────────────

function SetupCard({
  info,
  yamlGithubUrl,
  handbookGithubUrl,
}: {
  info: ProviderInfo;
  yamlGithubUrl: string;
  handbookGithubUrl: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Setup &amp; source</CardTitle>
      </CardHeader>
      <CardBody>
        <p style={{ margin: '0 0 var(--space-3)', fontSize: 'var(--text-sm)' }}>{info.setup}</p>
        <Row gap="var(--space-2)">
          <a href={yamlGithubUrl} target="_blank" rel="noreferrer noopener">
            <Button size="sm" variant="secondary">
              View catalog YAML
            </Button>
          </a>
          <a href={handbookGithubUrl} target="_blank" rel="noreferrer noopener">
            <Button size="sm" variant="secondary">
              Provider handbook
            </Button>
          </a>
        </Row>
      </CardBody>
    </Card>
  );
}

/**
 * The 4 reusable info sections for a provider (data-model, risk catalog,
 * MCP tools, setup) — extracted from the original
 * `/orgs/[slug]/providers/[provider]/page.tsx` so the per-plane subpage
 * (`/orgs/[slug]/providers/[provider]/[plane]/page.tsx`) can reuse them
 * with plane-filtered data.
 *
 * The sections themselves are server components (no client hooks). The
 * mermaid diagram inside `DataModelCard` is the only client island — it
 * mounts as `<MermaidDiagram>` (use client) and renders the SVG after
 * hydration.
 */

import type { McpToolDeclaration, RiskEntry, RiskGate, RiskVector } from '@vaubaan/shared';

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
import {
  renderDataModelMermaid,
  type EntityBindingKind,
} from '@/components/providers/data-model-to-mermaid';
import type { ProviderInfo, PlaneInfo } from '@/components/providers/provider-info';

const GATE_TONE: Record<RiskGate, BadgeTone> = {
  allow: 'success',
  confirm: 'warning',
  deny: 'danger',
};

/** Narrow `string | readonly string[]` to a concrete string[] for rendering. */
function toMatchesArray(matches: string | readonly string[]): readonly string[] {
  return typeof matches === 'string' ? [matches] : matches;
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 2 — data-model diagram
// ─────────────────────────────────────────────────────────────────────────────

export function DataModelCard({
  info,
  plane,
}: {
  info: ProviderInfo;
  /** When provided, render only this plane ; otherwise render all planes. */
  plane?: PlaneInfo;
}) {
  const { source, highlights } = renderDataModelMermaid(info.dataModel, {
    planeSlug: plane?.slug,
  });
  const planeCount = plane ? 1 : info.dataModel.planes.length;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Data model</CardTitle>
        <Badge tone="neutral">
          {plane ? `plane: ${plane.slug}` : `${planeCount} plane${planeCount === 1 ? '' : 's'}`}
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
          Declarative entity graph used by the policy engine — every catalog pattern targets
          entities declared here. Cardinalities sit on the relationship edges (
          <Code>||--o&#123;</Code> = one-to-many, <Code>||--||</Code> = one-to-one).
        </p>
        <BindingLegend highlights={highlights} />
        <MermaidDiagram source={source} />
        <details style={{ marginTop: 'var(--space-3)' }}>
          <summary
            style={{
              cursor: 'pointer',
              fontSize: 'var(--text-sm)',
              color: 'var(--text-muted)',
            }}
          >
            Plane descriptions ({planeCount})
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
            {info.dataModel.planes
              .filter((p) => !plane || p.slug === plane.slug)
              .map((p) => (
                <li key={p.slug}>
                  <Row gap="var(--space-2)">
                    <strong>plane:</strong>
                    <Code>{p.slug}</Code>
                  </Row>
                  {p.description && (
                    <p
                      style={{
                        margin: 'var(--space-1) 0 0',
                        color: 'var(--text-muted)',
                        fontSize: 'var(--text-sm)',
                      }}
                    >
                      {p.description}
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
                    {p.entities.map((entity) => (
                      <li key={`${p.slug}-${entity.name}`} style={{ marginBottom: 4 }}>
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

/**
 * Render a small legend explaining the two binding-anchor highlights
 * (ORG / PROJECT). Shown as an OUT-OF-BAND legend — mermaid's ER `classDef`
 * support is patchy across themes, so the legend is the canonical visual
 * cue (the diagram styling is just a bonus).
 */
function BindingLegend({ highlights }: { highlights: ReadonlyMap<string, EntityBindingKind> }) {
  const hasOrg = Array.from(highlights.values()).includes('org');
  const hasProject = Array.from(highlights.values()).includes('project');
  if (!hasOrg && !hasProject) return null;
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 'var(--space-3)',
        marginBottom: 'var(--space-3)',
        padding: 'var(--space-2) var(--space-3)',
        background: '#f9fafb',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-md)',
        fontSize: 'var(--text-xs)',
      }}
    >
      {hasOrg && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span
            style={{
              display: 'inline-block',
              width: 14,
              height: 14,
              background: '#fef3c7',
              border: '2px solid #d97706',
              borderRadius: 3,
            }}
          />
          <strong>Vaubaan ORG binding</strong>
          <span style={{ color: 'var(--text-muted)' }}>(provider_admins)</span>
        </span>
      )}
      {hasProject && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span
            style={{
              display: 'inline-block',
              width: 14,
              height: 14,
              background: '#dbeafe',
              border: '2px solid #2563eb',
              borderRadius: 3,
            }}
          />
          <strong>Vaubaan PROJECT binding</strong>
          <span style={{ color: 'var(--text-muted)' }}>(provider_bindings)</span>
        </span>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 3 — risk catalog table
// ─────────────────────────────────────────────────────────────────────────────

export function RiskCatalogCard({
  info,
  entries,
  catalogLoaded,
}: {
  info: ProviderInfo;
  entries: readonly RiskEntry[];
  catalogLoaded: boolean;
}) {
  return (
    <Card className="vbn-card-flush">
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
            <ScrollableTable>
              <Table style={{ minWidth: 880 }}>
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
                          minWidth: 280,
                          maxWidth: 420,
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
            </ScrollableTable>
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

export function ToolsMappingCard({
  info,
  tools,
  entries,
}: {
  info: ProviderInfo;
  /** Tools filtered to the current plane (or all tools for single-plane providers). */
  tools: ReadonlyArray<McpToolDeclaration>;
  entries: readonly RiskEntry[];
}) {
  const writeRisks = entries.filter((e) => e.default_gate !== 'allow').length;
  return (
    <Card className="vbn-card-flush">
      <CardHeader>
        <CardTitle>MCP tools</CardTitle>
        <Badge tone="neutral">{tools.length}</Badge>
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
        <ScrollableTable>
          <Table style={{ minWidth: 700 }}>
            <Thead>
              <Tr>
                <Th>Tool</Th>
                <Th>Required args</Th>
                <Th>Description</Th>
              </Tr>
            </Thead>
            <Tbody>
              {tools.map((tool) => (
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
        </ScrollableTable>
      </CardBody>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 5 — setup / external links
// ─────────────────────────────────────────────────────────────────────────────

export function SetupCard({
  setupText,
  yamlGithubUrl,
  handbookGithubUrl,
}: {
  setupText: string;
  yamlGithubUrl: string;
  handbookGithubUrl: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Setup &amp; source</CardTitle>
      </CardHeader>
      <CardBody>
        <p style={{ margin: '0 0 var(--space-3)', fontSize: 'var(--text-sm)' }}>{setupText}</p>
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

// ─────────────────────────────────────────────────────────────────────────────
// ScrollableTable — wrapper that lets a wide table scroll horizontally
// WITHOUT clipping the last column. Wraps the table in a div with
// `overflow-x: auto` and explicit `width: 100%`, so the scrollbar appears
// only when the table outgrows the viewport.
// ─────────────────────────────────────────────────────────────────────────────

function ScrollableTable({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        width: '100%',
        overflowX: 'auto',
        WebkitOverflowScrolling: 'touch',
      }}
    >
      {children}
    </div>
  );
}

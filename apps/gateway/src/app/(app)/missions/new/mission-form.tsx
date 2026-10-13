'use client';

/**
 * The one-page mission creation screen (spec §4.2, §7.4), in this order:
 * name → connections and, within each, resources (all by default, folded) →
 * one preset per connection (or duplicate a mission, or paste an agent's
 * proposal) → a three-line summary → per-risk detail folded by default →
 * period and expiry → issue. The decision shown here is `previewDraft`, the
 * function the server runs again at issuance; the browser's copy only saves
 * a round trip.
 */
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

import { Badge, Banner, Button, Input, Select, Textarea } from '@/components/ui';
import type { BootstrapKit } from '@/server/missions/bootstrap-kit';
import { describePresetWidth, presetWidth } from '@/server/missions/catalog-view';
import type {
  DraftPeriod,
  IssuanceConnection,
  MissionPreview,
  PreviewIssue,
  ResolvedDraftConnection,
} from '@/server/missions/model';
import { defaultResources, previewDraft } from '@/server/missions/preview';

import { RevealDialog } from '../bootstrap-kit-view';
import styles from '../missions.module.css';
import {
  applyPreset,
  availableCount,
  describeSkipped,
  draftOf,
  EXPIRY_CHOICES,
  initialFormState,
  loadResolved,
  PERIOD_CHOICES,
  periodChoiceOf,
  periodOf,
  presetSkipped,
  setIncluded,
  setResources,
  type ConnectionState,
  type ExpiryChoice,
  type FormState,
  type PeriodChoice,
} from './form-state';
import { RiskDetail } from './risk-detail';

export interface InitialDraft {
  readonly name: string;
  readonly period: DraftPeriod;
  readonly resolved: readonly ResolvedDraftConnection[];
  /** What could not be carried over from the source (a risk no longer held, a vanished resource). */
  readonly issues: readonly PreviewIssue[];
  readonly sourceName: string;
}

interface Issued {
  readonly missionId: string;
  readonly name: string;
  readonly kit: BootstrapKit;
}

function isChoice<T extends string>(choices: readonly { id: T }[], raw: string): raw is T {
  return choices.some((c) => c.id === raw);
}

function startState(
  context: readonly IssuanceConnection[],
  initial: InitialDraft | null,
): FormState {
  const blank = initialFormState(context);
  // A single usable connection is the obvious one: include it up front.
  const usable = context.filter((c) => !c.experimental);
  const [only] = usable;
  const onlyState = only ? blank.connections[only.id] : undefined;
  const base: FormState =
    usable.length === 1 && only && onlyState
      ? { ...blank, connections: { ...blank.connections, [only.id]: setIncluded(onlyState, true) } }
      : blank;
  if (!initial) return base;
  return {
    ...loadResolved(context, blank, initial.resolved),
    name: initial.name,
    period: periodChoiceOf(initial.period),
  };
}

const EMPTY: ConnectionState = {
  included: false,
  resourceIds: [],
  presetId: '',
  entries: {},
  edited: false,
};

export function MissionForm({
  context,
  missions,
  initial,
}: {
  context: readonly IssuanceConnection[];
  missions: readonly { id: string; name: string }[];
  initial: InitialDraft | null;
}) {
  const router = useRouter();
  const [state, setState] = useState<FormState>(() => startState(context, initial));
  const [openResources, setOpenResources] = useState<ReadonlySet<string>>(new Set());
  const [now] = useState(() => new Date());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverIssues, setServerIssues] = useState<readonly PreviewIssue[]>([]);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [proposalOpen, setProposalOpen] = useState(false);
  const [proposalText, setProposalText] = useState('');
  const [proposalReport, setProposalReport] = useState<MissionPreview | null>(null);

  const hasExperimental = context.some((c) => c.experimental);
  const visible = context.filter((c) => state.showExperimental || !c.experimental);
  const included = visible.filter((c) => state.connections[c.id]?.included);
  const preview = useMemo(
    () => previewDraft({ connections: context, now }, draftOf(context, state, now)),
    [context, state, now],
  );
  const issues = serverIssues.length > 0 ? serverIssues : preview.issues;

  function patch(next: Partial<FormState>) {
    setServerIssues([]);
    setState((s) => ({ ...s, ...next }));
  }
  function patchConnection(id: string, next: ConnectionState) {
    setServerIssues([]);
    setState((s) => ({ ...s, connections: { ...s.connections, [id]: next } }));
  }
  function toggleResources(id: string) {
    setOpenResources((open) => {
      const next = new Set(open);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function issue() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/missions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draftOf(context, state, new Date())),
      });
      const body: unknown = await res.json().catch(() => null);
      if (res.status === 201 && isIssuedBody(body)) {
        setIssued({ missionId: body.mission.id, name: body.mission.name, kit: body.kit });
      } else if (res.status === 422 && isRefusedBody(body)) {
        setServerIssues(body.preview.issues);
      } else {
        setError(messageOf(body) ?? `The instance answered ${res.status}.`);
      }
    } catch {
      setError('The instance could not be reached.');
    } finally {
      setBusy(false);
    }
  }

  async function checkProposal() {
    setError(null);
    setProposalReport(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(proposalText);
    } catch {
      setError('The proposal is not valid JSON.');
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      setError('The proposal must be a JSON object with a "connections" list.');
      return;
    }
    const proposal = parsed as Record<string, unknown>;
    // A proposal may be a whole draft or only its connections: the rest comes from the form.
    const draft = {
      name: typeof proposal.name === 'string' ? proposal.name : state.name,
      connections: proposal.connections ?? [],
      period: proposal.period ?? periodOf(state.period),
      expires_at: proposal.expires_at ?? null,
    };
    setBusy(true);
    try {
      const res = await fetch('/api/missions/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      });
      const body: unknown = await res.json().catch(() => null);
      if (res.ok && isPreviewBody(body)) {
        const loaded = loadResolved(context, initialFormState(context), body.preview.resolved);
        setState({
          ...loaded,
          name: body.preview.name || state.name,
          period: periodChoiceOf(body.preview.period),
          expiry: body.preview.expires_at ? 'custom' : 'never',
          expiryCustom: body.preview.expires_at ? toLocalInput(body.preview.expires_at) : '',
        });
        setServerIssues([]);
        setProposalReport(body.preview);
      } else {
        setError(messageOf(body) ?? `The instance answered ${res.status}.`);
      }
    } catch {
      setError('The instance could not be reached.');
    } finally {
      setBusy(false);
    }
  }

  if (context.length === 0) {
    return (
      <Banner tone="info" title="No connection yet">
        A mission is issued on connections you own. Connect a provider under{' '}
        <a href="/connections">Connections</a>, then come back.
      </Banner>
    );
  }

  return (
    <>
      {initial && (
        <Banner
          tone={initial.issues.length > 0 ? 'warning' : 'info'}
          title={`Duplicating “${initial.sourceName}”`}
        >
          Same connections, resources, risks and budgets; it gets its own token and its own budget.
          {initial.issues.length > 0 && (
            <ul className={styles.issues}>
              {initial.issues.map((i) => (
                <li key={i.message}>{i.message}</li>
              ))}
            </ul>
          )}
        </Banner>
      )}

      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          void issue();
        }}
      >
        <section>
          <h2 className={styles.step}>1 · Name</h2>
          <div className={styles.nameRow}>
            <Input
              value={state.name}
              onChange={(e) => patch({ name: e.target.value })}
              placeholder="What is this mission for? e.g. Ship the billing page"
              aria-label="Mission name"
              maxLength={120}
              autoFocus
            />
            {missions.length > 0 && (
              <Select
                value=""
                aria-label="Duplicate from a mission"
                onChange={(e) => {
                  if (e.target.value) router.push(`/missions/new?from=${e.target.value}`);
                }}
              >
                <option value="">Duplicate from…</option>
                {missions.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </Select>
            )}
            <Button type="button" size="sm" onClick={() => setProposalOpen((o) => !o)}>
              Paste an agent’s proposal
            </Button>
          </div>
          {proposalOpen && (
            <div className={styles.proposal}>
              <Textarea
                value={proposalText}
                onChange={(e) => setProposalText(e.target.value)}
                aria-label="Agent proposal (JSON)"
                placeholder='{"connections":[{"provider":"github","preset":"developer","resources":{"scope":"selected","resource_refs":["acme/app"]}}]}'
                spellCheck={false}
              />
              <div className={styles.actions}>
                <Button
                  type="button"
                  size="sm"
                  onClick={checkProposal}
                  disabled={busy || proposalText.trim() === ''}
                >
                  Check and load
                </Button>
                <span className={styles.muted}>
                  Nothing is issued: what passes your authority fills the form, the rest is listed.
                </span>
              </div>
              {proposalReport && (
                <Banner
                  tone={proposalReport.ok ? 'success' : 'warning'}
                  title={`Loaded ${proposalReport.policy.length} risks on ${proposalReport.connections.length} connections`}
                >
                  {proposalReport.issues.length === 0 ? (
                    'Everything the proposal asks for is within your authority.'
                  ) : (
                    <ul className={styles.issues}>
                      {proposalReport.issues.map((i) => (
                        <li key={i.message}>{i.message}</li>
                      ))}
                    </ul>
                  )}
                </Banner>
              )}
            </div>
          )}
        </section>

        <section>
          <h2 className={styles.step}>
            <span>2 · Connections, resources, preset</span>
            {hasExperimental && (
              <label className={styles.stepTools}>
                <input
                  type="checkbox"
                  checked={state.showExperimental}
                  onChange={(e) => patch({ showExperimental: e.target.checked })}
                />
                Show experimental providers
              </label>
            )}
          </h2>
          <div className={styles.panel}>
            {visible.map((connection) => {
              const cs = state.connections[connection.id] ?? EMPTY;
              const name = `${connection.provider_label} ${connection.display_name}`;
              const preset = connection.presets.find((p) => p.id === cs.presetId);
              const skipped = describeSkipped(presetSkipped(connection, cs));
              const accepted = Object.keys(cs.entries).length;
              // "N of M": M is "all resources" (neither hidden nor stale) plus
              // the hidden ones the creator ticked on purpose.
              const total =
                defaultResources(connection).length +
                connection.resources.filter((r) => r.hidden && cs.resourceIds.includes(r.id))
                  .length;
              const listed = connection.resources.length;
              return (
                <div
                  key={connection.id}
                  className={[styles.conn, cs.included ? '' : styles.connOff].join(' ')}
                  data-testid={`connection-${connection.provider}`}
                >
                  <div className={styles.connHead}>
                    <label className={styles.connName}>
                      <input
                        type="checkbox"
                        checked={cs.included}
                        aria-label={`Include ${name}`}
                        onChange={(e) =>
                          patchConnection(connection.id, setIncluded(cs, e.target.checked))
                        }
                      />
                      <strong>{connection.provider_label}</strong>
                      <span>{connection.display_name}</span>
                      {connection.experimental && <Badge tone="warning">experimental</Badge>}
                      {connection.status !== 'active' && (
                        <Badge tone="danger">{connection.status}</Badge>
                      )}
                    </label>
                    {cs.included ? (
                      <>
                        <button
                          type="button"
                          className={styles.linkButton}
                          aria-expanded={openResources.has(connection.id)}
                          onClick={() => toggleResources(connection.id)}
                        >
                          {listed === 0
                            ? 'No resource'
                            : `${cs.resourceIds.length} of ${total} ${total === 1 ? 'resource' : 'resources'}`}
                        </button>
                        <Select
                          value={cs.presetId}
                          aria-label={`Preset for ${name}`}
                          onChange={(e) =>
                            patchConnection(
                              connection.id,
                              applyPreset(connection, cs, e.target.value),
                            )
                          }
                        >
                          <option value="">Pick a preset…</option>
                          {connection.presets.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.label}
                            </option>
                          ))}
                        </Select>
                      </>
                    ) : (
                      <>
                        <span />
                        <span />
                      </>
                    )}
                  </div>
                  {cs.included && (preset || accepted > 0) && (
                    <div className={styles.connMeta}>
                      {preset && (
                        <div className={styles.oneLine} title={preset.description}>
                          {describePresetWidth(presetWidth(preset, connection.risks))}
                          {' — '}
                          {preset.description}
                        </div>
                      )}
                      {cs.edited && (
                        <div>
                          <Badge tone="info">
                            {preset ? 'adjusted' : 'custom'}: {accepted} accepted
                          </Badge>
                        </div>
                      )}
                      {skipped && !cs.edited && <div>{skipped}</div>}
                    </div>
                  )}
                  {cs.included && openResources.has(connection.id) && listed > 0 && (
                    <div className={styles.resources}>
                      {connection.resources.map((r) => (
                        <label key={r.id}>
                          <input
                            type="checkbox"
                            checked={cs.resourceIds.includes(r.id)}
                            // Discovery no longer returns it: never part of a new mission.
                            disabled={r.stale}
                            aria-label={`Resource ${r.ref}`}
                            onChange={(e) =>
                              patchConnection(
                                connection.id,
                                setResources(
                                  connection,
                                  cs,
                                  e.target.checked
                                    ? [...cs.resourceIds, r.id]
                                    : cs.resourceIds.filter((id) => id !== r.id),
                                ),
                              )
                            }
                          />
                          <span className={styles.mono}>{r.ref}</span>
                          {r.env && <Badge mono>{r.env}</Badge>}
                          {r.hidden && <Badge>hidden</Badge>}
                          {r.stale && <Badge tone="warning">stale</Badge>}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        <section>
          <h2 className={styles.step}>3 · Summary</h2>
          <dl className={[styles.panel, styles.summary].join(' ')} data-testid="summary">
            <div className={styles.summaryLine}>
              <dt>Can</dt>
              <dd data-testid="summary-can">{preview.summary.can}</dd>
            </div>
            <div className={styles.summaryLine}>
              <dt>Cannot</dt>
              <dd data-testid="summary-cannot">{preview.summary.cannot}</dd>
            </div>
            <div className={styles.summaryLine}>
              <dt>Quantities</dt>
              <dd data-testid="summary-quantities">{preview.summary.quantities}</dd>
            </div>
          </dl>
        </section>

        <section>
          <h2 className={styles.step}>4 · Per-risk detail — unfold only to adjust</h2>
          {included.length === 0 ? (
            <p className={styles.muted}>Include a connection to see its risks.</p>
          ) : (
            <div className={styles.panel}>
              {included.map((connection) => {
                const cs = state.connections[connection.id] ?? EMPTY;
                return (
                  <details
                    key={connection.id}
                    className={styles.fold}
                    data-testid={`risks-${connection.provider}`}
                  >
                    <summary>
                      <strong>{connection.provider_label}</strong>
                      <span>{connection.display_name}</span>
                      <span className={styles.muted}>
                        {Object.keys(cs.entries).length} of {availableCount(connection, cs)} risks
                        accepted — quota, rate limit, gate
                      </span>
                    </summary>
                    <RiskDetail
                      connection={connection}
                      state={cs}
                      onChange={(next) => patchConnection(connection.id, next)}
                    />
                  </details>
                );
              })}
            </div>
          )}
        </section>

        <footer className={styles.footer}>
          <div className={styles.footerRow}>
            <h2 className={styles.step}>5 · Period and expiry</h2>
            <div className={styles.asideControls}>
              <Select
                value={state.period}
                aria-label="Period"
                onChange={(e) => {
                  if (isChoice<PeriodChoice>(PERIOD_CHOICES, e.target.value)) {
                    patch({ period: e.target.value });
                  }
                }}
              >
                {PERIOD_CHOICES.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </Select>
              <Select
                value={state.expiry}
                aria-label="Expiry"
                onChange={(e) => {
                  if (isChoice<ExpiryChoice>(EXPIRY_CHOICES, e.target.value)) {
                    patch({ expiry: e.target.value });
                  }
                }}
              >
                {EXPIRY_CHOICES.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.label}
                  </option>
                ))}
              </Select>
              {state.expiry === 'custom' && (
                <Input
                  type="datetime-local"
                  value={state.expiryCustom}
                  aria-label="Expiry date"
                  onChange={(e) => patch({ expiryCustom: e.target.value })}
                />
              )}
            </div>
            <Button
              type="submit"
              variant="primary"
              className={styles.issueButton}
              disabled={busy || !preview.ok}
            >
              {busy ? 'Issuing…' : 'Issue mission'}
            </Button>
          </div>
          {issues.length > 0 && (
            <ul
              className={serverIssues.length > 0 ? styles.issues : styles.notes}
              data-testid="issues"
            >
              {issues.map((i) => (
                <li key={`${i.code}:${i.message}`}>{i.message}</li>
              ))}
            </ul>
          )}
          {error && (
            <Banner tone="danger" title="Not issued">
              {error}
            </Banner>
          )}
        </footer>
      </form>

      {issued && (
        <RevealDialog
          title={`Mission “${issued.name}” issued`}
          kit={issued.kit}
          onDone={() => router.push(`/missions/${issued.missionId}`)}
        />
      )}
    </>
  );
}

/** An ISO instant as the value of a `datetime-local` input (the viewer's time zone). */
function toLocalInput(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return new Date(at.getTime() - at.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isIssuedBody(
  body: unknown,
): body is { mission: { id: string; name: string }; kit: BootstrapKit } {
  return isRecord(body) && isRecord(body.mission) && isRecord(body.kit);
}

function isRefusedBody(body: unknown): body is { preview: MissionPreview } {
  return isRecord(body) && isRecord(body.preview) && Array.isArray(body.preview.issues);
}

function isPreviewBody(body: unknown): body is { preview: MissionPreview } {
  return isRefusedBody(body) && Array.isArray(body.preview.resolved);
}

function messageOf(body: unknown): string | null {
  if (!isRecord(body)) return null;
  if (Array.isArray(body.problems)) return body.problems.map(String).join('; ');
  return typeof body.message === 'string' ? body.message : null;
}

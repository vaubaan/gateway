'use client';

/**
 * The one-page mission creation screen (spec §4.2, §7.4), in this order:
 * name (or duplicate a mission, or paste an agent's proposal) → connections
 * and, within each, resources (all by default, folded) and the policy, built
 * in one of two modes: **Preset** — an explicit choice among the plugin's
 * presets, with what the chosen one allows, gates and leaves out always
 * visible — or **Custom** — the granular editor, every risk with its budget
 * and gate → a three-line summary → period and expiry → issue. The decision
 * shown here is `previewDraft`, the function the server runs again at
 * issuance; the browser's copy only saves a round trip.
 */
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

import { Badge, Banner, Button, Input, Select, Slug, Textarea } from '@/components/ui';
import type { BootstrapKit } from '@/server/missions/bootstrap-kit';
import type {
  DraftPeriod,
  IssuanceConnection,
  MissionPreview,
  PreviewIssue,
  PreviewNotice,
  ResolvedDraftConnection,
} from '@/server/missions/model';
import { defaultResources, previewDraft } from '@/server/missions/preview';
import type { RiskPlanes } from '@/server/providers/planes';

import { RevealDialog } from '../bootstrap-kit-view';
import { messageOf } from '../message-of';
import styles from '../missions.module.css';
import { CustomEditor } from './custom-editor';
import {
  applyPreset,
  backToPreset,
  discardsEdits,
  draftOf,
  enterCustom,
  EXPIRY_CHOICES,
  initialFormState,
  loadResolved,
  PERIOD_CHOICES,
  periodChoiceOf,
  periodOf,
  setIncluded,
  setResources,
  startFromPreset,
  type ConnectionState,
  type ExpiryChoice,
  type FormState,
  type PeriodChoice,
  type PolicyMode,
} from './form-state';
import { linesOfState, PolicyLines } from './policy-lines';
import { PresetPanel } from './preset-panel';

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

/**
 * An edit the screen holds back until the creator confirms it, because it
 * would throw away what they typed in the Custom editor.
 */
type PendingDiscard =
  | { readonly kind: 'back-to-preset' }
  | { readonly kind: 'start-from'; readonly presetId: string };

const MODES: readonly { id: PolicyMode; label: string }[] = [
  { id: 'preset', label: 'Preset' },
  { id: 'custom', label: 'Custom' },
];

const EMPTY: ConnectionState = {
  included: false,
  mode: 'preset',
  resourceIds: [],
  presetId: '',
  entries: {},
  edited: false,
};

export function MissionForm({
  context,
  missions,
  initial,
  planes,
}: {
  context: readonly IssuanceConnection[];
  /** Per provider id: the planes of its data model, for the providers that have several. */
  planes: Readonly<Record<string, RiskPlanes>>;
  missions: readonly { id: string; name: string }[];
  initial: InitialDraft | null;
}) {
  const router = useRouter();
  const [state, setState] = useState<FormState>(() => startState(context, initial));
  const [openResources, setOpenResources] = useState<ReadonlySet<string>>(new Set());
  // A policy loaded from a mission or a proposal is read first, edited on demand.
  const [readOnly, setReadOnly] = useState<ReadonlySet<string>>(
    () => new Set(initial?.resolved.map((line) => line.connection_id) ?? []),
  );
  const [pending, setPending] = useState<Readonly<Record<string, PendingDiscard>>>({});
  // Connections whose preset reading is spread out. Picking a preset spreads its own
  // reading out and counts the others; the creator may spread out as many as they like.
  const [spread, setSpread] = useState<ReadonlySet<string>>(new Set());
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
  function forget(id: string) {
    setPending((current) =>
      Object.fromEntries(Object.entries(current).filter(([key]) => key !== id)),
    );
  }
  function openEditor(id: string, open: boolean) {
    setReadOnly((current) => {
      const next = new Set(current);
      if (open) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  /** Preset | Custom. Leaving Custom with edits asks first; nothing is dropped silently. */
  function switchMode(connection: IssuanceConnection, cs: ConnectionState, mode: PolicyMode) {
    if (mode === cs.mode) return;
    if (mode === 'custom') {
      forget(connection.id);
      openEditor(connection.id, true);
      patchConnection(connection.id, enterCustom(cs));
    } else if (discardsEdits(cs)) {
      setPending((current) => ({ ...current, [connection.id]: { kind: 'back-to-preset' } }));
    } else {
      patchConnection(connection.id, backToPreset(connection, cs));
    }
  }
  function startFrom(connection: IssuanceConnection, cs: ConnectionState, presetId: string) {
    if (discardsEdits(cs)) {
      setPending((current) => ({
        ...current,
        [connection.id]: { kind: 'start-from', presetId },
      }));
    } else {
      patchConnection(connection.id, startFromPreset(connection, cs, presetId));
    }
  }
  function confirmDiscard(connection: IssuanceConnection, cs: ConnectionState) {
    const wanted = pending[connection.id];
    if (!wanted) return;
    forget(connection.id);
    patchConnection(
      connection.id,
      wanted.kind === 'back-to-preset'
        ? backToPreset(connection, cs)
        : startFromPreset(connection, cs, wanted.presetId),
    );
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
        setError(problemsOf(body) ?? messageOf(body, res.status));
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
        setPending({});
        setReadOnly(new Set(body.preview.resolved.map((line) => line.connection_id)));
      } else {
        setError(problemsOf(body) ?? messageOf(body, res.status));
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
            <span>2 · Connections, resources, policy</span>
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
              // "N of M": M is "all resources" (neither hidden nor stale) plus
              // the hidden ones the creator ticked on purpose.
              const total =
                defaultResources(connection).length +
                connection.resources.filter((r) => r.hidden && cs.resourceIds.includes(r.id))
                  .length;
              const listed = connection.resources.length;
              const wanted = pending[connection.id];
              const reading = cs.mode === 'custom' && readOnly.has(connection.id);
              const custom = linesOfState(connection.risks, cs);
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
                        <fieldset className={styles.modes}>
                          <legend className={styles.visuallyHidden}>Policy for {name}</legend>
                          {MODES.map((mode) => (
                            <label
                              key={mode.id}
                              className={[
                                styles.mode,
                                cs.mode === mode.id ? styles.modeOn : '',
                              ].join(' ')}
                            >
                              <input
                                type="radio"
                                name={`mode-${connection.id}`}
                                value={mode.id}
                                checked={cs.mode === mode.id}
                                onChange={() => switchMode(connection, cs, mode.id)}
                              />
                              {mode.label}
                            </label>
                          ))}
                        </fieldset>
                      </>
                    ) : (
                      <>
                        <span />
                        <span />
                      </>
                    )}
                  </div>
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
                          <Slug kind="resource">{r.ref}</Slug>
                          {r.env && <Badge mono>{r.env}</Badge>}
                          {r.hidden && <Badge>hidden</Badge>}
                          {r.stale && <Badge tone="warning">stale</Badge>}
                        </label>
                      ))}
                    </div>
                  )}
                  {cs.included && wanted && (
                    <div
                      className={styles.discard}
                      role="alert"
                      data-testid={`discard-${connection.provider}`}
                    >
                      <span>
                        {wanted.kind === 'back-to-preset'
                          ? 'Going back to Preset discards what you changed in the editor on this connection.'
                          : 'Starting from another preset replaces what you changed in the editor on this connection.'}
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant="danger"
                        onClick={() => confirmDiscard(connection, cs)}
                      >
                        Discard my changes
                      </Button>
                      <Button type="button" size="sm" onClick={() => forget(connection.id)}>
                        Keep editing
                      </Button>
                    </div>
                  )}
                  {cs.included && cs.mode === 'preset' && (
                    <PresetPanel
                      connection={connection}
                      state={cs}
                      expanded={spread.has(connection.id)}
                      onPick={(presetId) => {
                        setSpread(new Set([connection.id]));
                        patchConnection(connection.id, applyPreset(connection, cs, presetId));
                      }}
                      onExpand={(expanded) =>
                        setSpread((current) => {
                          const next = new Set(current);
                          if (expanded) next.add(connection.id);
                          else next.delete(connection.id);
                          return next;
                        })
                      }
                    />
                  )}
                  {cs.included && reading && (
                    <div
                      className={styles.policyBody}
                      data-testid={`custom-${connection.provider}`}
                    >
                      <div className={styles.presetDetail}>
                        <p className={styles.presetDescription}>
                          Custom policy, as loaded. Nothing below comes from a preset reference: it
                          is the explicit list this mission would carry.{' '}
                          <button
                            type="button"
                            className={styles.linkButton}
                            aria-expanded={false}
                            onClick={() => openEditor(connection.id, true)}
                          >
                            Edit risk by risk
                          </button>
                        </p>
                        <PolicyLines
                          title="Allowed without asking"
                          lines={custom.auto}
                          empty="Nothing."
                        />
                        <PolicyLines
                          title="Needs your approval, action by action"
                          lines={custom.approval}
                          empty="Nothing: the agent never has to ask you."
                        />
                      </div>
                    </div>
                  )}
                  {cs.included && cs.mode === 'custom' && !reading && (
                    <CustomEditor
                      connection={connection}
                      state={cs}
                      planes={planes[connection.provider] ?? null}
                      onChange={(next) => patchConnection(connection.id, next)}
                      onStartFrom={(presetId) => startFrom(connection, cs, presetId)}
                    />
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

        <footer className={styles.footer}>
          <div className={styles.footerRow}>
            <h2 className={styles.step}>4 · Period and expiry</h2>
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
          {preview.notices.length > 0 && (
            <ul className={styles.notices} data-testid="notices">
              {preview.notices.map((n) => (
                <li key={`${n.code}:${n.connection_index ?? ''}:${n.resource_refs.join(',')}`}>
                  <details>
                    <summary>{noticeHeadline(n, context)}</summary>
                    {n.message}
                  </details>
                </li>
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

/**
 * The one line of a notice; its full sentence (consequence, remedy) unfolds
 * below it. A resource is named as its owner named it; its ref follows only
 * when the name is something else (a database is a UUID at the provider).
 */
function noticeHeadline(notice: PreviewNotice, context: readonly IssuanceConnection[]): string {
  const resources = context.find((c) => c.id === notice.connection_id)?.resources ?? [];
  const refs = notice.resource_refs
    .map((ref) => {
      const name = resources.find((r) => r.ref === ref)?.display_name;
      return name && name !== ref ? `${name} (${ref})` : ref;
    })
    .join(', ');
  switch (notice.code) {
    case 'resource-without-env':
      return `Warning: no environment label on ${refs}. Environment-scoped risks are refused there.`;
    case 'resource-env-not-in-catalog':
      return `Warning: the environment label of ${refs} is not one the catalog knows. Environment-scoped risks are refused there.`;
  }
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

/** A refused draft lists its problems; any other refusal states one message. */
function problemsOf(body: unknown): string | null {
  if (isRecord(body) && Array.isArray(body.problems)) return body.problems.map(String).join('; ');
  return null;
}

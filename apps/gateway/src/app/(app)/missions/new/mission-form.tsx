'use client';

/**
 * "New mission" on one screen (spec §4.2, §7.4): a form in three steps and a
 * rail that says, as the form changes, what the mission would be able to do.
 *
 *   1. Name — or start from one of your missions, or paste an agent's proposal.
 *   2. Accounts and permissions — per account: its resources (all by default,
 *      "Change" opens the list), then a preset, each saying what it yields
 *      here; the permissions one by one are a click away (`CustomEditor`).
 *   3. Limits and lifetime — how often the limits reset, when the mission
 *      ends. People are added once it exists.
 *
 * "Create mission" asks once: the dialog lists **every permission with its
 * limit**, by account, and that list is what is created — a preset is never
 * stored. The decision shown is `previewDraft`, the function the server runs
 * again at creation; the browser's copy only saves a round trip.
 *
 * Once created, the screen becomes the key, shown once, with the kit
 * (`KeyReveal`): the key exists nowhere else, so nothing navigates away
 * until the person asks to open the mission.
 */
import Link from 'next/link';
import { useMemo, useState } from 'react';

import {
  Button,
  ButtonLink,
  Callout,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  CardTitle,
  Checkbox,
  ChoiceChip,
  ChoiceRow,
  ConfirmDialog,
  Dialog,
  EnvTag,
  Field,
  FormColumns,
  FormStep,
  FormWithRail,
  Input,
  Mono,
  PageHeader,
  Row,
  Rows,
  Section,
  Select,
  StatusMark,
  Tag,
  Textarea,
} from '@/components/ui';
import {
  ACCOUNT_WORDS,
  ACTIONS,
  count,
  expiresOn,
  limitColumn,
  limitsResetEvery,
  listed,
  mayAllow,
  MISSION_ACTIONS,
  MISSION_WORDS,
  PAGES,
  ROUTES,
  shortDate,
  TERMS,
  WAITING,
} from '@/lib/vocabulary';
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

import { KeyReveal, revealedOf } from '../bootstrap-kit-view';
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
  expiryOf,
  initialFormState,
  issueSentence,
  loadResolved,
  PERIOD_CHOICES,
  periodChoiceOf,
  periodOf,
  RESOURCE_CHOICES,
  setIncluded,
  setResourceScope,
  setResources,
  startEmpty,
  type ConnectionState,
  type ExpiryChoice,
  type FormState,
  type PeriodChoice,
} from './form-state';
import { ExplicitList, RailSummary, type IncludedAccount } from './policy-lines';
import { PresetPanel } from './preset-panel';

export interface InitialDraft {
  readonly name: string;
  readonly period: DraftPeriod;
  readonly resolved: readonly ResolvedDraftConnection[];
  /** What could not be carried over from the source (a permission no longer held, a vanished resource). */
  readonly issues: readonly PreviewIssue[];
  readonly sourceName: string;
}

interface Created {
  readonly missionId: string;
  readonly name: string;
  readonly secret: string;
  readonly kit: BootstrapKit;
  readonly permissions: number;
  readonly services: readonly string[];
}

function isChoice<T extends string>(choices: readonly { id: T }[], raw: string): raw is T {
  return choices.some((c) => c.id === raw);
}

function startState(
  context: readonly IssuanceConnection[],
  initial: InitialDraft | null,
): FormState {
  const blank = initialFormState(context);
  // A single usable account is the obvious one: include it up front.
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
 * A choice the screen holds back until the person confirms it, because it
 * would throw away what they changed in the editor of one account.
 */
type PendingDiscard =
  | { readonly kind: 'reset'; readonly connectionId: string }
  | { readonly kind: 'preset'; readonly connectionId: string; readonly presetId: string }
  | { readonly kind: 'empty'; readonly connectionId: string };

const EMPTY: ConnectionState = {
  included: false,
  mode: 'preset',
  resourceScope: 'all',
  resourceIds: [],
  presetId: '',
  entries: {},
  edited: false,
};

const UNREACHABLE = 'The gateway could not be reached.';

export function MissionForm({
  context,
  missions,
  initial,
  planes,
}: {
  context: readonly IssuanceConnection[];
  /** Per service id: the planes of its data model, for the services that have several. */
  planes: Readonly<Record<string, RiskPlanes>>;
  missions: readonly { id: string; name: string }[];
  initial: InitialDraft | null;
}) {
  const [state, setState] = useState<FormState>(() => startState(context, initial));
  const [openResources, setOpenResources] = useState<ReadonlySet<string>>(new Set());
  const [openEditors, setOpenEditors] = useState<ReadonlySet<string>>(new Set());
  const [pending, setPending] = useState<PendingDiscard | null>(null);
  const [now] = useState(() => new Date());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverIssues, setServerIssues] = useState<readonly PreviewIssue[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);
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
  const included: IncludedAccount[] = context.flatMap((connection) => {
    const cs = state.connections[connection.id];
    return cs?.included ? [{ connection, state: cs }] : [];
  });
  const period = periodOf(state.period);
  const periodSeconds = period.kind === 'recurring' ? period.length_seconds : null;
  const expiresAt = expiryOf(state, now);
  const carries = `${count(preview.policy.length, { one: 'explicit permission', many: 'explicit permissions' })}, ${limitsResetEvery(periodSeconds)}, ${expiresAt && Number.isNaN(Date.parse(expiresAt)) ? 'no end date yet' : expiresOn(expiresAt, now)}.`;

  function patch(next: Partial<FormState>) {
    setServerIssues([]);
    setState((s) => ({ ...s, ...next }));
  }
  function patchConnection(id: string, next: ConnectionState) {
    setServerIssues([]);
    setState((s) => ({ ...s, connections: { ...s.connections, [id]: next } }));
  }
  function toggle(set: (update: (open: ReadonlySet<string>) => ReadonlySet<string>) => void) {
    return (id: string, open?: boolean) =>
      set((current) => {
        const next = new Set(current);
        if (open ?? !next.has(id)) next.add(id);
        else next.delete(id);
        return next;
      });
  }
  const toggleResources = toggle(setOpenResources);
  const toggleEditor = toggle(setOpenEditors);

  /** A preset chip. Changing it over edits asks first; nothing is dropped silently. */
  function pickPreset(connection: IssuanceConnection, cs: ConnectionState, presetId: string) {
    if (discardsEdits(cs)) {
      setPending({ kind: 'preset', connectionId: connection.id, presetId });
      return;
    }
    patchConnection(connection.id, applyPreset(connection, { ...cs, mode: 'preset' }, presetId));
  }
  function pickCustom(connection: IssuanceConnection, cs: ConnectionState) {
    if (discardsEdits(cs)) {
      setPending({ kind: 'empty', connectionId: connection.id });
      return;
    }
    patchConnection(connection.id, startEmpty(cs));
    toggleEditor(connection.id, true);
  }
  function openEditor(connection: IssuanceConnection, cs: ConnectionState, open: boolean) {
    // The editor opens on what is there: the preset's values are its starting point.
    if (open && cs.mode === 'preset') patchConnection(connection.id, enterCustom(cs));
    toggleEditor(connection.id, open);
  }
  function confirmDiscard() {
    if (!pending) return;
    const connection = context.find((c) => c.id === pending.connectionId);
    const cs = connection ? state.connections[connection.id] : undefined;
    setPending(null);
    if (!connection || !cs) return;
    if (pending.kind === 'reset') patchConnection(connection.id, backToPreset(connection, cs));
    if (pending.kind === 'preset') {
      patchConnection(
        connection.id,
        applyPreset(connection, { ...cs, mode: 'preset' }, pending.presetId),
      );
    }
    if (pending.kind === 'empty') {
      patchConnection(connection.id, startEmpty(cs));
      toggleEditor(connection.id, true);
    }
  }

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/missions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draftOf(context, state, new Date())),
      });
      const body: unknown = await res.json().catch(() => null);
      const made = revealedOf(body);
      if (res.status === 201 && isCreatedBody(body) && made) {
        setConfirming(false);
        setCreated({
          missionId: body.mission.id,
          name: body.mission.name,
          ...made,
          permissions: preview.policy.length,
          services: included.map(({ connection }) => connection.provider_label),
        });
      } else if (res.status === 422 && isRefusedBody(body)) {
        setConfirming(false);
        setServerIssues(body.preview.issues);
      } else {
        setError(problemsOf(body) ?? messageOf(body, res.status));
      }
    } catch {
      setError(UNREACHABLE);
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
        setPending(null);
        // A loaded list is read first, edited on demand.
        setOpenEditors(new Set());
      } else {
        setError(problemsOf(body) ?? messageOf(body, res.status));
      }
    } catch {
      setError(UNREACHABLE);
    } finally {
      setBusy(false);
    }
  }

  if (created)
    return <CreatedView created={created} period={periodSeconds} expiresAt={expiresAt} now={now} />;

  const crumbs = [{ label: 'Missions', href: ROUTES.missions }, { label: PAGES.newMission.title }];

  if (context.length === 0) {
    return (
      <>
        <PageHeader crumbs={crumbs} title={PAGES.newMission.title} lede={PAGES.newMission.lede} />
        <Callout
          tone="info"
          title="Connect an account first"
          action={<ButtonLink href={ROUTES.accounts}>{ACTIONS.connectAccount}</ButtonLink>}
          testId="no-account"
        >
          A mission is created on accounts you own or were given access to. You have none yet.
        </Callout>
      </>
    );
  }

  return (
    <>
      <PageHeader crumbs={crumbs} title={PAGES.newMission.title} lede={PAGES.newMission.lede} />

      {initial && (
        <div className={styles.block}>
          <Callout
            tone={initial.issues.length > 0 ? 'warn' : 'info'}
            title={`Duplicating “${initial.sourceName}”`}
            testId="duplicating"
          >
            Same accounts, resources, permissions and limits; the copy gets its own key and counts
            on its own.
            {initial.issues.length > 0 && (
              <ul className={styles.issueList}>
                {initial.issues.map((i) => (
                  <li key={i.message}>{issueSentence(i, context)}</li>
                ))}
              </ul>
            )}
          </Callout>
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (preview.ok) setConfirming(true);
        }}
      >
        <FormWithRail
          rail={
            <Card>
              <CardHeader>
                <CardTitle>{MISSION_WORDS.railTitle}</CardTitle>
              </CardHeader>
              <CardBody>
                <RailSummary accounts={included} carries={carries} />
                {issues.length > 0 && (
                  <ul
                    className={serverIssues.length > 0 ? styles.railRefused : styles.railIssues}
                    data-testid="issues"
                  >
                    {issues.map((i) => (
                      <li key={`${i.code}:${i.message}`}>{issueSentence(i, context)}</li>
                    ))}
                  </ul>
                )}
                {error && !confirming && (
                  <p className={styles.railRefused} role="alert" data-testid="create-error">
                    Not created: {error}
                  </p>
                )}
              </CardBody>
              <CardFooter>
                <Button type="submit" variant="primary" size="lg" disabled={busy || !preview.ok}>
                  {ACTIONS.createMission}
                </Button>
                <ButtonLink href={ROUTES.missions} variant="ghost">
                  {ACTIONS.cancel}
                </ButtonLink>
                <span className={styles.railHint}>{MISSION_WORDS.keyAtTheEnd}</span>
              </CardFooter>
            </Card>
          }
        >
          <FormStep n={1} title="Name" hint="How you will find it again.">
            <div className={styles.nameRow}>
              <Input
                value={state.name}
                onChange={(e) => patch({ name: e.target.value })}
                placeholder="What is this mission for? Ship the billing page"
                aria-label="Mission name"
                maxLength={120}
                autoFocus
              />
              {missions.length > 0 && (
                <Select
                  value=""
                  className={styles.startFrom}
                  aria-label="Start from one of your missions"
                  onChange={(e) => {
                    // A full navigation: the form starts again from the copy, not from this state.
                    if (e.target.value) {
                      window.location.assign(
                        `${ROUTES.newMission}?from=${encodeURIComponent(e.target.value)}`,
                      );
                    }
                  }}
                >
                  <option value="">{MISSION_ACTIONS.startFrom}</option>
                  {missions.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </Select>
              )}
              <Button
                type="button"
                aria-expanded={proposalOpen}
                onClick={() => setProposalOpen((o) => !o)}
              >
                {MISSION_ACTIONS.pasteProposal}
              </Button>
            </div>
            {proposalOpen && (
              <div className={styles.proposal}>
                <Field
                  label="What the agent proposed"
                  htmlFor="mission-proposal"
                  shape="JSON, as its management tools print it"
                  hint="Nothing is created: what you may allow fills the form, the rest is listed."
                >
                  <Textarea
                    id="mission-proposal"
                    mono
                    value={proposalText}
                    onChange={(e) => setProposalText(e.target.value)}
                    aria-label="Agent proposal (JSON)"
                    placeholder='{"connections":[{"provider":"github","preset":"developer","resources":{"scope":"selected","resource_refs":["acme/app"]}}]}'
                    spellCheck={false}
                  />
                </Field>
                <div>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => void checkProposal()}
                    disabled={busy || proposalText.trim() === ''}
                  >
                    Check and load
                  </Button>
                </div>
                {proposalReport && (
                  <Callout
                    tone={proposalReport.ok ? 'ok' : 'warn'}
                    title={`Loaded ${count(proposalReport.policy.length, TERMS.risk)} on ${count(proposalReport.connections.length, TERMS.connection)}`}
                    testId="proposal-report"
                  >
                    {proposalReport.issues.length === 0 ? (
                      'Everything the proposal asks for is within what you may allow.'
                    ) : (
                      <ul className={styles.issueList}>
                        {proposalReport.issues.map((i) => (
                          <li key={i.message}>{issueSentence(i, context)}</li>
                        ))}
                      </ul>
                    )}
                  </Callout>
                )}
              </div>
            )}
          </FormStep>

          <FormStep n={2} title="Accounts and permissions" hint={MISSION_WORDS.explicitList}>
            <div className={styles.accounts}>
              {visible.map((connection) => {
                const cs = state.connections[connection.id] ?? EMPTY;
                const name = `${connection.provider_label} ${connection.display_name}`;
                // "N of M": M is "all resources" (neither hidden nor stale) plus
                // the hidden ones the person ticked on purpose.
                const total =
                  defaultResources(connection).length +
                  connection.resources.filter((r) => r.hidden && cs.resourceIds.includes(r.id))
                    .length;
                const listedCount = connection.resources.length;
                const whole = cs.resourceScope === 'connection';
                const selected = connection.resources.filter((r) => cs.resourceIds.includes(r.id));
                const envs = [...new Set(selected.flatMap((r) => (r.env ? [r.env] : [])))];
                const editorOpen = openEditors.has(connection.id);
                // The expansion of "Everything I hold" is said by the preset panel, in its words.
                const notices = preview.notices.filter(
                  (n) =>
                    n.connection_id === connection.id && n.code !== 'everything-i-hold-expanded',
                );
                return (
                  <div
                    key={connection.id}
                    className={[styles.account, cs.included ? '' : styles.accountOff].join(' ')}
                    data-testid={`connection-${connection.provider}`}
                  >
                    <div className={styles.accountHead}>
                      <Checkbox
                        checked={cs.included}
                        aria-label={`Include ${name}`}
                        onChange={(e) =>
                          patchConnection(connection.id, setIncluded(cs, e.target.checked))
                        }
                      />
                      <span className={styles.accountName}>
                        {connection.provider_label} · {connection.display_name}
                      </span>
                      <span className={styles.accountHint}>
                        {connection.basis === 'owner'
                          ? 'you own it'
                          : `access given to you · may allow ${mayAllow(connection.authority.length, connection.risks.length)}`}
                      </span>
                      {connection.experimental && <Tag tone="warn">experimental</Tag>}
                      {connection.status !== 'active' && (
                        <StatusMark tone="bad">{connection.status}</StatusMark>
                      )}
                      <span className={styles.accountResources}>
                        {!cs.included ? (
                          'not in this mission'
                        ) : (
                          <>
                            <span className={styles.resourceNames}>
                              {whole
                                ? MISSION_WORDS.wholeAccount
                                : listedCount === 0
                                  ? 'the account itself, no resource'
                                  : selected.length === 0
                                    ? 'No resource'
                                    : listed(
                                        selected.map((r) => r.display_name || r.ref),
                                        2,
                                      )}
                            </span>
                            {envs.map((env) => (
                              <EnvTag key={env} env={env} />
                            ))}
                            {listedCount > 0 && (
                              <span className={styles.resourceCount}>
                                {whole
                                  ? `${cs.resourceIds.length} known now`
                                  : `${cs.resourceIds.length} of ${total}`}
                              </span>
                            )}
                            <Button
                              type="button"
                              size="sm"
                              aria-expanded={openResources.has(connection.id)}
                              aria-label={`${MISSION_ACTIONS.change} the resources of ${name}: ${
                                whole
                                  ? MISSION_WORDS.wholeAccount
                                  : `${cs.resourceIds.length} of ${total} ${total === 1 ? 'resource' : 'resources'}`
                              }`}
                              onClick={() => toggleResources(connection.id)}
                            >
                              {MISSION_ACTIONS.change}
                            </Button>
                          </>
                        )}
                      </span>
                    </div>

                    {cs.included && openResources.has(connection.id) && (
                      <div className={styles.resourceScope} data-testid="resource-scope">
                        <ChoiceRow legend={`Resources of ${name} the mission reaches`}>
                          {RESOURCE_CHOICES.map((choice) => (
                            <ChoiceChip
                              key={choice.id}
                              name={`resource-scope-${connection.id}`}
                              value={choice.id}
                              checked={cs.resourceScope === choice.id}
                              onChange={() =>
                                patchConnection(
                                  connection.id,
                                  setResourceScope(connection, cs, choice.id),
                                )
                              }
                              label={choice.label}
                              hint={choice.hint}
                            />
                          ))}
                        </ChoiceRow>
                        <p className={styles.quietText}>
                          {RESOURCE_CHOICES.find((c) => c.id === cs.resourceScope)?.explanation}
                        </p>
                      </div>
                    )}

                    {cs.included &&
                      openResources.has(connection.id) &&
                      cs.resourceScope !== 'connection' &&
                      listedCount > 0 && (
                        <div
                          className={styles.resources}
                          role="group"
                          aria-label={`Resources of ${name}`}
                        >
                          {connection.resources.map((r) => (
                            <Checkbox
                              key={r.id}
                              checked={cs.resourceIds.includes(r.id)}
                              // Discovery no longer returns it, or it hosts this
                              // instance: never part of a new mission.
                              disabled={r.stale || r.self}
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
                            >
                              <span className={styles.resource}>
                                {r.display_name || r.ref}
                                {r.display_name && r.display_name !== r.ref && (
                                  <span className={styles.quietText}> {r.ref}</span>
                                )}
                                <EnvTag env={r.env} />
                                {r.hidden && <Tag>hidden by its owner</Tag>}
                                {r.stale && <Tag tone="warn">no longer found</Tag>}
                                {r.self && <Tag tone="warn">{ACCOUNT_WORDS.self}</Tag>}
                              </span>
                            </Checkbox>
                          ))}
                        </div>
                      )}

                    {cs.included && (
                      <PresetPanel
                        connection={connection}
                        state={cs}
                        editorOpen={editorOpen}
                        onPick={(presetId) => pickPreset(connection, cs, presetId)}
                        onCustom={() => pickCustom(connection, cs)}
                        onEditor={(open) => openEditor(connection, cs, open)}
                      />
                    )}
                    {cs.included &&
                      notices.map((n) => (
                        <details
                          key={`${n.code}:${n.resource_refs.join(',')}`}
                          className={styles.notice}
                          data-testid="notices"
                        >
                          <summary>{noticeHeadline(n, connection)}</summary>
                          The mission can be created as it is. To let those permissions through
                          there, give the resource its environment label on the page of the account,
                          or leave the resource out. <Mono quiet>{n.risk_ids.join(', ')}</Mono>
                        </details>
                      ))}
                    {cs.included && editorOpen && (
                      <div id={`editor-${connection.id}`}>
                        <CustomEditor
                          connection={connection}
                          state={cs}
                          planes={planes[connection.provider] ?? null}
                          limitLabel={limitColumn(periodSeconds)}
                          onChange={(next) => patchConnection(connection.id, next)}
                          onReset={
                            cs.presetId && cs.edited
                              ? () => setPending({ kind: 'reset', connectionId: connection.id })
                              : null
                          }
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {hasExperimental && (
              <div className={styles.afterLine}>
                <Checkbox
                  checked={state.showExperimental}
                  onChange={(e) => patch({ showExperimental: e.target.checked })}
                >
                  Show experimental services
                </Checkbox>
              </div>
            )}
          </FormStep>

          <FormStep
            n={3}
            title="Limits and lifetime"
            hint="Limits that reset every day suit an agent that works every day."
          >
            <FormColumns>
              <Field label="Limits reset" htmlFor="mission-period">
                <Select
                  id="mission-period"
                  value={state.period}
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
              </Field>
              <Field label="Expires" htmlFor="mission-expiry">
                <Select
                  id="mission-expiry"
                  value={state.expiry}
                  onChange={(e) => {
                    if (isChoice<ExpiryChoice>(EXPIRY_CHOICES, e.target.value)) {
                      patch({ expiry: e.target.value });
                    }
                  }}
                >
                  {EXPIRY_CHOICES.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.days === null
                        ? x.label
                        : `${x.label} · ${shortDate(new Date(now.getTime() + x.days * 86_400_000), now)}`}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="People">
                <p className={styles.people}>{MISSION_WORDS.peopleLater}</p>
              </Field>
            </FormColumns>
            {state.expiry === 'custom' && (
              <div className={styles.expiryDate}>
                <Field label="Expires on" htmlFor="mission-expiry-date" shape="your local time">
                  <Input
                    id="mission-expiry-date"
                    type="datetime-local"
                    value={state.expiryCustom}
                    onChange={(e) => patch({ expiryCustom: e.target.value })}
                  />
                </Field>
              </div>
            )}
          </FormStep>
        </FormWithRail>
      </form>

      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        width="lg"
        divided
        dismissible={!busy}
        title={`Create “${state.name.trim()}”?`}
        description={
          <>
            This is the explicit list the key will carry: {carries} Anything else is refused. You
            get the key next, shown once.
          </>
        }
        hint={WAITING.recorded}
        testId="confirm-create"
        footer={
          <>
            <Button type="button" variant="primary" loading={busy} onClick={() => void create()}>
              {busy ? 'Creating…' : ACTIONS.createMission}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              Back to the form
            </Button>
          </>
        }
      >
        <ExplicitList accounts={included} periodSeconds={periodSeconds} />
        {error && confirming && (
          <p className={styles.railRefused} role="alert">
            Not created: {error}
          </p>
        )}
      </Dialog>

      <ConfirmDialog
        open={pending !== null}
        title="Discard what you changed?"
        consequence={
          pending?.kind === 'reset'
            ? 'The permissions, limits and "ask me first" you changed on this account go back to the preset as it is.'
            : pending?.kind === 'empty'
              ? 'Custom starts from an empty list: the permissions, limits and "ask me first" you changed on this account are dropped.'
              : 'Another preset replaces the permissions, limits and "ask me first" you changed on this account.'
        }
        confirmLabel="Discard my changes"
        tone="danger"
        onConfirm={confirmDiscard}
        onCancel={() => setPending(null)}
        testId="discard-dialog"
      />
    </>
  );
}

/** Right after "Create mission": the key, once, and what the agent needs to start. */
function CreatedView({
  created,
  period,
  expiresAt,
  now,
}: {
  created: Created;
  period: number | null;
  expiresAt: string | null;
  now: Date;
}) {
  const missionPath = `${ROUTES.missions}/${created.missionId}`;
  return (
    <div data-testid="created">
      <PageHeader
        width="narrow"
        crumbs={[{ label: 'Missions', href: ROUTES.missions }, { label: created.name }]}
        title={created.name}
        lede={`Created just now · ${count(created.permissions, TERMS.risk)} on ${listed([...created.services], 3)} · ${limitsResetEvery(period)} · ${expiresOn(expiresAt, now)}`}
        secondary={[
          <ButtonLink key="open" href={missionPath}>
            {MISSION_ACTIONS.openMission}
          </ButtonLink>,
        ]}
      />
      <Section first title="Your key" note={MISSION_WORDS.keyShownOnce}>
        <KeyReveal secret={created.secret} kit={created.kit} />
      </Section>
      <Section title="Working with others?">
        <Rows>
          <Row
            title="Add a teammate"
            description="They sign in and generate their own key; every call they make is in their name. Same permissions, same limits."
            end={
              <ButtonLink href={`${missionPath}#people`} size="sm">
                {ACTIONS.addPeople}
              </ButtonLink>
            }
          />
          <Row
            title="Add a machine key"
            description="For CI or a shared machine that has no account. Named by you, revoked on its own."
            end={
              <ButtonLink href={`${missionPath}#people`} size="sm">
                {ACTIONS.newMachineKey}
              </ButtonLink>
            }
          />
        </Rows>
      </Section>
      <p className={styles.quiet}>
        Leaving this page hides the key for good. <Link href={missionPath}>The mission page</Link>{' '}
        keeps the kit, without the key.
      </p>
    </div>
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
 * below it. A resource is named as its owner named it, as on every page.
 */
function noticeHeadline(notice: PreviewNotice, connection: IssuanceConnection): string {
  const refs = notice.resource_refs
    .map((ref) => connection.resources.find((r) => r.ref === ref)?.display_name || ref)
    .join(', ');
  switch (notice.code) {
    case 'resource-without-env':
      return `No environment label on ${refs}: permissions tied to an environment are refused there.`;
    case 'resource-env-not-in-catalog':
      return `The environment label of ${refs} is not one this service knows: permissions tied to an environment are refused there.`;
    case 'later-resources-need-env-label':
      return 'A resource found later gets permissions tied to an environment only once it carries its environment label.';
    case 'everything-i-hold-expanded':
      return 'Everything you hold on this account, written out one permission at a time.';
  }
}

function isCreatedBody(body: unknown): body is { mission: { id: string; name: string } } {
  return isRecord(body) && isRecord(body.mission) && typeof body.mission.id === 'string';
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

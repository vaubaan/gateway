'use client';

/**
 * "New mission" on one screen (spec §4.2, §7.4): a form in three steps and a
 * rail that says, as the form changes, what the mission would be able to do.
 *
 *   1. Name — or start from one of your missions, or paste an agent's proposal.
 *   2. Accounts and permissions — per account: its resources (all by default,
 *      "Change" opens the list), then its macro-actions, each ticked at a
 *      trust level and saying what it yields here; the permissions one by one
 *      are the Advanced view (`MacroActionPanel`, `CustomEditor`).
 *   3. Limits and lifetime — how often the limits reset, when the mission
 *      ends. People are added once it exists.
 *
 * "Create mission" asks once: the dialog lists **every permission with its
 * limit**, by account, and that list is what is created — the trust levels are
 * kept only to redraw this form. The decision shown is `previewDraft`, the function the server runs
 * again at creation; the browser's copy only saves a round trip.
 *
 * Once created, the screen becomes the key, shown once, with the kit
 * (`KeyReveal`): the key exists nowhere else, so nothing navigates away
 * until the person asks to open the mission.
 *
 * With `edit`, the same screen edits a mission after issuance (ADR
 * mission-editable-after-issuance): prefilled from the mission, its period
 * fixed, its end date "as it is", judged by `judgeEdit` — the creation's
 * preview kept on what moves —, and "Save changes" confirms every change
 * before → after with what it means. Same key, same session, same counters.
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
  RESOURCE_SET_WORDS,
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
} from '@/lib/missions/model';
import { hasChanges, judgeEdit } from '@/lib/missions/mission-edit';
import { defaultResources, previewDraft } from '@/lib/missions/preview';
import type { TrustLevel } from '@/lib/missions/macro-actions';
import type { RiskPlanes } from '@/lib/providers/planes';

import { KeyReveal, revealedOf } from '../bootstrap-kit-view';
import { messageOf } from '@/lib/http/message-of';
import { useAction, type PostAnswer } from '@/lib/http/post-json';
import styles from '../missions.module.css';
import { CustomEditor } from './custom-editor';
import {
  addResourceSet,
  applyTrustLevels,
  applyEverything,
  discardsEdits,
  draftOf,
  EXPIRY_CHOICES,
  expiryOf,
  initialConnectionState,
  initialFormState,
  initialSetState,
  issueSentence,
  loadResolved,
  PERIOD_CHOICES,
  periodChoiceOf,
  periodOf,
  removeResourceSet,
  resetEdits,
  RESOURCE_CHOICES,
  setIncluded,
  setMacroAction,
  setOfResource,
  setResourceScope,
  setResources,
  setsOffered,
  setView,
  takesTheRest,
  updateSet,
  type ConnectionState,
  type ExpiryChoice,
  type ResourceChoice,
  type SetState,
  type FormState,
  type PeriodChoice,
} from './form-state';
import { changeLines, editDraftOf, initialEditState, type EditSource } from './edit-state';
import { ExplicitList, RailSummary, type IncludedAccount } from './policy-lines';
import { MacroActionPanel, SetPolicy } from './macro-action-panel';
import { MS_PER_DAY } from '@vaubaan/shared/time';

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
  // A single account is the obvious one: include it up front.
  const [only] = context;
  const onlyState = only ? blank.connections[only.id] : undefined;
  const base: FormState =
    context.length === 1 && only && onlyState
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
  | { readonly kind: 'reset'; readonly connectionId: string; readonly setIndex: number }
  | {
      readonly kind: 'trust-level';
      readonly connectionId: string;
      readonly setIndex: number;
      readonly actionId: string;
      readonly trustLevel: TrustLevel | null;
    }
  | { readonly kind: 'everything'; readonly connectionId: string; readonly setIndex: number };

export function MissionForm({
  context,
  missions,
  initial,
  planes,
  edit = null,
}: {
  context: readonly IssuanceConnection[];
  /** Per service id: the planes of its data model, for the services that have several. */
  planes: Readonly<Record<string, RiskPlanes>>;
  missions: readonly { id: string; name: string }[];
  initial: InitialDraft | null;
  /** The mission this form edits; `null` for a creation. */
  edit?: EditSource | null;
}) {
  const [state, setState] = useState<FormState>(() =>
    edit ? initialEditState(context, edit.snapshot) : startState(context, initial),
  );
  const [openResources, setOpenResources] = useState<ReadonlySet<string>>(new Set());
  const [pending, setPending] = useState<PendingDiscard | null>(null);
  const [now] = useState(() => new Date());
  const { busy, error, setError, run } = useAction();
  const [serverIssues, setServerIssues] = useState<readonly PreviewIssue[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);
  const [proposalOpen, setProposalOpen] = useState(false);
  const [proposalText, setProposalText] = useState('');
  const [proposalReport, setProposalReport] = useState<MissionPreview | null>(null);

  const preview = useMemo(
    () => previewDraft({ connections: context, now }, draftOf(context, state, now)),
    [context, state, now],
  );
  // An edit is judged on what it moves, against the mission as it stands.
  const judgement = useMemo(
    () =>
      edit
        ? judgeEdit(
            { connections: context, now },
            edit.snapshot,
            editDraftOf(context, state, edit.snapshot, now),
          )
        : null,
    [context, state, now, edit],
  );
  const changed = judgement ? hasChanges(judgement.changes) : false;
  const issues = serverIssues.length > 0 ? serverIssues : (judgement?.issues ?? preview.issues);
  const ready = judgement ? judgement.ok && changed : preview.ok;
  const permissionCount = judgement
    ? judgement.after.connections.reduce(
        (n, c) => n + c.resource_sets.reduce((m, set) => m + set.policy.length, 0),
        0,
      )
    : preview.policy.length;
  const included: IncludedAccount[] = context.flatMap((connection) => {
    const cs = state.connections[connection.id];
    return cs?.included ? [{ connection, state: cs }] : [];
  });
  const period = periodOf(state.period);
  const periodSeconds = period.kind === 'recurring' ? period.length_seconds : null;
  const expiresAt = expiryOf(state, now);
  const carries = `${count(permissionCount, { one: 'explicit permission', many: 'explicit permissions' })}, ${limitsResetEvery(periodSeconds)}, ${expiresAt && Number.isNaN(Date.parse(expiresAt)) ? 'no end date yet' : expiresOn(expiresAt, now)}.`;

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

  /** A macro-action ticked, moved or unticked. Over edits it asks first; nothing is dropped silently. */
  function pickTrustLevel(
    connection: IssuanceConnection,
    cs: ConnectionState,
    setIndex: number,
    actionId: string,
    trustLevel: TrustLevel | null,
  ) {
    const set = cs.sets[setIndex];
    if (!set) return;
    if (discardsEdits(set)) {
      setPending({
        kind: 'trust-level',
        connectionId: connection.id,
        setIndex,
        actionId,
        trustLevel,
      });
      return;
    }
    patchConnection(
      connection.id,
      updateSet(connection, cs, setIndex, setMacroAction(connection, set, actionId, trustLevel)),
    );
  }
  function pickEverything(connection: IssuanceConnection, cs: ConnectionState, setIndex: number) {
    const set = cs.sets[setIndex];
    if (!set) return;
    if (discardsEdits(set)) {
      setPending({ kind: 'everything', connectionId: connection.id, setIndex });
      return;
    }
    patchConnection(
      connection.id,
      updateSet(connection, cs, setIndex, applyEverything(connection, set)),
    );
  }
  function confirmDiscard() {
    if (!pending) return;
    const connection = context.find((c) => c.id === pending.connectionId);
    const cs = connection ? state.connections[connection.id] : undefined;
    const set = cs?.sets[pending.setIndex];
    setPending(null);
    if (!connection || !cs || !set) return;
    const apply = (next: typeof set) =>
      patchConnection(connection.id, updateSet(connection, cs, pending.setIndex, next));
    if (pending.kind === 'reset') apply(resetEdits(connection, set));
    if (pending.kind === 'trust-level') {
      apply(setMacroAction(connection, set, pending.actionId, pending.trustLevel));
    }
    if (pending.kind === 'everything') apply(applyEverything(connection, set));
  }

  async function create() {
    const answer = await run('/api/missions', draftOf(context, state, new Date()), {
      errorOf: refusalOf,
    });
    const { body } = answer;
    const made = revealedOf(body);
    if (answer.status === 201 && isCreatedBody(body) && made) {
      setConfirming(false);
      setCreated({
        missionId: body.mission.id,
        name: body.mission.name,
        ...made,
        permissions: preview.policy.length,
        services: included.map(({ connection }) => connection.provider_label),
      });
    } else if (answer.status === 422 && isRefusedBody(body)) {
      setConfirming(false);
      setServerIssues(body.preview.issues);
    }
  }

  /** "Save changes": the edit, judged again by the server, applied at once. */
  async function save() {
    if (!edit) return;
    const answer = await run(
      `/api/missions/${encodeURIComponent(edit.missionId)}/edit`,
      { draft: editDraftOf(context, state, edit.snapshot, new Date()), revision: edit.revision },
      { errorOf: refusalOf },
    );
    if (answer.ok) {
      window.location.assign(`${ROUTES.missions}/${edit.missionId}?edited=1`);
      return;
    }
    if (answer.status === 422 && isIssuesBody(answer.body)) {
      setConfirming(false);
      setServerIssues(answer.body.issues);
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
    const answer = await run('/api/missions/preview', draft, {
      errorOf: (refused) => problemsOf(refused.body) ?? refused.message,
    });
    const { body } = answer;
    if (!answer.ok) return;
    if (!isPreviewBody(body)) {
      setError(problemsOf(body) ?? messageOf(body, answer.status));
      return;
    }
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
  }

  if (created)
    return <CreatedView created={created} period={periodSeconds} expiresAt={expiresAt} now={now} />;

  const crumbs = edit
    ? [
        { label: 'Missions', href: ROUTES.missions },
        { label: edit.snapshot.name, href: `${ROUTES.missions}/${edit.missionId}` },
        { label: MISSION_ACTIONS.editMission },
      ]
    : [{ label: 'Missions', href: ROUTES.missions }, { label: PAGES.newMission.title }];
  const title = edit
    ? `${MISSION_ACTIONS.editMission} “${edit.snapshot.name}”`
    : PAGES.newMission.title;
  const lede = edit ? MISSION_WORDS.editLede : PAGES.newMission.lede;
  const naming = {
    resource: (connectionId: string, resourceId: string) => {
      const found = context
        .find((c) => c.id === connectionId)
        ?.resources.find((r) => r.id === resourceId);
      return found ? found.display_name || found.ref : resourceId;
    },
    risk: (riskId: string) =>
      context.flatMap((c) => c.risks).find((r) => r.risk_id === riskId)?.label ?? riskId,
  };
  const lines = judgement && edit ? changeLines(judgement.changes, edit, naming) : [];

  if (context.length === 0) {
    return (
      <>
        <PageHeader crumbs={crumbs} title={title} lede={lede} />
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
      <PageHeader crumbs={crumbs} title={title} lede={lede} />

      {initial && !edit && (
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
          if (ready) setConfirming(true);
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
                    {edit ? 'Not saved' : 'Not created'}: {error}
                  </p>
                )}
              </CardBody>
              <CardFooter>
                <Button type="submit" variant="primary" size="lg" disabled={busy || !ready}>
                  {edit ? MISSION_ACTIONS.saveChanges : ACTIONS.createMission}
                </Button>
                <ButtonLink
                  href={edit ? `${ROUTES.missions}/${edit.missionId}` : ROUTES.missions}
                  variant="ghost"
                >
                  {ACTIONS.cancel}
                </ButtonLink>
                <span className={styles.railHint}>
                  {edit
                    ? changed
                      ? MISSION_WORDS.sameKeyAfterEdit
                      : MISSION_WORDS.nothingChangedYet
                    : MISSION_WORDS.keyAtTheEnd}
                </span>
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
              {!edit && missions.length > 0 && (
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
              {!edit && (
                <Button
                  type="button"
                  aria-expanded={proposalOpen}
                  onClick={() => setProposalOpen((o) => !o)}
                >
                  {MISSION_ACTIONS.pasteProposal}
                </Button>
              )}
            </div>
            {proposalOpen && !edit && (
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
                    placeholder='{"connections":[{"provider":"github","trust_levels":{"read":"careful","propose":"trusting"},"resources":{"scope":"selected","resource_refs":["acme/app"]}}]}'
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
              {context.map((connection) => {
                const cs = state.connections[connection.id] ?? initialConnectionState(connection);
                const name = `${connection.provider_label} ${connection.display_name}`;
                const several = cs.sets.length > 1;
                const first = cs.sets[0] ?? initialSetState(connection);
                // "N of M": M is "all resources" (neither hidden nor stale) plus
                // the hidden ones the person ticked on purpose.
                const total =
                  defaultResources(connection).length +
                  connection.resources.filter((r) => r.hidden && first.resourceIds.includes(r.id))
                    .length;
                const listedCount = connection.resources.length;
                const whole = first.resourceScope === 'connection';
                const selected = connection.resources.filter((r) =>
                  first.resourceIds.includes(r.id),
                );
                const envs = [...new Set(selected.flatMap((r) => (r.env ? [r.env] : [])))];
                // The expansion of "Everything I hold" is said by the macro-action panel, in its words.
                const notices = preview.notices.filter(
                  (n) =>
                    n.connection_id === connection.id && n.code !== 'everything-i-hold-expanded',
                );
                const setPatch = (index: number, next: SetState) =>
                  patchConnection(connection.id, updateSet(connection, cs, index, next));
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
                      {connection.status !== 'active' && (
                        <StatusMark tone="bad">{connection.status}</StatusMark>
                      )}
                      <span className={styles.accountResources}>
                        {!cs.included ? (
                          'not in this mission'
                        ) : several ? (
                          <span className={styles.resourceNames}>
                            {count(cs.sets.length, {
                              one: 'resource set',
                              many: 'resource sets',
                            })}
                          </span>
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
                                  ? `${first.resourceIds.length} known now`
                                  : `${first.resourceIds.length} of ${total}`}
                              </span>
                            )}
                            <Button
                              type="button"
                              size="sm"
                              aria-expanded={openResources.has(connection.id)}
                              aria-label={`${MISSION_ACTIONS.change} the resources of ${name}: ${
                                whole
                                  ? MISSION_WORDS.wholeAccount
                                  : `${first.resourceIds.length} of ${total} ${total === 1 ? 'resource' : 'resources'}`
                              }`}
                              onClick={() => toggleResources(connection.id)}
                            >
                              {MISSION_ACTIONS.change}
                            </Button>
                          </>
                        )}
                      </span>
                    </div>

                    {cs.included && !several && openResources.has(connection.id) && (
                      <div className={styles.resourceScope} data-testid="resource-scope">
                        <ChoiceRow legend={`Resources of ${name} the mission reaches`}>
                          {RESOURCE_CHOICES.map((choice) => (
                            <ChoiceChip
                              key={choice.id}
                              name={`resource-scope-${connection.id}`}
                              value={choice.id}
                              checked={first.resourceScope === choice.id}
                              onChange={() =>
                                setPatch(0, setResourceScope(connection, first, choice.id))
                              }
                              label={choice.label}
                              hint={choice.hint}
                            />
                          ))}
                        </ChoiceRow>
                        <p className={styles.quietText}>
                          {RESOURCE_CHOICES.find((c) => c.id === first.resourceScope)?.explanation}
                        </p>
                      </div>
                    )}

                    {cs.included &&
                      !several &&
                      openResources.has(connection.id) &&
                      first.resourceScope !== 'connection' &&
                      listedCount > 0 && (
                        <ResourcePicker
                          connection={connection}
                          state={cs}
                          index={0}
                          label={`Resources of ${name}`}
                          onChange={(ids) => setPatch(0, setResources(connection, first, ids))}
                        />
                      )}

                    {cs.included && (
                      <MacroActionPanel
                        connection={connection}
                        view={cs.view}
                        onView={(view) => patchConnection(connection.id, setView(cs, view))}
                      >
                        {several && (
                          <p className={styles.quietText} data-testid="resource-sets-explained">
                            {RESOURCE_SET_WORDS.explanation}
                          </p>
                        )}
                        {cs.sets.map((set, index) => (
                          <div
                            key={set.id ?? `new-${index}`}
                            className={several ? styles.resourceSet : undefined}
                            data-testid={
                              several
                                ? `resource-set-${connection.provider}-${index + 1}`
                                : undefined
                            }
                          >
                            {several && (
                              <ResourceSetHead
                                connection={connection}
                                state={cs}
                                index={index}
                                onScope={(scope) =>
                                  setPatch(index, setResourceScope(connection, set, scope))
                                }
                                onResources={(ids) =>
                                  setPatch(index, setResources(connection, set, ids))
                                }
                                onRemove={() =>
                                  patchConnection(
                                    connection.id,
                                    removeResourceSet(connection, cs, index),
                                  )
                                }
                              />
                            )}
                            <SetPolicy
                              connection={connection}
                              state={set}
                              view={cs.view}
                              setIndex={index}
                              onTrustLevel={(actionId, trustLevel) =>
                                pickTrustLevel(connection, cs, index, actionId, trustLevel)
                              }
                              onEverything={() => pickEverything(connection, cs, index)}
                              onLeaveEverything={() =>
                                setPatch(
                                  index,
                                  applyTrustLevels(connection, { ...set, trustLevels: {} }),
                                )
                              }
                              advanced={
                                <CustomEditor
                                  connection={connection}
                                  state={set}
                                  setIndex={index}
                                  planes={planes[connection.provider] ?? null}
                                  limitLabel={limitColumn(periodSeconds)}
                                  onChange={(next) => setPatch(index, next)}
                                  onReset={
                                    set.edited &&
                                    (set.everything || Object.keys(set.trustLevels).length > 0)
                                      ? () =>
                                          setPending({
                                            kind: 'reset',
                                            connectionId: connection.id,
                                            setIndex: index,
                                          })
                                      : null
                                  }
                                />
                              }
                            />
                          </div>
                        ))}
                        {setsOffered(connection) && (
                          <button
                            type="button"
                            className={styles.addResourceSet}
                            onClick={() =>
                              patchConnection(connection.id, addResourceSet(connection, cs))
                            }
                          >
                            {RESOURCE_SET_WORDS.add}
                          </button>
                        )}
                      </MacroActionPanel>
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
                  </div>
                );
              })}
            </div>
          </FormStep>

          <FormStep
            n={3}
            title="Limits and lifetime"
            hint={
              edit
                ? MISSION_WORDS.periodFixed
                : 'Limits that reset every day suit an agent that works every day.'
            }
          >
            <FormColumns>
              <Field label="Limits reset" htmlFor="mission-period">
                <Select
                  id="mission-period"
                  value={state.period}
                  disabled={edit !== null}
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
                  {EXPIRY_CHOICES.filter((x) => edit !== null || x.id !== 'keep').map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.id === 'keep'
                        ? `${x.label} · ${expiresOn(state.keptExpiry ?? null, now)}`
                        : x.days === null
                          ? x.label
                          : `${x.label} · ${shortDate(new Date(now.getTime() + x.days * MS_PER_DAY), now)}`}
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

      {edit && (
        <Dialog
          open={confirming}
          onClose={() => setConfirming(false)}
          width="lg"
          divided
          dismissible={!busy}
          title={`Save the changes to “${edit.snapshot.name}”?`}
          description={<>{MISSION_WORDS.editConfirm}</>}
          hint={WAITING.recorded}
          testId="confirm-edit"
          footer={
            <>
              <Button type="button" variant="primary" loading={busy} onClick={() => void save()}>
                {busy ? 'Saving…' : MISSION_ACTIONS.saveChanges}
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
          <ul className={styles.issueList} data-testid="edit-changes">
            {lines.map((line, index) => (
              <li key={`${line.section}:${index}`} data-warn={line.warn ? 'true' : undefined}>
                <strong>{line.section}</strong> · {line.text}
                {line.consequence && (
                  <span className={line.warn ? styles.railRefused : styles.quietText}>
                    {' '}
                    — {line.consequence}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {error && confirming && (
            <p className={styles.railRefused} role="alert">
              Not saved: {error}
            </p>
          )}
        </Dialog>
      )}

      <Dialog
        open={confirming && edit === null}
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
            ? 'The permissions, limits and "ask me first" you changed on this account go back to what the trust levels write.'
            : pending?.kind === 'everything'
              ? 'Everything you hold on this account replaces the permissions, limits and "ask me first" you changed there.'
              : 'The trust levels write this account\'s list again: the permissions, limits and "ask me first" you changed there are dropped.'
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

/** An edit refused for its draft (422) lists the issues the form shows beside its lines. */
function isIssuesBody(body: unknown): body is { issues: readonly PreviewIssue[] } {
  return (
    isRecord(body) &&
    Array.isArray(body.issues) &&
    body.issues.every((issue) => isRecord(issue) && typeof issue.message === 'string')
  );
}

/**
 * The error a refusal of the mission API shows: none for the 422 the form shows as
 * issues beside its lines, the problems of a refused draft, or the gateway's sentence.
 */
function refusalOf(answer: Extract<PostAnswer, { ok: false }>): string | null {
  if (answer.status === 422 && (isRefusedBody(answer.body) || isIssuesBody(answer.body))) {
    return null;
  }
  return problemsOf(answer.body) ?? answer.message;
}

/** The resources of an account to tick for one set; one another set picks is held there. */
function ResourcePicker({
  connection,
  state,
  index,
  label,
  onChange,
}: {
  connection: IssuanceConnection;
  state: ConnectionState;
  /** The set the ticks are for. */
  index: number;
  label: string;
  onChange: (resourceIds: readonly string[]) => void;
}) {
  const set = state.sets[index];
  if (!set) return null;
  return (
    <div className={styles.resources} role="group" aria-label={label}>
      {connection.resources.map((r) => {
        const holder = setOfResource(state, r.id);
        const elsewhere = holder !== null && holder !== index;
        return (
          <Checkbox
            key={r.id}
            checked={set.resourceIds.includes(r.id)}
            // Discovery no longer returns it, or it hosts this instance: never part of
            // a new mission. One another set holds is unticked there first.
            disabled={r.stale || r.self || elsewhere}
            aria-label={`Resource ${r.ref}`}
            onChange={(e) =>
              onChange(
                e.target.checked
                  ? [...set.resourceIds, r.id]
                  : set.resourceIds.filter((id) => id !== r.id),
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
              {elsewhere && holder !== null && <Tag>{RESOURCE_SET_WORDS.heldBy(holder + 1)}</Tag>}
            </span>
          </Checkbox>
        );
      })}
    </div>
  );
}

/**
 * The head of one resource set when an account has several (risk model §4.7): its
 * title, its scope, its resources when it picks them, and its removal.
 */
function ResourceSetHead({
  connection,
  state,
  index,
  onScope,
  onResources,
  onRemove,
}: {
  connection: IssuanceConnection;
  state: ConnectionState;
  index: number;
  onScope: (scope: ResourceChoice) => void;
  onResources: (resourceIds: readonly string[]) => void;
  onRemove: () => void;
}) {
  const set = state.sets[index];
  if (!set) return null;
  const title = RESOURCE_SET_WORDS.title(index + 1);
  const name = `${connection.provider_label} ${connection.display_name}`;
  const restTaken = state.sets.some((other, i) => i !== index && takesTheRest(other));
  const reached = connection.resources.filter((r) => set.resourceIds.includes(r.id));
  return (
    <>
      <div className={styles.resourceSetHead}>
        <span className={styles.resourceSetTitle}>{title}</span>
        <Select
          className={styles.resourceSetScope}
          value={set.resourceScope}
          aria-label={`${RESOURCE_SET_WORDS.scope} of ${title} of ${name}`}
          onChange={(e) => {
            const scope = RESOURCE_CHOICES.find((c) => c.id === e.target.value);
            if (scope) onScope(scope.id);
          }}
        >
          {RESOURCE_CHOICES.map((choice) => (
            <option
              key={choice.id}
              value={choice.id}
              disabled={choice.id !== 'selected' && restTaken}
              title={
                choice.id !== 'selected' && restTaken ? RESOURCE_SET_WORDS.restTaken : undefined
              }
            >
              {choice.label}
            </option>
          ))}
        </Select>
        <span className={styles.resourceNames}>
          {reached.length === 0
            ? 'No resource yet'
            : listed(
                reached.map((r) => r.display_name || r.ref),
                3,
              )}
        </span>
        <Button type="button" size="sm" variant="ghost" onClick={onRemove}>
          {RESOURCE_SET_WORDS.remove}
        </Button>
      </div>
      {takesTheRest(set) ? (
        <p className={styles.quietText}>{RESOURCE_SET_WORDS.rest}</p>
      ) : (
        <ResourcePicker
          connection={connection}
          state={state}
          index={index}
          label={`Resources of ${title} of ${name}`}
          onChange={onResources}
        />
      )}
    </>
  );
}

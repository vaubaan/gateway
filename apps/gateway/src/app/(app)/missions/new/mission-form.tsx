'use client';

/**
 * The mission screen (spec §4.2, §7.4, §7.4 bis): creating and editing are one
 * screen, which shows only the mission's cards.
 *
 *   - Above the cards: the name (or a copy of a mission, or a pasted agent's
 *     proposal), how often the limits reset, when the mission ends.
 *   - A card is one account and the resources of ONE environment (ADR
 *     resource-set-is-one-environment-with-optional-future-resources); "+ Add an
 *     account" picks the account, then its resources grouped by environment. Each
 *     macro-action of the card is ticked at a trust level, or Custom when its lines
 *     are edited one by one (`MissionCard`, `CustomModal`, `AccountPicker`).
 *   - A sticky bar says what changed (or what the mission holds) and saves.
 *
 * "Create mission" creates at once, with no confirmation (spec §4.2: only an irreversible act is
 * asked first): the draft carries the explicit lines, which are what is created — the trust levels
 * are kept only to redraw this screen. The decision shown is `previewDraft`, which the server runs
 * again on arrival; a 422 shows its issues beside the cards. Once created, the screen becomes the
 * key, shown once, with the kit (`KeyReveal`); the mission page shows the explicit list read-only.
 *
 * With `edit`, the same screen edits a mission after issuance (ADR
 * mission-editable-after-issuance): prefilled, its period fixed, its end date "as it
 * is", judged by `judgeEdit` (again by the server), and "Save changes" saves at once
 * and lands on the mission page with its "Saved" callout.
 */
import Link from 'next/link';
import { useMemo, useRef, useState } from 'react';

import {
  Button,
  ButtonLink,
  Callout,
  Field,
  Input,
  Mono,
  PageHeader,
  Row,
  Rows,
  Section,
  Select,
  ServiceMark,
  Textarea,
  type ServiceMarkIcon,
} from '@/components/ui';
import {
  DOC_PAGES,
  ACTIONS,
  CARD_WORDS,
  count,
  expiresOn,
  limitColumn,
  limitsResetEvery,
  listed,
  MISSION_ACTIONS,
  MISSION_WORDS,
  PAGES,
  ROUTES,
  shortDate,
  TERMS,
  TRUST_LEVEL_LABELS,
  TRUST_RAISE_WORDS,
  LOST_ACCOUNT_WORDS,
} from '@/lib/vocabulary';
import type { BootstrapKit } from '@/server/missions/bootstrap-kit';
import type {
  DraftPeriod,
  IssuanceAccount,
  MissionPreview,
  PreviewIssue,
  ResolvedDraftAccount,
} from '@/lib/missions/model';
import { hasChanges, judgeEdit } from '@/lib/missions/mission-edit';
import { previewDraft } from '@/lib/missions/preview';
import { TRUST_LEVELS } from '@/lib/missions/macro-actions';
import type { RiskPlanes } from '@/lib/services/planes';
import { MS_PER_DAY } from '@vaubaan/shared/time';

import { KeyReveal, revealedOf } from '../bootstrap-kit-view';
import { FirstCallWait } from '../first-call-wait';
import { messageOf } from '@/lib/http/message-of';
import { useAction, type PostAnswer } from '@/lib/http/post-json';
import styles from '../missions.styles';
import cardStyles from '../cards/cards.styles';
import { AccountPicker, type Picking } from '../cards/account-picker';
import { actionRows, cardDigest, changeSummary, levelMatching } from '../cards/card-model';
import { CustomModal } from '../cards/custom-modal';
import { LostAccountCard } from '../cards/lost-account-card';
import { MissionCard } from '../cards/mission-card';
import {
  addCard,
  applyCustom,
  cardsOf,
  draftOf,
  EXPIRY_CHOICES,
  expiryOf,
  initialFormState,
  issueSentence,
  loadResolved,
  newCard,
  PERIOD_CHOICES,
  periodChoiceOf,
  periodOf,
  removeCard,
  replaceCard,
  setActionLevel,
  setCardResources,
  type CardState,
  type ExpiryChoice,
  type FormState,
  type PeriodChoice,
} from './form-state';
import { editDraftOf, initialEditState, raisedEditState, type EditSource } from './edit-state';
import { isRecord } from '@vaubaan/shared/guards';

export interface InitialDraft {
  readonly name: string;
  readonly period: DraftPeriod;
  readonly resolved: readonly ResolvedDraftAccount[];
  /** What could not be carried over from the source (a permission no longer held, a vanished resource). */
  readonly issues: readonly PreviewIssue[];
  readonly sourceName: string;
  /** A copy of a mission, the platform management mission on a Vaubaan account, or an account's starter mission. */
  readonly origin: 'copy' | 'platform' | 'starter';
}

/** "Raise this limit" on the mission page: the edit opens on the Custom modal of a macro-action. */
export interface OpenCustom {
  readonly resourceSetId: string;
  readonly actionId: string;
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

function startState(context: readonly IssuanceAccount[], initial: InitialDraft | null): FormState {
  const blank = initialFormState();
  if (!initial) return blank;
  return {
    ...loadResolved(context, blank, initial.resolved),
    name: initial.name,
    period: periodChoiceOf(initial.period),
  };
}

/** The issues of one card: about its account and its place among the account's cards. */
function issuesOfCard(
  issues: readonly PreviewIssue[],
  state: FormState,
  card: CardState,
): PreviewIssue[] {
  const index = cardsOf(state, card.accountId).findIndex((c) => c.key === card.key);
  return issues.filter(
    (issue) =>
      issue.account_id === card.accountId &&
      (issue.resource_set_index === undefined ? index === 0 : issue.resource_set_index === index),
  );
}

export function MissionForm({
  context,
  missions,
  initial,
  planes,
  icons,
  edit = null,
  openCustom = null,
}: {
  context: readonly IssuanceAccount[];
  /** Per service id: the planes of its data model, for the services that have several. */
  planes: Readonly<Record<string, RiskPlanes>>;
  /** Per service id: its mark (`serviceIconOf`), `null` for a plugin that declares none. */
  icons: Readonly<Record<string, ServiceMarkIcon | null>>;
  missions: readonly { id: string; name: string }[];
  initial: InitialDraft | null;
  /** The mission this screen edits; `null` for a creation. */
  edit?: EditSource | null;
  /** The macro-action whose Custom modal the edit opens on. */
  openCustom?: OpenCustom | null;
}) {
  // "Raise" of a trust-raise proposal opens the edit at the new level (risk model §4.7).
  const [opening] = useState(() => {
    const start = edit ? initialEditState(context, edit.snapshot) : startState(context, initial);
    return edit?.raise
      ? raisedEditState(context, start, edit.raise)
      : { state: start, replaced: [] as readonly string[] };
  });
  const [state, setState] = useState<FormState>(opening.state);
  const [picking, setPicking] = useState<Picking | null>(null);
  const [custom, setCustom] = useState<{ cardKey: string; actionId: string } | null>(() => {
    const card = openCustom
      ? opening.state.cards.find((c) => c.id === openCustom.resourceSetId)
      : undefined;
    return card && openCustom ? { cardKey: card.key, actionId: openCustom.actionId } : null;
  });
  const nextKey = useRef(0);
  const [now] = useState(() => new Date());
  const { busy, error, setError, run } = useAction();
  const [serverIssues, setServerIssues] = useState<readonly PreviewIssue[]>([]);
  const [created, setCreated] = useState<Created | null>(null);
  const [proposalOpen, setProposalOpen] = useState(false);
  const [proposalText, setProposalText] = useState('');
  const [proposalReport, setProposalReport] = useState<MissionPreview | null>(null);
  // "Remove from mission" on a lost account's card: left out of the draft when saved.
  const [removedLost, setRemovedLost] = useState<ReadonlySet<string>>(() => new Set());
  const lostCards = (edit?.lost ?? []).filter(
    (lost) => !context.some((c) => c.id === lost.account_id),
  );

  const preview = useMemo(
    () => previewDraft({ accounts: context, now }, draftOf(context, state, now)),
    [context, state, now],
  );
  // An edit is judged on what it moves, against the mission as it stands.
  const judgement = useMemo(
    () =>
      edit
        ? judgeEdit(
            { accounts: context, now },
            edit.snapshot,
            editDraftOf(context, state, edit.snapshot, now, removedLost),
          )
        : null,
    [context, state, now, edit, removedLost],
  );
  const changed = judgement ? hasChanges(judgement.changes) : false;
  const issues = serverIssues.length > 0 ? serverIssues : (judgement?.issues ?? preview.issues);
  const ready = judgement ? judgement.ok && changed : preview.ok;
  const period = periodOf(state.period);
  const periodSeconds = period.kind === 'recurring' ? period.length_seconds : null;
  const expiresAt = expiryOf(state, now);
  const limitLabel = limitColumn(periodSeconds);
  const accountOf = (card: CardState) => context.find((c) => c.id === card.accountId);

  function patch(next: Partial<FormState>) {
    setServerIssues([]);
    setState((s) => ({ ...s, ...next }));
  }
  function update(change: (s: FormState) => FormState) {
    setServerIssues([]);
    setState(change);
  }
  function patchCard(card: CardState, change: (account: IssuanceAccount) => CardState) {
    const account = accountOf(card);
    if (!account) return;
    update((s) => replaceCard(s, change(account)));
  }

  async function create() {
    const answer = await run('/api/missions', draftOf(context, state, new Date()), {
      errorOf: refusalOf,
    });
    const { body } = answer;
    const made = revealedOf(body);
    if (answer.status === 201 && isCreatedBody(body) && made) {
      setCreated({
        missionId: body.mission.id,
        name: body.mission.name,
        ...made,
        permissions: preview.policy.length,
        services: [...new Set(state.cards.flatMap((card) => accountOf(card)?.service_label ?? []))],
      });
    } else if (answer.status === 422 && isRefusedBody(body)) {
      setServerIssues(body.preview.issues);
    }
  }

  /** "Save changes": the edit, judged again by the server, applied at once. */
  async function save() {
    if (!edit) return;
    const answer = await run(
      `/api/missions/${encodeURIComponent(edit.missionId)}/edit`,
      {
        draft: editDraftOf(context, state, edit.snapshot, new Date(), removedLost),
        revision: edit.revision,
      },
      { errorOf: refusalOf },
    );
    if (answer.ok) {
      window.location.assign(`${ROUTES.missions}/${edit.missionId}?edited=1`);
      return;
    }
    if (answer.status === 422 && isIssuesBody(answer.body)) {
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
      // expected: the pasted proposal is the person's text; not JSON is said to them
      setError('The proposal is not valid JSON.');
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      setError('The proposal must be a JSON object with a "accounts" list.');
      return;
    }
    const proposal = parsed as Record<string, unknown>;
    // A proposal may be a whole draft or only its accounts: the rest comes from the form.
    const draft = {
      name: typeof proposal.name === 'string' ? proposal.name : state.name,
      accounts: proposal.accounts ?? [],
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
    const loaded = loadResolved(context, initialFormState(), body.preview.resolved);
    setState({
      ...loaded,
      name: body.preview.name || state.name,
      period: periodChoiceOf(body.preview.period),
      expiry: body.preview.expires_at ? 'custom' : 'never',
      expiryCustom: body.preview.expires_at ? toLocalInput(body.preview.expires_at) : '',
    });
    setServerIssues([]);
    setProposalReport(body.preview);
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
  const doc = edit ? DOC_PAGES.editMission : DOC_PAGES.newMission;

  if (context.length === 0) {
    return (
      <>
        <PageHeader crumbs={crumbs} title={title} lede={lede} doc={doc} />
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

  const phrases = edit
    ? [
        ...lostCards
          .filter((lost) => removedLost.has(lost.account_id))
          .map((lost) =>
            LOST_ACCOUNT_WORDS.removed(
              lost.display_name === null
                ? lost.service_label
                : `${lost.service_label} · ${lost.display_name}`,
            ),
          ),
        ...changeSummary(context, opening.state, state, {
          before: edit.snapshot.expires_at,
          after: expiresAt,
        }),
      ]
    : [];
  function toggleRemoved(accountId: string) {
    setServerIssues([]);
    setRemovedLost((was) => {
      const next = new Set(was);
      if (!next.delete(accountId)) next.add(accountId);
      return next;
    });
  }
  const digest = state.cards.reduce(
    (sum, card) => {
      const account = accountOf(card);
      if (!account) return sum;
      const d = cardDigest(actionRows(account, card));
      return { total: sum.total + d.total, free: sum.free + d.free, asks: sum.asks + d.asks };
    },
    { total: 0, free: 0, asks: 0 },
  );
  const cardKeys = new Set(state.cards.map((c) => c.accountId));
  const loose = issues.filter((i) => i.account_id === undefined || !cardKeys.has(i.account_id));
  const customCard = custom ? state.cards.find((c) => c.key === custom.cardKey) : undefined;
  const customAccount = customCard ? accountOf(customCard) : undefined;

  return (
    <>
      <PageHeader crumbs={crumbs} title={title} lede={lede} doc={doc} />

      {edit?.raise && (
        <div className={styles.block}>
          <Callout
            tone="info"
            title={TRUST_RAISE_WORDS.editTitle(
              edit.raise.label,
              TRUST_LEVEL_LABELS[edit.raise.from],
              TRUST_LEVEL_LABELS[edit.raise.to],
              edit.raise.where,
            )}
            testId="raising"
          >
            <p>{TRUST_RAISE_WORDS.editLede}</p>
            {opening.replaced.length > 0 && (
              <>
                <p>{TRUST_RAISE_WORDS.replaced}</p>
                <ul className={styles.issueList} data-testid="raising-replaced">
                  {opening.replaced.map((riskId) => (
                    <li key={riskId}>
                      <Mono>{riskId}</Mono>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Callout>
        </div>
      )}

      {state.split && state.split.length > 0 && (
        <div className={styles.block}>
          <Callout tone="warn" title={CARD_WORDS.splitTitle} testId="split-by-environment">
            {CARD_WORDS.splitBody}
          </Callout>
        </div>
      )}

      {initial && !edit && initial.origin === 'platform' && (
        <div className={styles.block}>
          <Callout tone="info" title="The platform management mission" testId="platform-mission">
            Your {initial.sourceName} account with every macro-action at Careful: the agent reads
            your setup freely and asks you before it prepares, re-keys or stops a mission. Change
            anything before you create it. A mission it prepares never holds a Vaubaan account.
          </Callout>
        </div>
      )}

      {initial && !edit && initial.origin === 'starter' && (
        <div className={styles.block}>
          <Callout
            tone={initial.issues.length > 0 ? 'warn' : 'info'}
            title="A mission to start with"
            testId="starter-mission"
          >
            Your {initial.sourceName} account, filled in for a first mission: the agent reads freely
            and waits for your yes before it writes, sends or deletes anything. What cannot be
            repaired is left out. Change anything, then create it.
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

      {initial && !edit && initial.origin === 'copy' && (
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
          if (!ready || busy) return;
          void (edit ? save() : create());
        }}
      >
        <div className={cardStyles.fields}>
          <Field label="Name" htmlFor="mission-name">
            <Input
              id="mission-name"
              value={state.name}
              onChange={(e) => patch({ name: e.target.value })}
              placeholder="What is this mission for? Ship the billing page"
              aria-label="Mission name"
              maxLength={120}
              autoFocus
            />
          </Field>
          <Field
            label="Limits reset"
            htmlFor="mission-period"
            hint={edit ? MISSION_WORDS.periodFixed : undefined}
          >
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
          <Field label="Ends" htmlFor="mission-expiry">
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
        </div>
        {state.expiry === 'custom' && (
          <div className={styles.expiryDate}>
            <Field label="Ends on" htmlFor="mission-expiry-date" shape="your local time">
              <Input
                id="mission-expiry-date"
                type="datetime-local"
                value={state.expiryCustom}
                onChange={(e) => patch({ expiryCustom: e.target.value })}
              />
            </Field>
          </div>
        )}

        {!edit && (
          <div className={cardStyles.startRow}>
            {missions.length > 0 && (
              <Select
                value=""
                className={styles.startFrom}
                aria-label="Start from one of your missions"
                onChange={(e) => {
                  // A full navigation: the screen starts again from the copy, not from this state.
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
        )}
        {proposalOpen && !edit && (
          <div className={styles.proposal}>
            <Field
              label="What the agent proposed"
              htmlFor="mission-proposal"
              shape="JSON, as its management tools print it"
              hint="Nothing is created: what you may allow fills the screen, the rest is listed."
            >
              <Textarea
                id="mission-proposal"
                mono
                value={proposalText}
                onChange={(e) => setProposalText(e.target.value)}
                aria-label="Agent proposal (JSON)"
                placeholder='{"accounts":[{"service":"github","trust_levels":{"read":"careful","propose":"trusting"},"resources":{"scope":"selected","resource_refs":["acme/app"]}}]}'
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
                title={`Loaded ${count(proposalReport.policy.length, TERMS.risk)} on ${count(proposalReport.accounts.length, TERMS.account)}`}
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

        <div className={cardStyles.cards} data-testid="cards">
          {lostCards.map((lost) => {
            const removing = removedLost.has(lost.account_id);
            return (
              <LostAccountCard
                key={`lost:${lost.account_id}`}
                lost={lost}
                icon={lost.icon}
                removing={removing}
                action={
                  <Button
                    type="button"
                    size="sm"
                    variant={removing ? 'secondary' : 'danger'}
                    onClick={() => toggleRemoved(lost.account_id)}
                    data-testid="remove-lost-account"
                  >
                    {removing ? LOST_ACCOUNT_WORDS.keep : LOST_ACCOUNT_WORDS.remove}
                  </Button>
                }
              />
            );
          })}
          {state.cards.length === 0 && <p className={styles.quiet}>{CARD_WORDS.nothingYet}</p>}
          {state.cards.map((card) => {
            const account = accountOf(card);
            if (!account) return null;
            return (
              <MissionCard
                key={card.key}
                account={account}
                card={card}
                icon={icons[account.service] ?? null}
                planes={planes[account.service] ?? null}
                limitLabel={limitLabel}
                issues={issuesOfCard(issues, state, card).map((i) => issueSentence(i, context))}
                onLevel={(actionId, level) =>
                  patchCard(card, (c) => setActionLevel(c, card, actionId, level))
                }
                onCustom={(actionId) => setCustom({ cardKey: card.key, actionId })}
                onChange={() => setPicking({ kind: 'change', card })}
                onRemove={() => update((s) => removeCard(s, card.key))}
              />
            );
          })}
          <div className={cardStyles.addRow}>
            <Button
              type="button"
              disabled={context.length === 0}
              title={context.length === 0 ? CARD_WORDS.noAccountLeft : undefined}
              onClick={() => setPicking({ kind: 'add' })}
              data-testid="add-account"
            >
              {CARD_WORDS.addAccount}
            </Button>
            <span className={cardStyles.marks} aria-hidden="true">
              {[...new Map(context.map((c) => [c.service, c])).values()].map((c) => (
                <ServiceMark
                  key={c.service}
                  name={c.service_label}
                  icon={icons[c.service] ?? null}
                />
              ))}
            </span>
          </div>
        </div>

        <div className={cardStyles.bar} data-testid="summary-bar">
          <div className={cardStyles.barText}>
            <span data-testid="summary">
              {edit
                ? phrases.length === 0
                  ? MISSION_WORDS.nothingChangedYet
                  : `${CARD_WORDS.changes(phrases.length)}: ${listed(phrases, 4)}`
                : CARD_WORDS.creationSummary(
                    state.cards.length,
                    digest.total,
                    digest.free,
                    digest.asks,
                  )}
            </span>
            {loose.length > 0 && (
              <ul className={cardStyles.barIssues} data-testid="issues">
                {loose.map((i) => (
                  <li key={`${i.code}:${i.message}`}>{issueSentence(i, context)}</li>
                ))}
              </ul>
            )}
            {issues.length > loose.length && (
              <span className={styles.quietText} data-testid="card-issue-count">
                {' '}
                · {count(issues.length - loose.length, { one: 'issue', many: 'issues' })} on the
                cards
              </span>
            )}
            {error && (
              <p className={styles.railRefused} role="alert" data-testid="create-error">
                {edit ? 'Not saved' : 'Not created'}: {error}
              </p>
            )}
          </div>
          <div className={cardStyles.barActions}>
            <ButtonLink
              href={edit ? `${ROUTES.missions}/${edit.missionId}` : ROUTES.missions}
              variant="ghost"
            >
              {ACTIONS.cancel}
            </ButtonLink>
            <Button
              type="submit"
              variant="primary"
              loading={busy}
              disabled={busy || !ready}
              data-testid="mission-submit"
            >
              {busy
                ? edit
                  ? 'Saving…'
                  : 'Creating…'
                : edit
                  ? MISSION_ACTIONS.saveChanges
                  : ACTIONS.createMission}
            </Button>
          </div>
        </div>
      </form>

      {picking && (
        <AccountPicker
          context={context}
          state={state}
          icons={icons}
          picking={picking}
          onCancel={() => setPicking(null)}
          onDone={(accountId, resources) => {
            const editing = picking.kind === 'change' ? picking.card : null;
            setPicking(null);
            if (editing) {
              patchCard(editing, (c) => setCardResources(c, editing, resources));
              return;
            }
            nextKey.current += 1;
            const key = `new-${nextKey.current}`;
            update((s) => addCard(s, newCard(accountId, key, resources)));
          }}
        />
      )}

      {customCard && customAccount && custom && (
        <CustomModal
          account={customAccount}
          card={customCard}
          actionId={custom.actionId}
          planes={planes[customAccount.service] ?? null}
          limitLabel={limitLabel}
          onCancel={() => setCustom(null)}
          onApply={(applied, from) => {
            setCustom(null);
            const kept = Object.values(applied).some((line) => line !== null);
            const level = kept
              ? levelMatching(customAccount, customCard, custom.actionId, applied, TRUST_LEVELS)
              : null;
            patchCard(customCard, (c) =>
              level
                ? setActionLevel(c, customCard, custom.actionId, level)
                : applyCustom(c, customCard, custom.actionId, applied, from),
            );
          }}
        />
      )}
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
        doc={DOC_PAGES.mission}
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
        <div className="mt-4">
          <FirstCallWait missionId={created.missionId} />
        </div>
      </Section>
      <Section title="Working with others?">
        <Rows>
          <Row
            title="Add a teammate"
            description="They sign in and generate their own key; every call they make is in their name. Same permissions, same limits."
            end={
              <ButtonLink href={`${missionPath}?add=teammate#keys`} size="sm">
                {ACTIONS.addTeammate}
              </ButtonLink>
            }
          />
          <Row
            title="Add a machine key"
            description="For CI or a shared machine that has no account. Named by you, revoked on its own."
            end={
              <ButtonLink href={`${missionPath}?add=machine#keys`} size="sm">
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

/** An edit refused for its draft (422) lists the issues the screen shows beside its cards. */
function isIssuesBody(body: unknown): body is { issues: readonly PreviewIssue[] } {
  return (
    isRecord(body) &&
    Array.isArray(body.issues) &&
    body.issues.every((issue) => isRecord(issue) && typeof issue.message === 'string')
  );
}

/**
 * The error a refusal of the mission API shows: none for the 422 the screen shows as
 * issues beside its cards, the problems of a refused draft, or the gateway's sentence.
 */
function refusalOf(answer: Extract<PostAnswer, { ok: false }>): string | null {
  if (answer.status === 422 && (isRefusedBody(answer.body) || isIssuesBody(answer.body))) {
    return null;
  }
  return problemsOf(answer.body) ?? answer.message;
}

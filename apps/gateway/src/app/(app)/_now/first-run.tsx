/**
 * The home of someone who created no mission yet: one paragraph that says what
 * the product is, the model drawn in five nodes, then the steps — the first
 * account, the first mission, the kit. An administrator also reads what is
 * left to set up on the gateway. What was shared with the person is listed:
 * a mission of a colleague is one key away.
 *
 * One primary action: the next thing to do.
 */
import Link from 'next/link';

import {
  ButtonLink,
  CheckMark,
  Lede,
  ModelDiagram,
  PageHeader,
  Row,
  Rows,
  Section,
  StepMark,
} from '@/components/ui';
import { ADMIN_PAGES } from '@/components/shell/settings-nav';
import {
  DOC_PAGES,
  ACTIONS,
  count,
  FIRST_RUN,
  PAGES,
  ROUTES,
  SECTIONS,
  TERMS,
} from '@/lib/vocabulary';
import type { NowView, SetupView } from '@/server/now';

import styles from './now.styles';

/** The checklist of an administrator; its open step (sign-in) takes the page's one accent. */
function Setup({ setup }: { setup: SetupView }) {
  return (
    <Section
      title={FIRST_RUN.setUp}
      note={
        <span className={styles.setupNote}>
          {FIRST_RUN.setUpNote} · also in <Link href={ROUTES.settings}>{PAGES.settings.title}</Link>
        </span>
      }
      testId="now-setup"
    >
      <Rows>
        <Row
          lead={<CheckMark state={setup.sign_in ? 'done' : 'todo'} />}
          title={setup.sign_in ? `Sign-in through ${setup.sign_in}` : 'Sign-in'}
          description={
            setup.sign_in
              ? 'People sign in with their company account; nobody has a password here.'
              : 'Connect the identity provider of your company, so that people sign in with their own account.'
          }
          end={
            setup.sign_in ? (
              FIRST_RUN.done
            ) : (
              <ButtonLink href={ADMIN_PAGES.signIn} size="sm" variant="primary">
                Set up sign-in
              </ButtonLink>
            )
          }
        />
        <Row
          lead={<CheckMark state={setup.telemetry.decided ? 'done' : 'todo'} />}
          title="Telemetry"
          description={
            setup.telemetry.enabled
              ? 'On: this gateway tells the project whether each plugin call succeeded, and nothing else.'
              : 'Off until you decide; the exact payload is shown first.'
          }
          end={
            <ButtonLink href={ADMIN_PAGES.telemetry} size="sm">
              Review
            </ButtonLink>
          }
        />
      </Rows>
    </Section>
  );
}

export function FirstRun({
  view,
  name,
  setup,
  starterAccountId = null,
}: {
  view: NowView;
  /** What to call the person; `null` when the identity provider gave no name. */
  name: string | null;
  /** The checklist, for an administrator; `null` for anyone else. */
  setup: SetupView | null;
  /** The account the first mission starts filled in for (spec §7.4); `null`: the blank form. */
  starterAccountId?: string | null;
}) {
  const [shared] = view.shared_accounts;
  const hasAccount = view.totals.accounts > 0 || shared !== undefined;
  const setupOpen = setup !== null && setup.sign_in === null;
  // One accent on the page: what is left to set up first, then the next step.
  const stepsTakeAccent = !setupOpen;
  return (
    <>
      <PageHeader
        doc={DOC_PAGES.now}
        title={FIRST_RUN.welcome(name)}
        lede={hasAccount ? FIRST_RUN.nothingYet : FIRST_RUN.nothingConnected}
      />
      <div className={styles.intro}>
        <Lede>
          Vaubaan lets your AI agents use your company’s cloud accounts without ever holding a
          credential. You give an agent a <b>mission</b> — what it may touch, what it may do, how
          much, what it must ask you first — and a <b>key</b>. Everything it does is recorded in{' '}
          <b>Activity</b>.
        </Lede>
        <ModelDiagram nodes={FIRST_RUN.model} label={FIRST_RUN.modelLabel} />
      </div>

      {setup && <Setup setup={setup} />}

      <Section
        title={setup ? FIRST_RUN.thenLikeEveryone : FIRST_RUN.getStarted}
        note={FIRST_RUN.fiveMinutes}
        testId="now-steps"
      >
        <Rows>
          <Row
            lead={<StepMark n={1} state={hasAccount ? 'done' : 'next'} />}
            title={hasAccount ? FIRST_RUN.steps.account.done : FIRST_RUN.steps.account.todo}
            description={
              hasAccount ? (
                view.totals.accounts > 0 ? (
                  `You own ${count(view.totals.accounts, TERMS.account)}.`
                ) : shared ? (
                  <>
                    {shared.owner} gave you access to <b>{shared.service}</b> · {shared.name} (
                    {count(shared.permissions, TERMS.risk)}). You can also{' '}
                    <Link href={`${ROUTES.accounts}/new`}>connect an account</Link> of your own.
                  </>
                ) : null
              ) : (
                FIRST_RUN.steps.account.todoText
              )
            }
            end={
              hasAccount ? (
                <ButtonLink href={ROUTES.accounts} size="sm">
                  {PAGES.accounts.title}
                </ButtonLink>
              ) : (
                <ButtonLink
                  href={`${ROUTES.accounts}/new`}
                  size="sm"
                  variant={stepsTakeAccent ? 'primary' : 'secondary'}
                >
                  {ACTIONS.connectAccount}
                </ButtonLink>
              )
            }
          />
          <Row
            lead={<StepMark n={2} state={hasAccount ? 'next' : 'later'} />}
            title={FIRST_RUN.steps.mission.title}
            description={FIRST_RUN.steps.mission.text}
            end={
              hasAccount ? (
                <ButtonLink
                  href={
                    starterAccountId
                      ? `${ROUTES.newMission}?account=${encodeURIComponent(starterAccountId)}`
                      : ROUTES.newMission
                  }
                  size="sm"
                  variant={stepsTakeAccent ? 'primary' : 'secondary'}
                >
                  {ACTIONS.newMission}
                </ButtonLink>
              ) : undefined
            }
          />
          <Row
            lead={<StepMark n={3} state="later" />}
            title={FIRST_RUN.steps.kit.title}
            description={FIRST_RUN.steps.kit.text}
          />
        </Rows>
      </Section>

      {view.shared_missions.length > 0 && (
        <Section
          title={SECTIONS.sharedWithYou}
          count={view.shared_missions.length}
          testId="now-shared-missions"
        >
          <Rows>
            {view.shared_missions.map((mission) => (
              <Row
                key={mission.id}
                title={mission.name}
                href={`${ROUTES.missions}/${mission.id}`}
                muted={!mission.running}
                description={
                  <>
                    {mission.creator} added you
                    {mission.services.length > 0 && ` · ${mission.services.join(' · ')}`}.{' '}
                    {mission.has_key
                      ? 'You hold a key of it.'
                      : `Generate your own key to work on it; ${mission.creator} never sees it.`}
                    {!mission.running && ' It is not running now.'}
                  </>
                }
                end={
                  <ButtonLink href={`${ROUTES.missions}/${mission.id}`} size="sm">
                    {mission.has_key ? FIRST_RUN.openMission : FIRST_RUN.getMyKey}
                  </ButtonLink>
                }
              />
            ))}
          </Rows>
        </Section>
      )}
    </>
  );
}

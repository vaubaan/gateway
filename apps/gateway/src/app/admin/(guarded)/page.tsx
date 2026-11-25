/**
 * `/admin` — Setup: what a gateway needs before colleagues use it, as a
 * checklist that says what is done and what is left (spec §4.2
 * "Administration", §7.1), then who administers it and what the mounted
 * configuration holds.
 *
 * Each line is read from the service that owns the fact: sign-in from the
 * identity-provider settings, the
 * accounts without owner from `AccountService.listOwnerless`, the apps that
 * wait from the client registry, telemetry from its overview, the name from
 * `InstanceNameService`. Nothing is decided here.
 *
 * The one field of the page is the instance's name (spec §4.2, §4.3): saved
 * by `POST /api/admin/instance-name`, read-only when the mounted
 * configuration sets `instance_name` (the file wins).
 */
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { LocalDate } from '@/components/LocalDate';
import styles from '@/components/settings/settings.styles';
import {
  Avatar,
  Button,
  ButtonLink,
  Callout,
  Checkbox,
  CheckMark,
  ConfirmSubmit,
  Field,
  Hint,
  Input,
  KeyValue,
  Mono,
  PageHeader,
  Row,
  Rows,
  Section,
  type CheckState,
} from '@/components/ui';
import { ADMIN_PAGES } from '@/components/shell/settings-nav';
import { NoticeBanner } from '@/components/accounts/parts';
import { requireOperator } from '@/lib/auth/session';
import { takeNotice } from '@/lib/accounts/session';
import {
  DOC_PAGES,
  CONFIG_WORDS,
  CEILING_WORDS,
  count,
  SECTIONS,
  SETTINGS_ACTIONS,
  SETTINGS_PAGES,
  stepsDone,
  TERMS,
} from '@/lib/vocabulary';
import { isOperator, setUpElsewhere, type SignInProviderView } from '@/server/auth';
import { OWNERLESS_ACCOUNTS_PAGE } from '@/server/accounts';
import {
  INSTANCE_NAME_MAX_LENGTH,
  INSTANCE_NAME_PROBLEMS,
  issuerKey,
  type InstanceConfig,
} from '@/server/config';
import {
  INSTANCE_NAME_ACTION,
  INSTANCE_NAME_ANCHOR,
  NAME_FIELD,
  NAME_PROBLEM_PARAM,
  type InstanceNameProblem,
} from '@/server/instance';
import {
  CONFIRMED_FIELD,
  FROM_FIELD,
  HANDOVER_ANCHOR,
  KEY_PROBLEM_PARAM,
  MASTER_KEY_DOWNLOAD_ACTION,
  MASTER_KEY_FILE_NAME,
  MASTER_KEY_HANDOVER_ACTION,
  signedInFreshly,
  type MasterKeyProblem,
} from '@/server/master-key';

import { FIRST_ADMINISTRATOR_PAGE, FINISH_SETUP_ACTION, setupCannotFinish } from '@/server/users';

export const dynamic = 'force-dynamic';

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const NAME_PROBLEMS: Readonly<Record<InstanceNameProblem, string>> = {
  locked:
    'The mounted configuration sets instance_name; change it there. The name is read-only here.',
  invalid: 'The request carried no name.',
  empty: `The name ${INSTANCE_NAME_PROBLEMS.empty}.`,
  'too-long': `The name ${INSTANCE_NAME_PROBLEMS['too-long']}.`,
  'control-character': `The name ${INSTANCE_NAME_PROBLEMS['control-character']}.`,
};

function isNameProblem(value: unknown): value is InstanceNameProblem {
  return typeof value === 'string' && Object.hasOwn(NAME_PROBLEMS, value);
}

const KEY_PROBLEMS: Readonly<Record<MasterKeyProblem, string>> = {
  'sign-in-again': 'The key is handed over after a fresh sign-in only. Sign out and sign in again.',
  'not-confirmed':
    'Tick the box first: without the key, a backup of this gateway cannot be opened.',
};

function isKeyProblem(value: unknown): value is MasterKeyProblem {
  return typeof value === 'string' && Object.hasOwn(KEY_PROBLEMS, value);
}

interface Step {
  readonly key: string;
  readonly state: CheckState;
  /** What a partly done step shows in its mark: "2/3". */
  readonly partial?: string;
  readonly title: React.ReactNode;
  readonly description: React.ReactNode;
  /** The one thing left to do, when something is. */
  readonly action?: { readonly label: string; readonly href: string };
  /** Counted in "n of m done". A reminder that appears only when it needs someone is not. */
  readonly counted: boolean;
}

/** A sign-in provider set up for another address (a restore on a new host): one sentence, or nothing. */
function elsewhereWords(
  signInProviders: readonly Pick<SignInProviderView, 'name' | 'kind' | 'registeredFor'>[],
  publicUrl: URL,
): string {
  const moved = signInProviders.flatMap((signInProvider) => {
    const host = setUpElsewhere(signInProvider, publicUrl);
    return host ? [`${signInProvider.name} (set up for ${host})`] : [];
  });
  if (moved.length === 0) return '';
  return ` ${listOf(moved)} ${moved.length === 1 ? 'needs' : 'need'} this address registered at the sign-in provider before anyone signs in through ${moved.length === 1 ? 'it' : 'them'}.`;
}

function listOf(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The admin rule in words, with the emails it lists: an administrator may read their own rule. */
function ruleWords(admin: InstanceConfig['admin']): React.ReactNode {
  const parts: React.ReactNode[] = [];
  if (admin.group !== null) {
    parts.push(
      <span key="group">
        everyone in the group <Mono>{admin.group}</Mono> of its sign-in provider
      </span>,
    );
  }
  if (admin.emails.length > 0) {
    parts.push(
      <span key="emails">
        {admin.group !== null ? ', and ' : ''}the listed{' '}
        {admin.emails.length === 1 ? 'email' : 'emails'}{' '}
        {admin.emails.map((email, index) => (
          <span key={email}>
            {index > 0 && ', '}
            <Mono>{email}</Mono>
          </span>
        ))}
      </span>,
    );
  }
  return parts.length > 0 ? parts : 'no rule: administrators are named in this gateway';
}

export default async function SetupPage({ searchParams }: Props) {
  const { root, principal } = await requireOperator();
  // A local instance's setup is two screens of its own (`/welcome`), not this checklist.
  if (root.config.local && principal.kind === 'bootstrap') redirect('/welcome');
  const params = await searchParams;
  // What the act the administrator just made did (the first administrator's account, for one).
  const notice = await takeNotice(root, principal.sessionId, params);
  const nameProblem = isNameProblem(params[NAME_PROBLEM_PARAM]) ? params[NAME_PROBLEM_PARAM] : null;
  const keyProblem = isKeyProblem(params[KEY_PROBLEM_PARAM]) ? params[KEY_PROBLEM_PARAM] : null;
  const [signInProviders, rule, bootstrap, ownerless, telemetry, users, identity, key, ceilings] =
    await Promise.all([
      root.auth.signInProviders.views(),
      root.auth.administrators.current(),
      root.auth.bootstrap.state(),
      root.accounts.service.listOwnerless(),
      root.telemetry.overview(),
      root.users.service.list(),
      root.instance.name.identity(),
      root.masterKey.service.state(),
      root.limits.usage(),
    ]);
  // The handover step (below) is the one thing to do while it is pending: every other
  // action of the checklist waits for it (ADR master-key-generated-and-handed-over-by-the-instance).
  const handover = key.handoverPending;
  const fresh =
    handover && (await signedInFreshly(root.auth.sessions, await headers(), new Date()));

  const administrators = users.filter(
    (view) =>
      view.user.status === 'active' &&
      isOperator(
        {
          id: view.user.id,
          email: view.user.email,
          signInProviderId:
            signInProviders.find(
              (p) =>
                view.user.issuer !== null && issuerKey(p.issuer) === issuerKey(view.user.issuer),
            )?.id ?? null,
          groups: view.groupRecords,
        },
        rule,
      ),
  );
  const host = root.config.publicUrl.host;
  // Sign-in accounts: the setup creates the first administrator's account, for any address,
  // and names them administrator (ADR administrators-live-in-the-instance, §4).
  const local = signInProviders.find((signInProvider) => signInProvider.kind === 'local') ?? null;
  const firstAdministrator: 'done' | 'todo' | null =
    local && bootstrap.status === 'active' ? (rule.userIds.size > 0 ? 'done' : 'todo') : null;
  const drift = await root.auth.administrators.configurationDrift();
  // The setup ends by its own step (ADR administrators-live-in-the-instance, §8).
  const finishProblem =
    bootstrap.status === 'active'
      ? await setupCannotFinish({
          administrators: root.auth.administrators,
          masterKey: root.masterKey.service,
        })
      : null;

  const steps: Step[] = [
    ...(key.generatedAt !== null
      ? [
          {
            key: 'encryption-key',
            counted: true,
            state: (handover ? 'todo' : 'done') as CheckState,
            title: 'Your encryption key',
            description: handover
              ? 'This gateway generated its encryption key at its first start. Download it and keep it in a safe place before anything else: without it, a backup of this gateway cannot be opened.'
              : 'Generated by this gateway at its first start; an administrator confirmed keeping a copy.',
            action: handover
              ? { label: 'Download the key', href: `#${HANDOVER_ANCHOR}` }
              : undefined,
          },
        ]
      : []),
    {
      key: 'sign-in',
      counted: true,
      state: signInProviders.some((signInProvider) => signInProvider.enabled) ? 'done' : 'todo',
      title:
        signInProviders.length > 0
          ? `Sign-in through ${listOf(signInProviders.map((signInProvider) => signInProvider.name))}`
          : 'Sign-in',
      description:
        signInProviders.length > 0
          ? `People sign in through these sign-in providers; teams come from your directory. No password is stored here.${elsewhereWords(signInProviders, root.config.publicUrl)}`
          : 'Nobody can sign in yet: add your company’s directory (OpenID Connect) or GitHub.',
      action:
        signInProviders.length > 0
          ? undefined
          : { label: 'Set up sign-in', href: ADMIN_PAGES.signIn },
    },
    {
      key: 'address',
      counted: true,
      state: 'done',
      title: (
        <>
          Public address · <Mono>{host}</Mono>
        </>
      ),
      description: 'What agents and the setup kit point at.',
    },
    ...(firstAdministrator !== null
      ? [
          {
            key: 'first-administrator',
            counted: true,
            state: firstAdministrator as CheckState,
            title: 'The first administrator’s account',
            description:
              firstAdministrator === 'done'
                ? 'An administrator is named. Its first sign-in sets the second factor up; then finish the setup.'
                : 'Sign-in accounts are set up: create the first administrator’s account, then sign in with it.',
            action:
              firstAdministrator === 'todo'
                ? { label: 'Create the account', href: FIRST_ADMINISTRATOR_PAGE }
                : undefined,
          },
        ]
      : []),
    {
      key: 'administrators',
      counted: true,
      state: administrators.length > 0 || bootstrap.status !== 'active' ? 'done' : 'todo',
      title: SECTIONS.administrators,
      description:
        administrators.length > 0
          ? `${listOf(administrators.map((view) => view.user.displayName ?? view.user.email))}.`
          : 'Nobody named administrator has signed in yet.',
    },
    ...(bootstrap.status === 'active'
      ? [
          {
            key: 'finish-setup',
            counted: true,
            state: 'todo' as CheckState,
            title: 'Finish the setup',
            description:
              finishProblem ??
              'An administrator can sign in: finish the setup to retire the install token.',
            action: finishProblem ? undefined : { label: 'Finish setup', href: '#finish-setup' },
          },
        ]
      : []),
    ...(ownerless.length > 0
      ? [
          {
            key: 'ownerless',
            counted: false,
            state: 'todo' as const,
            title: SETTINGS_PAGES.ownerless.title,
            description: `${count(ownerless.length, TERMS.account)} ${ownerless.length === 1 ? 'has' : 'have'} no owner left: nobody can reconnect ${ownerless.length === 1 ? 'it' : 'them'} or give access.`,
            action: { label: SETTINGS_ACTIONS.nameOwner, href: OWNERLESS_ACCOUNTS_PAGE },
          },
        ]
      : []),
    {
      key: 'telemetry',
      counted: true,
      state: telemetry.state.enabled ? 'done' : 'todo',
      title: SETTINGS_PAGES.telemetry.title,
      description: telemetry.state.enabled
        ? 'On: this gateway tells the project whether each plugin call succeeded, and nothing else.'
        : 'Off. Anonymous plugin reports help the project; nothing is sent until you turn it on, and the exact payload is shown first.',
      action: telemetry.state.enabled
        ? undefined
        : { label: 'Review', href: ADMIN_PAGES.telemetry },
    },
  ];
  const counted = steps.filter((step) => step.counted);
  const done = counted.filter((step) => step.state === 'done').length;
  // The one primary action of the page: the first thing a fresh install still needs.
  const next = steps.find((step) => step.counted && step.state !== 'done' && step.action);

  return (
    <>
      <PageHeader
        doc={DOC_PAGES.setup}
        title={SETTINGS_PAGES.setup.title}
        lede={SETTINGS_PAGES.setup.lede}
      />
      <NoticeBanner notice={notice} />

      <Section
        title="What a fresh install needs"
        note={stepsDone(done, counted.length)}
        first
        testId="setup-checklist"
      >
        <Rows>
          {steps.map((step) => (
            <Row
              key={step.key}
              testId={`setup-${step.key}`}
              lead={<CheckMark state={step.state} partial={step.partial} />}
              title={step.title}
              description={step.description}
              end={
                step.action && (!handover || step.key === 'encryption-key') ? (
                  <ButtonLink
                    href={step.action.href}
                    size="sm"
                    variant={step.key === next?.key ? 'primary' : 'secondary'}
                  >
                    {step.action.label}
                  </ButtonLink>
                ) : step.state === 'done' ? (
                  'done'
                ) : step.action ? (
                  'after the key'
                ) : undefined
              }
            />
          ))}
        </Rows>
      </Section>

      {handover && (
        <Section
          title="Download your encryption key"
          id={HANDOVER_ANCHOR}
          testId="master-key-handover"
        >
          {keyProblem && (
            <div className={styles.notes}>
              <Callout tone="bad" title="Not done" testId="master-key-problem">
                {KEY_PROBLEMS[keyProblem]}
              </Callout>
            </div>
          )}
          <Hint>
            Every account credential this gateway stores is sealed with a key derived from this one.
            It lives on the data volume{key.file ? ' (' : ''}
            {key.file && <Mono>{key.file}</Mono>}
            {key.file ? ')' : ''}; a backup of the store opens with it only. Keep the file outside
            this host, with your other secrets. The download is recorded in the activity, with your
            name; the key itself is shown nowhere.
          </Hint>
          {fresh ? (
            <form method="post" action={MASTER_KEY_DOWNLOAD_ACTION} className={styles.lineForm}>
              <input type="hidden" name={FROM_FIELD} value="setup" readOnly />
              <Button type="submit" variant="primary" data-testid="master-key-download">
                Download the key
              </Button>
              <span className={styles.formHint}>
                <Mono>{MASTER_KEY_FILE_NAME}</Mono>
              </span>
            </form>
          ) : (
            <Callout tone="neutral" title="Sign in again first" testId="master-key-sign-in-again">
              The key is handed over after a fresh sign-in only. Sign out, sign in again and come
              back here.
              <form method="post" action="/logout" className={styles.inlineForm}>
                <Button type="submit" size="sm">
                  Sign out
                </Button>
              </form>
            </Callout>
          )}
          <form method="post" action={MASTER_KEY_HANDOVER_ACTION} className={styles.form}>
            <Checkbox name={CONFIRMED_FIELD} required data-testid="master-key-kept">
              I kept it in a safe place — without it a backup of this gateway cannot be opened.
            </Checkbox>
            <div className={styles.formActions}>
              <Button type="submit" variant="primary" data-testid="master-key-continue">
                Continue
              </Button>
            </div>
          </form>
        </Section>
      )}

      {bootstrap.status === 'active' && (
        <Section title="Finish the setup" id="finish-setup" testId="finish-setup">
          <Hint>
            {finishProblem ??
              'The install token and the setup link stop opening anything. Do it once an administrator has signed in, or can.'}
          </Hint>
          {!finishProblem && (
            <ConfirmSubmit
              action={FINISH_SETUP_ACTION}
              label="Finish setup"
              ariaLabel="Finish the setup"
              variant="primary"
              title="Finish the setup?"
              consequence="The install token and the setup link stop working for good. From then on people sign in through the sign-in providers that are on; a lost way in is recovered with the master key."
              confirmLabel="Finish setup"
              testId="finish-setup-button"
            />
          )}
        </Section>
      )}

      <Section
        title={SECTIONS.administrators}
        note="Named in this gateway, under People. The configuration's rule names them once, at the first start, and never again by itself."
        id="administrators"
        testId="administrators"
      >
        <KeyValue
          items={[
            {
              term: 'In the configuration',
              value: (
                <>
                  {ruleWords(root.config.admin)}
                  {drift && (
                    <span className={styles.sub} data-testid="admin-rule-drift-setup">
                      Not what was applied: it does not apply by itself. Apply it from People if you
                      mean it.
                    </span>
                  )}
                </>
              ),
            },
            {
              term: 'Today',
              value:
                administrators.length === 0 ? (
                  <span className={styles.quiet}>no administrator has signed in yet</span>
                ) : (
                  <span className={styles.inline}>
                    {administrators.map((view) => (
                      <span key={view.user.id} className={styles.inline}>
                        <Avatar name={view.user.displayName ?? view.user.email} size="xs" />
                        {view.user.displayName ?? view.user.email}
                      </span>
                    ))}
                  </span>
                ),
            },
            {
              term: 'Can',
              value:
                'Configure this gateway, read the whole activity, deactivate a person, and name a new owner for an account whose owners left. Cannot read a key, use an account, or answer someone else’s requests.',
            },
            {
              term: 'Install token',
              value:
                bootstrap.status === 'active' ? (
                  'Still valid: it is revoked when the setup is finished, below.'
                ) : bootstrap.status === 'revoked' ? (
                  <>
                    Revoked on <LocalDate ts={bootstrap.revokedAt} dateOnly />, when the setup
                    ended. Nothing to do.
                  </>
                ) : (
                  'None was configured.'
                ),
            },
          ]}
        />
      </Section>

      <Section
        title="Name"
        note={identity.source === 'config' ? CONFIG_WORDS.fileReadOnly : undefined}
        id={INSTANCE_NAME_ANCHOR}
        testId="instance-name-section"
      >
        {nameProblem && (
          <div className={styles.notes}>
            <Callout tone="bad" title="Not changed" testId="instance-name-problem">
              {NAME_PROBLEMS[nameProblem]}
            </Callout>
          </div>
        )}
        {identity.source === 'config' ? (
          <KeyValue items={[{ term: 'Name', value: identity.label }]} />
        ) : (
          <form method="post" action={INSTANCE_NAME_ACTION} className={styles.lineForm}>
            <Field
              label="Name of this gateway"
              shape={`up to ${INSTANCE_NAME_MAX_LENGTH} characters`}
              optional
              htmlFor="instance-name-field"
            >
              <Input
                id="instance-name-field"
                name={NAME_FIELD}
                defaultValue={identity.name ?? ''}
                placeholder={identity.host}
                maxLength={INSTANCE_NAME_MAX_LENGTH}
                autoComplete="off"
              />
            </Field>
            <Button type="submit">{SETTINGS_ACTIONS.save}</Button>
          </form>
        )}
        <Hint>
          Shown at the top of the navigation and in the browser tab, so that someone with several
          gateways open can tell them apart; the address stays in its tooltip.
          {identity.source !== 'config' && (
            <>
              {' '}
              Leave it blank to show the address instead: <Mono>{identity.host}</Mono>.
            </>
          )}
        </Hint>
      </Section>

      <Section title="This gateway" note={CONFIG_WORDS.fileReadOnly} id="gateway">
        <KeyValue
          items={[
            { term: 'Public address', value: <Mono>{root.config.publicUrl.href}</Mono> },
            ...ceilings.map((usage) => ({
              term: CEILING_WORDS.labels[usage.ceiling],
              value: CEILING_WORDS.usage(usage.count, usage.limit),
            })),
            {
              term: 'Activity kept',
              value: `${count(root.config.retentionDays, { one: 'day', many: 'days' })}, then deleted`,
            },
            {
              term: 'Version',
              value: (
                <Mono>
                  {root.build.version} · {root.build.commit}
                </Mono>
              ),
            },
          ]}
        />
      </Section>
    </>
  );
}

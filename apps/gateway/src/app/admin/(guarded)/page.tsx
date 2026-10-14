/**
 * `/admin` — Setup: what a gateway needs before colleagues use it, as a
 * checklist that says what is done and what is left (spec §4.2
 * "Administration", §7.1), then who administers it and what the mounted
 * configuration holds.
 *
 * Each line is read from the service that owns the fact: sign-in from the
 * identity-provider settings, company apps from `ProviderAppsService`, the
 * accounts without owner from `ConnectionService.listOwnerless`, the apps that
 * wait from the client registry, telemetry from its overview. Nothing is
 * decided here.
 */
import { LocalDate } from '@/components/LocalDate';
import styles from '@/components/settings/settings.module.css';
import {
  Avatar,
  ButtonLink,
  CheckMark,
  KeyValue,
  Mono,
  PageHeader,
  Row,
  Rows,
  Section,
  type CheckState,
} from '@/components/ui';
import { ADMIN_PAGES } from '@/components/shell/settings-nav';
import { requireOperator } from '@/lib/auth/session';
import {
  CONFIG_WORDS,
  count,
  formatNumber,
  SECTIONS,
  SETTINGS_ACTIONS,
  SETTINGS_PAGES,
  stepsDone,
  TERMS,
} from '@/lib/vocabulary';
import { isOperator } from '@/server/auth';
import type { InstanceConfig } from '@/server/config';

export const dynamic = 'force-dynamic';

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
        everyone in the identity-provider group <Mono>{admin.group}</Mono>
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
  return parts.length > 0 ? parts : 'nobody: no rule is set';
}

export default async function SetupPage() {
  const { root } = await requireOperator();
  const [idp, bootstrap, apps, ownerless, clients, telemetry, users] = await Promise.all([
    root.auth.idp.current(),
    root.auth.bootstrap.state(),
    root.providerApps.list(),
    root.connections.service.listOwnerless(),
    root.oauth.clients.list(),
    root.telemetry.overview(),
    root.users.service.list(),
  ]);

  const needApp = apps.filter((app) => app.needsApp);
  const registered = needApp.filter((app) => app.configured);
  const missing = needApp.filter((app) => !app.configured);
  const keyed = apps.filter((app) => !app.needsApp);
  const waiting = clients.filter((view) => view.status === 'pending');
  const administrators = users.filter(
    (view) =>
      view.user.status === 'active' &&
      isOperator({ email: view.user.email, groupNames: view.groups }, root.config.admin),
  );
  const host = root.config.publicUrl.host;

  const steps: Step[] = [
    {
      key: 'sign-in',
      counted: true,
      state: idp ? 'done' : 'todo',
      title: idp ? `Sign-in through ${idp.settings.issuer.hostname}` : 'Sign-in',
      description: idp
        ? 'People and teams come from your identity provider. No password is stored here.'
        : 'Nobody can sign in yet: connect your identity provider (any OpenID Connect provider).',
      action: idp ? undefined : { label: 'Set up sign-in', href: ADMIN_PAGES.signIn },
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
    {
      key: 'company-apps',
      counted: true,
      state:
        needApp.length === 0 || missing.length === 0
          ? 'done'
          : registered.length === 0
            ? 'todo'
            : 'partial',
      partial: `${registered.length}/${needApp.length}`,
      title: SECTIONS.companyApps,
      description: (
        <>
          {registered.length > 0 &&
            `${listOf(registered.map((app) => app.displayName))} ${registered.length === 1 ? 'is' : 'are'} registered. `}
          {missing.length > 0 && (
            <>
              <strong>{listOf(missing.map((app) => app.displayName))}</strong>{' '}
              {missing.length === 1 ? 'is' : 'are'} not: nobody can connect{' '}
              {missing.length === 1 ? 'an account of it' : 'their accounts'} until{' '}
              {missing.length === 1 ? 'it is' : 'they are'}.{' '}
            </>
          )}
          {keyed.length > 0 &&
            `${listOf(keyed.map((app) => app.displayName))} connect with a key and need none.`}
        </>
      ),
      action: missing[0]
        ? {
            label: `${SETTINGS_ACTIONS.register} ${missing[0].displayName}`,
            href: `${ADMIN_PAGES.companyApps}?app=${encodeURIComponent(missing[0].providerId)}#${missing[0].providerId}`,
          }
        : undefined,
    },
    {
      key: 'administrators',
      counted: true,
      state: administrators.length > 0 || bootstrap.status !== 'active' ? 'done' : 'todo',
      title: SECTIONS.administrators,
      description:
        administrators.length > 0
          ? `${listOf(administrators.map((view) => view.user.displayName ?? view.user.email))} — by the rule below.`
          : 'Nobody who matches the rule below has signed in yet.',
    },
    ...(ownerless.length > 0
      ? [
          {
            key: 'ownerless',
            counted: false,
            state: 'todo' as const,
            title: SETTINGS_PAGES.ownerless.title,
            description: `${count(ownerless.length, TERMS.connection)} ${ownerless.length === 1 ? 'has' : 'have'} no owner left: nobody can reconnect ${ownerless.length === 1 ? 'it' : 'them'} or give access.`,
            action: { label: SETTINGS_ACTIONS.nameOwner, href: ADMIN_PAGES.ownerlessAccounts },
          },
        ]
      : []),
    ...(waiting.length > 0
      ? [
          {
            key: 'registered-apps',
            counted: false,
            state: 'todo' as const,
            title: SETTINGS_PAGES.registeredApps.title,
            description: `${formatNumber(waiting.length)} ${waiting.length === 1 ? 'app waits' : 'apps wait'} for your approval before ${waiting.length === 1 ? 'it' : 'they'} can ask anyone.`,
            action: { label: 'Review', href: ADMIN_PAGES.registeredApps },
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
      <PageHeader title={SETTINGS_PAGES.setup.title} lede={SETTINGS_PAGES.setup.lede} />

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
                step.action ? (
                  <ButtonLink
                    href={step.action.href}
                    size="sm"
                    variant={step.key === next?.key ? 'primary' : 'secondary'}
                  >
                    {step.action.label}
                  </ButtonLink>
                ) : step.state === 'done' ? (
                  'done'
                ) : undefined
              }
            />
          ))}
        </Rows>
      </Section>

      <Section
        title={SECTIONS.administrators}
        note={CONFIG_WORDS.fileReadOnly}
        id="administrators"
        testId="administrators"
      >
        <KeyValue
          items={[
            { term: 'Rule', value: ruleWords(root.config.admin) },
            {
              term: 'Today',
              value:
                administrators.length === 0 ? (
                  <span className={styles.quiet}>nobody has signed in under this rule yet</span>
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
                  'Still valid: it is revoked at the first sign-in of an administrator.'
                ) : bootstrap.status === 'revoked' ? (
                  <>
                    Revoked on <LocalDate ts={bootstrap.revokedAt} dateOnly />, at the first sign-in
                    of an administrator. Nothing to do.
                  </>
                ) : (
                  'None was configured.'
                ),
            },
          ]}
        />
      </Section>

      <Section title="This gateway" note={CONFIG_WORDS.fileReadOnly} id="gateway">
        <KeyValue
          items={[
            { term: 'Public address', value: <Mono>{root.config.publicUrl.href}</Mono> },
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

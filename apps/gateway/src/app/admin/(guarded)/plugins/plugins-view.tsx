/**
 * What Administration › Plugins shows, from a view the page assembles (`page.tsx`):
 * every plugin of the inventory on one quiet row, what the versions feed reports above
 * them — each kind only when present, an advisory in the page's one filled box — and a
 * last line saying when and where the feed was read. Pure: no root, no request, so a
 * unit test renders it over invented views.
 *
 * Nothing here installs, updates or removes anything (ADR
 * plugins-bundled-or-pinned-by-the-operator): the one form re-reads the feed.
 */
import { LocalDate } from '@/components/LocalDate';
import styles from '@/components/settings/settings.module.css';
import { ValidationBadge } from '@/components/telemetry/ValidationBadge';
import {
  Button,
  Callout,
  Hint,
  Mono,
  PageHeader,
  Row,
  Rows,
  Section,
  ServiceMark,
  Tag,
  type ServiceMarkIcon,
} from '@/components/ui';
import { servicePath } from '@/lib/services/links';
import { PIN_A_PLUGIN_DOC } from '@/lib/project-docs';
import { DOC_PAGES, PLUGIN_WORDS, SETTINGS_PAGES } from '@/lib/vocabulary';
import type { PluginInventoryEntry } from '@/server/plugins';
import type { ValidationStatus } from '@/server/telemetry';
import {
  UPDATES_CHECK_ACTION,
  type AdvisoryHit,
  type UpdatesFailure,
  type UpdatesReport,
} from '@/server/updates';

/** One plugin of the inventory, with what the page reads beside it. */
export interface PluginLine {
  readonly entry: PluginInventoryEntry;
  /** The service's mark; `null` for a plugin that is not registered or declares none. */
  readonly icon: ServiceMarkIcon | null;
  /** Accounts not revoked of this service. */
  readonly accounts: number;
  /** Community validation; `null` when telemetry is off or nothing is known. */
  readonly validation: ValidationStatus | null;
}

export interface PluginsView {
  readonly lines: readonly PluginLine[];
  /** `updates.check`. */
  readonly check: boolean;
  /** `updates.feed_url`. */
  readonly feedUrl: string;
  readonly report: UpdatesReport | null;
  readonly failure: UpdatesFailure | null;
}

/** The plugin's display name, or its id when the inventory does not know it. */
function nameOf(lines: readonly PluginLine[], id: string): string {
  return lines.find((line) => line.entry.id === id)?.entry.name ?? id;
}

function Origin({ entry }: { entry: PluginInventoryEntry }) {
  if (entry.origin === 'bundled') return <>{PLUGIN_WORDS.bundled}</>;
  return (
    <>
      {PLUGIN_WORDS.pinnedFrom} <Mono>{entry.path ?? '?'}</Mono>
      {entry.replaces !== null && (
        <>
          , {PLUGIN_WORDS.replacesBundled} <Mono>{entry.replaces}</Mono>
        </>
      )}
    </>
  );
}

function subjectOf(advisory: AdvisoryHit, lines: readonly PluginLine[]): string {
  return advisory.subject === 'gateway' ? 'the gateway' : nameOf(lines, advisory.subject.plugin);
}

/** Whether the feed reports anything about this gateway. */
export function reportsSomething(report: UpdatesReport | null): report is UpdatesReport {
  if (!report) return false;
  const { gateway, pluginsBehind, advisories, olderPins } = report;
  return gateway.behind || pluginsBehind.length + advisories.length + olderPins.length > 0;
}

/** What the feed reports, each kind only when present. */
function FeedNotices({ report, lines }: { report: UpdatesReport; lines: readonly PluginLine[] }) {
  const { gateway, pluginsBehind, advisories, olderPins } = report;
  const markOf = (id: string) => {
    const line = lines.find((l) => l.entry.id === id);
    return <ServiceMark name={line?.entry.name ?? id} icon={line?.icon ?? null} />;
  };
  return (
    <Section title={PLUGIN_WORDS.feedSection} first testId="updates-notices">
      {advisories.length > 0 && (
        <div className={styles.notes}>
          <Callout
            tone="bad"
            title={PLUGIN_WORDS.advisoriesTitle(advisories.length)}
            testId="updates-advisories"
          >
            {advisories.map((advisory) => (
              <p key={advisory.id} data-testid={`advisory-${advisory.id}`}>
                <a href={advisory.url} rel="noreferrer noopener" target="_blank">
                  {advisory.id}
                </a>{' '}
                · {subjectOf(advisory, lines)} <Mono>{advisory.loaded}</Mono>: {advisory.summary}{' '}
                {PLUGIN_WORDS.fixedIn} <Mono>{advisory.fixed}</Mono>.
              </p>
            ))}
          </Callout>
        </div>
      )}
      <Rows>
        {gateway.behind && (
          <Row
            testId="update-gateway"
            title={PLUGIN_WORDS.gatewayBehind}
            description={
              <span className={styles.inline}>
                <Mono>{gateway.current}</Mono> → <Mono>{gateway.latest}</Mono>
                {gateway.latestIsPrerelease && <Tag>{PLUGIN_WORDS.preRelease}</Tag>}
              </span>
            }
          />
        )}
        {pluginsBehind.map((behind) => (
          <Row
            key={`behind-${behind.id}`}
            testId={`update-plugin-${behind.id}`}
            lead={markOf(behind.id)}
            title={`${nameOf(lines, behind.id)}: ${PLUGIN_WORDS.pluginBehind}`}
            description={
              <span className={styles.inline}>
                <Mono>{behind.loaded}</Mono> → <Mono>{behind.released}</Mono>
              </span>
            }
          />
        ))}
        {olderPins.map((pin) => (
          <Row
            key={`pin-${pin.id}`}
            testId={`older-pin-${pin.id}`}
            lead={markOf(pin.id)}
            title={`${nameOf(lines, pin.id)}: ${PLUGIN_WORDS.olderPin}`}
            description={
              <span className={styles.inline}>
                <Mono>{pin.pinned}</Mono> → <Mono>{pin.bundled}</Mono>
                {pin.path && (
                  <>
                    · {PLUGIN_WORDS.pinnedFrom} <Mono>{pin.path}</Mono>
                  </>
                )}
              </span>
            }
          />
        ))}
      </Rows>
    </Section>
  );
}

/** When and where the feed was read, or that it is off, and the last failure. */
function FeedFooter({ view }: { view: PluginsView }) {
  if (!view.check) {
    return (
      <p className={styles.quiet} data-testid="updates-footer">
        {PLUGIN_WORDS.checkOff}
      </p>
    );
  }
  const { report, failure } = view;
  return (
    <div className={styles.formActions} data-testid="updates-footer">
      <span className={styles.quiet}>
        {report ? (
          <>
            {PLUGIN_WORDS.readAt} <LocalDate ts={report.checkedAt} /> {PLUGIN_WORDS.from}{' '}
            <Mono>{view.feedUrl}</Mono>.
          </>
        ) : (
          <>
            {PLUGIN_WORDS.notReadYet} <Mono>{view.feedUrl}</Mono>.
          </>
        )}
        {failure && (
          <span className={styles.sub} data-testid="updates-failure">
            {PLUGIN_WORDS.lastFailure} <LocalDate ts={failure.at} />:{' '}
            {PLUGIN_WORDS.failures[failure.failure]}
            {failure.status !== undefined && ` (HTTP ${failure.status})`}
            {report ? `; ${PLUGIN_WORDS.keptReport}` : '.'}
          </span>
        )}
      </span>
      <form method="post" action={UPDATES_CHECK_ACTION} className={styles.inlineForm}>
        <Button type="submit" size="sm" data-testid="updates-check-now">
          {PLUGIN_WORDS.checkNow}
        </Button>
      </form>
    </div>
  );
}

function PluginRow({ line }: { line: PluginLine }) {
  const { entry } = line;
  return (
    <Row
      testId={`plugin-${entry.id}`}
      lead={<ServiceMark name={entry.name} icon={line.icon} />}
      title={
        <span className={styles.inline}>
          {entry.name}
          {entry.enabled && <ValidationBadge status={line.validation} />}
        </span>
      }
      href={entry.enabled ? servicePath(entry.id) : undefined}
      muted={!entry.enabled}
      description={
        <>
          <Mono>{entry.id}</Mono> · <Mono>{entry.version}</Mono> ·{' '}
          <span data-testid="plugin-origin">
            <Origin entry={entry} />
          </span>
          {!entry.enabled && (
            <>
              {' '}
              · <span data-testid="plugin-disabled">{PLUGIN_WORDS.disabled}</span>
            </>
          )}
        </>
      }
      end={
        <span data-testid="plugin-accounts">
          {line.accounts > 0 ? PLUGIN_WORDS.serves(line.accounts) : PLUGIN_WORDS.servesNone}
        </span>
      }
    />
  );
}

export function PluginsPage({ view }: { view: PluginsView }) {
  const notices = reportsSomething(view.report);
  return (
    <>
      <PageHeader
        doc={DOC_PAGES.plugins}
        title={SETTINGS_PAGES.plugins.title}
        lede={SETTINGS_PAGES.plugins.lede}
      />
      {reportsSomething(view.report) && <FeedNotices report={view.report} lines={view.lines} />}
      <Section
        title={PLUGIN_WORDS.listTitle}
        count={view.lines.length}
        first={!notices}
        testId="plugins"
      >
        <Rows>
          {view.lines.map((line) => (
            <PluginRow key={line.entry.id} line={line} />
          ))}
        </Rows>
        <Hint>
          {PLUGIN_WORDS.changes}{' '}
          <a href={PIN_A_PLUGIN_DOC} rel="noreferrer noopener" target="_blank">
            {PLUGIN_WORDS.howToPin}
          </a>
          .
        </Hint>
        <FeedFooter view={view} />
      </Section>
    </>
  );
}

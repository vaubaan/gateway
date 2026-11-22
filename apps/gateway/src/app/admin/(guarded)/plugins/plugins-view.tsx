/**
 * Administration › Plugins, from a view the page assembles (`page.tsx`): only the plugins
 * this gateway runs, each on one row with the acts it allows — Update when the catalog has
 * a newer version or one signed by Vaubaan is downloaded and waiting, Roll back when the
 * version it ran before is kept, Stop when it runs a version installed here — each behind
 * one dialog,
 * and Update all when several are behind (intent "Update my installed plugins in a few
 * clicks"). Above them, only what asks for attention: an advisory, the gateway behind, a
 * version waiting for activation, a restart. What the gateway does not run is on the
 * catalog page (`catalog/`). Pure: no root, no request, so a unit test renders it over
 * invented views.
 */
import { LocalDate } from '@/components/LocalDate';
import styles from '@/components/settings/settings.styles';
import { ValidationBadge } from '@/components/telemetry/ValidationBadge';
import {
  Button,
  ButtonLink,
  Callout,
  ConfirmSubmit,
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
import { DOC_PAGES, PLUGIN_WORDS, SETTINGS_PAGES } from '@/lib/vocabulary';
import type { PluginInventoryEntry } from '@/server/plugins';
import {
  DIGEST_FIELD,
  PLUGIN_ACTIONS,
  PLUGIN_FIELD,
  PLUGINS_CATALOG_PAGE,
  UPDATE_FIELD,
} from '@/server/plugins/handlers';
import type { ValidationStatus } from '@/server/telemetry';
import {
  UPDATES_CHECK_ACTION,
  type AdvisoryHit,
  type UpdatesFailure,
  type UpdatesReport,
} from '@/server/updates';

import type { ActivationView } from '@/server/plugins/install-service';
import type { PluginVersionRecord } from '@/server/store/repositories/plugin-versions';

import { isOlder } from '@/server/updates/compare';

import { Flash, InstallNotices, VersionRow, type InstallView } from './install-view';

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
  readonly install: InstallView;
}

/** The plugin's display name, or its id when the inventory does not know it. */
function nameOf(lines: readonly PluginLine[], id: string): string {
  return lines.find((line) => line.entry.id === id)?.entry.name ?? id;
}

function Origin({ entry }: { entry: PluginInventoryEntry }) {
  if (entry.origin === 'bundled') return <>{PLUGIN_WORDS.bundled}</>;
  if (entry.origin === 'installed') {
    return (
      <>
        {PLUGIN_WORDS.installed}
        {entry.replaces !== null && (
          <>
            , {PLUGIN_WORDS.replacesImage} <Mono>{entry.replaces}</Mono>
          </>
        )}
      </>
    );
  }
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

/**
 * The version each running plugin can be updated to, by id: a Vaubaan-signed version
 * already downloaded and waiting, or the catalog's newer one, which wins when they differ.
 */
function updatesOf(
  report: UpdatesReport | null,
  lines: readonly PluginLine[],
  install: InstallView,
): ReadonlyMap<string, string> {
  // What each plugin runs now: the feed's report may predate an update made since, and a
  // version downloaded earlier may be older than the one running.
  const running = new Map(
    lines.filter((l) => l.entry.enabled).map((l) => [l.entry.id, l.entry.version] as const),
  );
  const newer = (id: string, version: string) => {
    const now = running.get(id);
    return now !== undefined && isOlder(now, version);
  };
  const updates = new Map<string, string>();
  if (!install.canInstall) return updates;
  for (const v of install.versions) {
    if (v.state === 'pending' && v.trust === 'vaubaan' && newer(v.pluginId, v.version)) {
      updates.set(v.pluginId, v.version);
    }
  }
  for (const behind of report?.pluginsBehind ?? []) {
    if (newer(behind.id, behind.released)) updates.set(behind.id, behind.released);
  }
  return updates;
}

/** An advisory names a version this gateway runs: the page's one filled box. */
function Advisories({
  advisories,
  lines,
}: {
  advisories: readonly AdvisoryHit[];
  lines: readonly PluginLine[];
}) {
  if (advisories.length === 0) return null;
  return (
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

function PluginRow({
  line,
  released,
  rollback,
  olderPin,
}: {
  line: PluginLine;
  /** The catalog's newer version, when this gateway can install it. */
  released: string | null;
  /** The version it ran before, kept to go back to, when this gateway can run it. */
  rollback: { readonly version: PluginVersionRecord; readonly view: ActivationView } | null;
  /** The image bundles a newer version than this pin. */
  olderPin: string | null;
}) {
  const { entry } = line;
  const stoppable = entry.origin === 'installed';
  return (
    <Row
      testId={`plugin-${entry.id}`}
      lead={<ServiceMark name={entry.name} icon={line.icon} />}
      title={
        <span className={styles.inline}>
          {entry.name}
          <ValidationBadge status={line.validation} />
        </span>
      }
      href={servicePath(entry.id)}
      description={
        <>
          <Mono>{entry.id}</Mono> · <Mono>{entry.version}</Mono> ·{' '}
          <span data-testid="plugin-origin">
            <Origin entry={entry} />
          </span>{' '}
          ·{' '}
          <span data-testid="plugin-accounts">
            {line.accounts > 0 ? PLUGIN_WORDS.serves(line.accounts) : PLUGIN_WORDS.servesNone}
          </span>
          {olderPin !== null && (
            <span className={styles.sub} data-testid={`older-pin-${entry.id}`}>
              {PLUGIN_WORDS.olderPin} (<Mono>{olderPin}</Mono>)
            </span>
          )}
        </>
      }
      {...(released !== null || rollback !== null || stoppable
        ? {
            end: (
              <span className={styles.inline}>
                {released !== null && (
                  <ConfirmSubmit
                    action={PLUGIN_ACTIONS.update}
                    fields={{ [UPDATE_FIELD]: `${entry.id}@${released}` }}
                    label={PLUGIN_WORDS.update(released)}
                    variant="primary"
                    title={PLUGIN_WORDS.updateTitle(entry.name)}
                    consequence={PLUGIN_WORDS.updateConsequence(
                      entry.name,
                      entry.version,
                      released,
                    )}
                    confirmLabel={PLUGIN_WORDS.updateConfirm}
                    hint={PLUGIN_WORDS.recorded}
                    testId={`update-plugin-${entry.id}`}
                  />
                )}
                {rollback !== null && (
                  <ConfirmSubmit
                    action={PLUGIN_ACTIONS.activate}
                    fields={{ [DIGEST_FIELD]: rollback.version.digest }}
                    label={PLUGIN_WORDS.rollback(rollback.version.version)}
                    title={PLUGIN_WORDS.rollbackTitle(entry.name, rollback.version.version)}
                    consequence={PLUGIN_WORDS.rollbackConsequence(
                      entry.name,
                      entry.version,
                      rollback.version.version,
                      rollback.view.unknownToIt.length,
                    )}
                    confirmLabel={PLUGIN_WORDS.rollbackConfirm}
                    hint={PLUGIN_WORDS.recorded}
                    testId={`rollback-plugin-${entry.id}`}
                  >
                    {rollback.view.unknownToIt.length > 0 && (
                      <ul data-testid={`rollback-unknown-${entry.id}`}>
                        {rollback.view.unknownToIt.map((id) => (
                          <li key={id}>
                            <Mono>{id}</Mono>
                          </li>
                        ))}
                      </ul>
                    )}
                  </ConfirmSubmit>
                )}
                {stoppable && (
                  <ConfirmSubmit
                    action={PLUGIN_ACTIONS.followImage}
                    fields={{ [PLUGIN_FIELD]: entry.id }}
                    label={PLUGIN_WORDS.stop}
                    ariaLabel={PLUGIN_WORDS.stopTitle(entry.name)}
                    title={PLUGIN_WORDS.stopTitle(entry.name)}
                    consequence={PLUGIN_WORDS.stopConsequence(entry.name, line.accounts)}
                    confirmLabel={PLUGIN_WORDS.stopConfirm}
                    tone="danger"
                    hint={PLUGIN_WORDS.recorded}
                    testId={`stop-plugin-${entry.id}`}
                  />
                )}
              </span>
            ),
          }
        : {})}
    />
  );
}

export function PluginsPage({ view }: { view: PluginsView }) {
  const { install, report, lines } = view;
  const running = lines.filter((line) => line.entry.enabled);
  const leftOut = lines.filter((line) => !line.entry.enabled);
  const behind = updatesOf(report, lines, install);
  const olderPins = new Map((report?.olderPins ?? []).map((pin) => [pin.id, pin.bundled]));
  // A version an Update button already offers is not asked about a second time.
  const waiting = install.versions.filter(
    (v) =>
      (v.state === 'pending' || v.state === 'failed') &&
      !(v.state === 'pending' && behind.get(v.pluginId) === v.version && v.trust === 'vaubaan'),
  );
  // The version each plugin ran last before this one (the list is newest change first).
  const rollbacks = new Map<string, { version: PluginVersionRecord; view: ActivationView }>();
  for (const version of install.versions) {
    const view = install.activations[version.digest];
    if (version.state !== 'previous' || rollbacks.has(version.pluginId)) continue;
    if (view === undefined || view.sdkProblem !== null) continue;
    rollbacks.set(version.pluginId, { version, view });
  }
  const restart =
    install.versions.some((v) => v.state === 'trial') ||
    (install.flash?.kind === 'done' && install.flash.code === 'followed-image');
  // In the order of the rows, so the dialog reads like the page.
  const ordered = running.flatMap((line) => {
    const version = behind.get(line.entry.id);
    return version === undefined ? [] : [[line.entry.id, version] as const];
  });
  const all = ordered.map(([id, version]) => `${id}@${version}`).join(',');
  return (
    <>
      <PageHeader
        doc={DOC_PAGES.plugins}
        title={SETTINGS_PAGES.plugins.title}
        lede={SETTINGS_PAGES.plugins.lede}
        {...(behind.size >= 2
          ? {
              primary: (
                <ConfirmSubmit
                  action={PLUGIN_ACTIONS.update}
                  fields={{ [UPDATE_FIELD]: all }}
                  label={PLUGIN_WORDS.updateAll(behind.size)}
                  variant="primary"
                  size="md"
                  title={PLUGIN_WORDS.updateAllTitle(behind.size)}
                  consequence={PLUGIN_WORDS.updateAllConsequence}
                  confirmLabel={PLUGIN_WORDS.updateAll(behind.size)}
                  hint={PLUGIN_WORDS.recorded}
                  testId="update-all"
                >
                  <ul data-testid="update-all-list">
                    {ordered.map(([id, version]) => (
                      <li key={id}>
                        {nameOf(lines, id)}{' '}
                        <Mono>{running.find((l) => l.entry.id === id)?.entry.version}</Mono> →{' '}
                        <Mono>{version}</Mono>
                      </li>
                    ))}
                  </ul>
                </ConfirmSubmit>
              ),
            }
          : {})}
        secondary={[
          <ButtonLink key="catalog" href={PLUGINS_CATALOG_PAGE} data-testid="browse-catalog">
            {PLUGIN_WORDS.browseCatalog}
          </ButtonLink>,
        ]}
      />
      <Flash flash={install.flash} />
      <InstallNotices view={install} restart={restart} />
      {report && <Advisories advisories={report.advisories} lines={lines} />}
      {report?.gateway.behind === true && (
        <Callout tone="info" title={PLUGIN_WORDS.gatewayBehind} testId="update-gateway">
          <span className={styles.inline}>
            <Mono>{report.gateway.current}</Mono> → <Mono>{report.gateway.latest}</Mono>
            {report.gateway.latestIsPrerelease && <Tag>{PLUGIN_WORDS.preRelease}</Tag>}
          </span>
        </Callout>
      )}
      {waiting.length > 0 && (
        <Section
          title={PLUGIN_WORDS.waitingTitle}
          count={waiting.length}
          first
          testId="install-versions"
        >
          <Rows>
            {waiting.map((version) => (
              <VersionRow
                key={version.digest}
                version={version}
                view={install.activations[version.digest]}
              />
            ))}
          </Rows>
        </Section>
      )}
      <Section
        title={PLUGIN_WORDS.listTitle}
        count={running.length}
        first={waiting.length === 0}
        testId="plugins"
      >
        <Rows>
          {running.map((line) => (
            <PluginRow
              key={line.entry.id}
              line={line}
              released={behind.get(line.entry.id) ?? null}
              rollback={rollbacks.get(line.entry.id) ?? null}
              olderPin={olderPins.get(line.entry.id) ?? null}
            />
          ))}
        </Rows>
        {leftOut.length > 0 && (
          <Hint>
            <span data-testid="plugins-left-out">
              {PLUGIN_WORDS.leftOut(leftOut.length)}{' '}
              {leftOut.map((line, index) => (
                <span key={line.entry.id}>
                  {index > 0 && ', '}
                  <Mono>{line.entry.id}</Mono>
                </span>
              ))}
              .
            </span>
          </Hint>
        )}
        <FeedFooter view={view} />
      </Section>
    </>
  );
}

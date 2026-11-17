/**
 * The installing part of Administration › Plugins (ADR
 * plugins-activated-by-an-administrator-on-trial; spec §4.2): the upload form, every
 * installed version with what it would change, the forms that activate, refuse or go
 * back, and the restart that applies a trial. Pure: the page (`page.tsx`) reads the
 * root; a unit test renders this over invented views.
 *
 * Every form posts to its route (`PLUGIN_ACTIONS`); the server checks the typed id again,
 * so a form submitted without its script still confirms nothing it should not.
 */
import { LocalDate } from '@/components/LocalDate';
import styles from '@/components/settings/settings.module.css';
import {
  Button,
  Callout,
  Field,
  Hint,
  Input,
  Mono,
  Row,
  Rows,
  Section,
  Tag,
} from '@/components/ui';
import { INSTALL_WORDS } from '@/lib/vocabulary';
import type { Tone } from '@/lib/vocabulary';
import {
  ARCHIVE_FIELD,
  CONFIRM_FIELD,
  DIGEST_FIELD,
  PLUGIN_ACTIONS,
  PLUGIN_FIELD,
} from '@/server/plugins/handlers';
import type { ActivationView } from '@/server/plugins/install-service';
import type {
  PluginVersionRecord,
  PluginVersionState,
} from '@/server/store/repositories/plugin-versions';

export interface InstallView {
  /** `false` for a store in memory: nothing can be installed. */
  readonly canInstall: boolean;
  /** Every version but the removed ones, newest change first. */
  readonly versions: readonly PluginVersionRecord[];
  /** What activating each pending, kept or failed version would change, by digest. */
  readonly activations: Readonly<Record<string, ActivationView>>;
  /** What the last act said (`?done=` / `?problem=&detail=`). */
  readonly flash:
    | { readonly kind: 'done'; readonly code: keyof typeof INSTALL_WORDS.done }
    | {
        readonly kind: 'problem';
        readonly code: keyof typeof INSTALL_WORDS.problems;
        readonly detail: string | null;
      }
    | null;
}

const STATE_TONE: Readonly<Record<PluginVersionState, Tone>> = {
  pending: 'warn',
  trial: 'info',
  active: 'ok',
  previous: 'neutral',
  failed: 'bad',
  refused: 'neutral',
  removed: 'neutral',
};

const ACTIVATABLE: ReadonlySet<PluginVersionState> = new Set(['pending', 'previous', 'failed']);

function shortDigest(digest: string): string {
  return `${digest.slice(0, 12)}…`;
}

function Ids({ ids }: { ids: readonly string[] }) {
  if (ids.length === 0) return <>{INSTALL_WORDS.none}</>;
  return (
    <>
      {ids.map((id, index) => (
        <span key={id}>
          {index > 0 && ', '}
          <Mono>{id}</Mono>
        </span>
      ))}
    </>
  );
}

function Activation({ version, view }: { version: PluginVersionRecord; view: ActivationView }) {
  const fieldId = `confirm-${version.digest.slice(0, 12)}`;
  return (
    <div className={styles.notes} data-testid={`activation-${version.digest}`}>
      {version.trust !== 'vaubaan' && <p>{INSTALL_WORDS.notVaubaan}</p>}
      <p>
        {view.running === null ? (
          INSTALL_WORDS.notRunning
        ) : (
          <>
            {INSTALL_WORDS.running} <Mono>{view.running.version}</Mono> ({view.running.origin}).
          </>
        )}{' '}
        {INSTALL_WORDS.accounts(view.accounts)}.
      </p>
      <p data-testid="activation-added">
        {INSTALL_WORDS.added}: <Ids ids={view.added} />
      </p>
      <p>
        {INSTALL_WORDS.deprecated}: <Ids ids={view.deprecated} />
      </p>
      {view.unknownToIt.length > 0 && (
        <p data-testid="activation-unknown">
          {INSTALL_WORDS.unknownToIt}: <Ids ids={view.unknownToIt} />
        </p>
      )}
      <form method="post" action={PLUGIN_ACTIONS.activate} className={styles.lineForm}>
        <input type="hidden" name={DIGEST_FIELD} value={version.digest} />
        <Field label={INSTALL_WORDS.typeToConfirm(version.pluginId)} htmlFor={fieldId}>
          <Input
            id={fieldId}
            name={CONFIRM_FIELD}
            mono
            autoComplete="off"
            required
            pattern={version.pluginId.replace(/[-]/g, '\\-')}
          />
        </Field>
        <Button type="submit" variant="primary" data-testid="activate">
          {version.state === 'pending' ? INSTALL_WORDS.activate : INSTALL_WORDS.goBack}
        </Button>
      </form>
    </div>
  );
}

function VersionRow({ version, view }: { version: PluginVersionRecord; view?: ActivationView }) {
  return (
    <Row
      testId={`version-${version.digest}`}
      title={
        <span className={styles.inline}>
          <Mono>{version.pluginId}</Mono> <Mono>{version.version}</Mono>
          <Tag tone={STATE_TONE[version.state]}>{INSTALL_WORDS.states[version.state]}</Tag>
          <Tag tone={version.trust === 'vaubaan' ? 'ok' : 'warn'}>
            {version.trust === 'signer'
              ? `${INSTALL_WORDS.trust.signer} ${version.signer ?? ''}`
              : INSTALL_WORDS.trust[version.trust]}
          </Tag>
        </span>
      }
      description={
        <>
          <Mono>{shortDigest(version.digest)}</Mono> · {INSTALL_WORDS.uploadedBy}{' '}
          <LocalDate ts={version.uploadedAt} />
          {version.viaMissionId !== null && <> {INSTALL_WORDS.viaMission}</>}
          {version.failure !== null && (
            <span className={styles.sub} data-testid="version-failure">
              {version.failure}
            </span>
          )}
          {view && ACTIVATABLE.has(version.state) && <Activation version={version} view={view} />}
        </>
      }
      end={
        <span className={styles.inline}>
          {version.state === 'pending' && (
            <form method="post" action={PLUGIN_ACTIONS.refuse} className={styles.inlineForm}>
              <input type="hidden" name={DIGEST_FIELD} value={version.digest} />
              <Button type="submit" size="sm" variant="danger" data-testid="refuse">
                {INSTALL_WORDS.refuse}
              </Button>
            </form>
          )}
          {version.state === 'active' && (
            <form method="post" action={PLUGIN_ACTIONS.followImage} className={styles.inlineForm}>
              <input type="hidden" name={PLUGIN_FIELD} value={version.pluginId} />
              <Button type="submit" size="sm" data-testid="follow-image">
                {INSTALL_WORDS.followImage}
              </Button>
            </form>
          )}
        </span>
      }
    />
  );
}

function Flash({ flash }: { flash: InstallView['flash'] }) {
  if (flash === null) return null;
  if (flash.kind === 'done') {
    return (
      <Callout tone="ok" testId="install-done">
        {INSTALL_WORDS.done[flash.code]}
      </Callout>
    );
  }
  return (
    <Callout tone="bad" testId="install-problem">
      {INSTALL_WORDS.problems[flash.code]}
      {flash.detail !== null && <>: {flash.detail}</>}.
    </Callout>
  );
}

export function InstallSection({ view }: { view: InstallView }) {
  const trial = view.versions.some((v) => v.state === 'trial');
  const shown = view.versions.filter((v) => v.state !== 'removed' && v.state !== 'refused');
  return (
    <>
      <Flash flash={view.flash} />
      {trial && (
        <Callout
          tone="info"
          title={INSTALL_WORDS.restartTitle}
          testId="restart-needed"
          action={
            <form method="post" action={PLUGIN_ACTIONS.restart} className={styles.inlineForm}>
              <Button type="submit" size="sm" variant="primary" data-testid="restart">
                {INSTALL_WORDS.restart}
              </Button>
            </form>
          }
        >
          {INSTALL_WORDS.restartLede}
        </Callout>
      )}
      <Section title={INSTALL_WORDS.uploadTitle} testId="install-upload">
        {view.canInstall ? (
          <form
            method="post"
            action={PLUGIN_ACTIONS.upload}
            encType="multipart/form-data"
            className={styles.lineForm}
          >
            <Field label={INSTALL_WORDS.archiveLabel} htmlFor="plugin-archive">
              <Input
                id="plugin-archive"
                name={ARCHIVE_FIELD}
                type="file"
                accept=".tgz,application/gzip"
                required
              />
            </Field>
            <Button type="submit" data-testid="upload">
              {INSTALL_WORDS.upload}
            </Button>
          </form>
        ) : null}
        <Hint>{view.canInstall ? INSTALL_WORDS.uploadLede : INSTALL_WORDS.noDataDirectory}</Hint>
      </Section>
      {shown.length > 0 && (
        <Section title={INSTALL_WORDS.versionsTitle} count={shown.length} testId="install-versions">
          <Rows>
            {shown.map((version) => (
              <VersionRow
                key={version.digest}
                version={version}
                view={view.activations[version.digest]}
              />
            ))}
          </Rows>
        </Section>
      )}
    </>
  );
}

/** The flash of the page's query, read defensively: an unknown code shows nothing. */
export function flashOf(
  params: Record<string, string | string[] | undefined>,
): InstallView['flash'] {
  const one = (key: string): string | null => {
    const value = params[key];
    return typeof value === 'string' ? value : null;
  };
  const done = one('done');
  if (done !== null && done in INSTALL_WORDS.done) {
    return { kind: 'done', code: done as keyof typeof INSTALL_WORDS.done };
  }
  const problem = one('problem');
  if (problem !== null && problem in INSTALL_WORDS.problems) {
    return {
      kind: 'problem',
      code: problem as keyof typeof INSTALL_WORDS.problems,
      detail: one('detail'),
    };
  }
  return null;
}

/**
 * The installing parts of Administration › Plugins (ADR
 * plugins-activated-by-an-administrator-on-trial; spec §4.2), shared by the two pages:
 * the versions waiting for an administrator with what each would change, the acts that
 * activate, refuse or go back, the restart that applies a trial (`page.tsx`), and the
 * upload form and the signers (`catalog/page.tsx`). Pure: the pages read the root; a unit
 * test renders these over invented views.
 *
 * Every form posts to its route (`PLUGIN_ACTIONS`). A version signed by Vaubaan is
 * confirmed in a dialog; any other asks for its id typed, which the server checks again.
 */
import { LocalDate } from '@/components/LocalDate';
import styles from '@/components/settings/settings.module.css';
import {
  Button,
  Callout,
  ConfirmSubmit,
  Field,
  Hint,
  Input,
  Mono,
  Row,
  Rows,
  Section,
  Tag,
  Textarea,
} from '@/components/ui';
import { INSTALL_WORDS, ROUTES } from '@/lib/vocabulary';
import type { Tone } from '@/lib/vocabulary';
import {
  ARCHIVE_FIELD,
  CONFIRM_FIELD,
  DIGEST_FIELD,
  FROM_FIELD,
  PLUGIN_ACTIONS,
  SIGNER_ID_FIELD,
  SIGNER_KEY_FIELD,
  SIGNER_NAME_FIELD,
} from '@/server/plugins/handlers';
import type { ActivationView } from '@/server/plugins/install-service';
import type {
  PluginVersionRecord,
  PluginVersionState,
} from '@/server/store/repositories/plugin-versions';

export interface InstallView {
  /** `false` for a store in memory: nothing can be installed. */
  readonly canInstall: boolean;
  /** `plugins.safe_mode`: this start loaded no installed version. */
  readonly safeMode?: boolean;
  /** Every version but the removed ones, newest change first. */
  readonly versions: readonly PluginVersionRecord[];
  /** What activating each pending, kept or failed version would change, by digest. */
  readonly activations: Readonly<Record<string, ActivationView>>;
  /** The signers the instance trusts, with how many installed versions each signed. */
  readonly signers?: readonly {
    readonly keyId: string;
    readonly name: string;
    readonly addedAt: string;
    readonly versions: number;
  }[];
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
      <p data-testid="activation-missions">
        {INSTALL_WORDS.missionsUsing(view.missions.length)}
        {view.missions.length > 0 && ': '}
        {view.missions.map((mission, index) => (
          <span key={mission.id}>
            {index > 0 && ', '}
            <a href={`${ROUTES.missions}/${encodeURIComponent(mission.id)}`}>{mission.name}</a>
          </span>
        ))}
        .
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
      {view.sdkProblem !== null && (
        <p data-testid="activation-sdk">
          {INSTALL_WORDS.cannotRun}: {view.sdkProblem}.
        </p>
      )}
      {version.trust === 'vaubaan' ? (
        view.sdkProblem === null && (
          <ConfirmSubmit
            action={PLUGIN_ACTIONS.activate}
            fields={{ [DIGEST_FIELD]: version.digest }}
            label={version.state === 'pending' ? INSTALL_WORDS.activate : INSTALL_WORDS.goBack}
            variant="primary"
            title={
              version.state === 'pending'
                ? INSTALL_WORDS.activateTitle(version.pluginId)
                : INSTALL_WORDS.goBackTitle(version.pluginId)
            }
            consequence={INSTALL_WORDS.activateConsequence}
            confirmLabel={
              version.state === 'pending' ? INSTALL_WORDS.activate : INSTALL_WORDS.goBack
            }
            testId="activate"
          />
        )
      ) : (
        <form method="post" action={PLUGIN_ACTIONS.activate} className={styles.lineForm}>
          <input type="hidden" name={DIGEST_FIELD} value={version.digest} />
          <Field label={INSTALL_WORDS.typeToConfirm(version.pluginId)} htmlFor={fieldId}>
            <Input
              id={fieldId}
              name={CONFIRM_FIELD}
              mono
              autoComplete="off"
              required
              disabled={view.sdkProblem !== null}
              pattern={version.pluginId.replace(/[-]/g, '\\-')}
            />
          </Field>
          <Button
            type="submit"
            variant="primary"
            data-testid="activate"
            disabled={view.sdkProblem !== null}
          >
            {version.state === 'pending' ? INSTALL_WORDS.activate : INSTALL_WORDS.goBack}
          </Button>
        </form>
      )}
    </div>
  );
}

export function VersionRow({
  version,
  view,
}: {
  version: PluginVersionRecord;
  view?: ActivationView;
}) {
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
        </span>
      }
    />
  );
}

export function Flash({ flash }: { flash: InstallView['flash'] }) {
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

export function Signers({ signers }: { signers: NonNullable<InstallView['signers']> }) {
  return (
    <Section title={INSTALL_WORDS.signersTitle} count={signers.length} testId="install-signers">
      {signers.length > 0 ? (
        <Rows>
          {signers.map((signer) => (
            <Row
              key={signer.keyId}
              testId={`signer-${signer.keyId}`}
              title={signer.name}
              description={
                <>
                  {INSTALL_WORDS.signerKeyId} <Mono>{signer.keyId.slice(0, 19)}…</Mono> ·{' '}
                  <LocalDate ts={signer.addedAt} /> ·{' '}
                  {INSTALL_WORDS.signerVersions(signer.versions)}
                </>
              }
              end={
                <form
                  method="post"
                  action={PLUGIN_ACTIONS.removeSigner}
                  className={styles.lineForm}
                >
                  <input type="hidden" name={SIGNER_ID_FIELD} value={signer.keyId} />
                  <input type="hidden" name={FROM_FIELD} value="catalog" />
                  <Input
                    name={CONFIRM_FIELD}
                    aria-label={INSTALL_WORDS.typeToConfirm(signer.name)}
                    placeholder={INSTALL_WORDS.typeToConfirm(signer.name)}
                    autoComplete="off"
                    required
                    size="sm"
                  />
                  <Button type="submit" size="sm" variant="danger" data-testid="remove-signer">
                    {INSTALL_WORDS.removeSigner}
                  </Button>
                </form>
              }
            />
          ))}
        </Rows>
      ) : (
        <Hint>{INSTALL_WORDS.noSigner}</Hint>
      )}
      <form method="post" action={PLUGIN_ACTIONS.addSigner} className={styles.form}>
        <input type="hidden" name={FROM_FIELD} value="catalog" />
        <Field label={INSTALL_WORDS.signerName} htmlFor="signer-name">
          <Input id="signer-name" name={SIGNER_NAME_FIELD} maxLength={80} required />
        </Field>
        <Field label={INSTALL_WORDS.signerKey} htmlFor="signer-key">
          <Textarea id="signer-key" name={SIGNER_KEY_FIELD} mono rows={4} required />
        </Field>
        <Field label={INSTALL_WORDS.typeToConfirm('the name')} htmlFor="signer-confirm">
          <Input id="signer-confirm" name={CONFIRM_FIELD} autoComplete="off" required />
        </Field>
        <Button type="submit" data-testid="add-signer">
          {INSTALL_WORDS.addSigner}
        </Button>
      </form>
      <Hint>{INSTALL_WORDS.signersLede}</Hint>
    </Section>
  );
}

/** Safe mode, and the restart that applies a trial, when either holds. */
export function InstallNotices({ view, restart }: { view: InstallView; restart: boolean }) {
  return (
    <>
      {view.safeMode === true && (
        <Callout tone="warn" title={INSTALL_WORDS.safeModeTitle} testId="safe-mode">
          {INSTALL_WORDS.safeModeLede}
        </Callout>
      )}
      {restart && (
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
    </>
  );
}

/** Uploading an archive: the catalog page's, for an administrator's own plugins. */
export function UploadSection({ canInstall }: { canInstall: boolean }) {
  return (
    <Section title={INSTALL_WORDS.uploadTitle} testId="install-upload">
      {canInstall ? (
        <form
          method="post"
          action={PLUGIN_ACTIONS.upload}
          encType="multipart/form-data"
          className={styles.lineForm}
        >
          <input type="hidden" name={FROM_FIELD} value="catalog" />
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
      <Hint>{canInstall ? INSTALL_WORDS.uploadLede : INSTALL_WORDS.noDataDirectory}</Hint>
    </Section>
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

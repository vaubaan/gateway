/**
 * `/admin/encryption` — Settings → Encryption: where the master key comes
 * from, whether this gateway generated it and handed it over, and its
 * download for an administrator signed in recently (ADR
 * master-key-generated-and-handed-over-by-the-instance). The key itself
 * appears nowhere on the page: it leaves as a file, audited.
 *
 * "Scheduled backup" reports the encrypted backup to object storage (ADR
 * scheduled-encrypted-backup-to-object-storage): where it goes, when, the latest
 * one and the latest failure. Read-only: the `backup.*` keys configure it.
 */
import { headers } from 'next/headers';

import { LocalDate } from '@/components/LocalDate';
import styles from '@/components/settings/settings.module.css';
import {
  Button,
  Callout,
  Checkbox,
  Hint,
  KeyValue,
  Mono,
  PageHeader,
  Section,
} from '@/components/ui';
import { requireOperator } from '@/lib/auth/session';
import { CONFIG_WORDS, formatNumber, SETTINGS_PAGES } from '@/lib/vocabulary';
import { timeOfDay, type BackupView } from '@/server/backup';
import {
  CONFIRMED_FIELD,
  FRESH_SIGN_IN_MS,
  FROM_FIELD,
  KEY_PROBLEM_PARAM,
  MASTER_KEY_DOWNLOAD_ACTION,
  MASTER_KEY_FILE_NAME,
  signedInFreshly,
  type MasterKeyProblem,
} from '@/server/master-key';

export const dynamic = 'force-dynamic';

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const PROBLEMS: Readonly<Record<MasterKeyProblem, string>> = {
  'sign-in-again':
    'The key is handed over after a fresh sign-in only. Sign out, sign in again and come back here.',
  'not-confirmed': 'Tick the box first: the key opens every secret this gateway holds.',
};

function isProblem(value: unknown): value is MasterKeyProblem {
  return typeof value === 'string' && Object.hasOwn(PROBLEMS, value);
}

export default async function EncryptionPage({ searchParams }: Props) {
  const { root } = await requireOperator();
  const params = await searchParams;
  const problem = isProblem(params[KEY_PROBLEM_PARAM]) ? params[KEY_PROBLEM_PARAM] : null;
  const [key, fresh, backup] = await Promise.all([
    root.masterKey.service.state(),
    signedInFreshly(root.auth.sessions, await headers(), new Date()),
    root.backup.view(),
  ]);
  const minutes = Math.round(FRESH_SIGN_IN_MS / 60_000);

  return (
    <>
      <PageHeader title={SETTINGS_PAGES.encryption.title} lede={SETTINGS_PAGES.encryption.lede} />

      {problem && (
        <div className={styles.notes}>
          <Callout tone="bad" title="Not downloaded" testId="master-key-problem">
            {PROBLEMS[problem]}
          </Callout>
        </div>
      )}

      <Section title="The key" note={CONFIG_WORDS.fileReadOnly} first testId="master-key-state">
        <KeyValue
          items={[
            { term: 'Version', value: <Mono>{String(key.keyVersion)}</Mono> },
            {
              term: 'Read from',
              value: key.file ? (
                <>
                  the file <Mono>{key.file}</Mono>
                </>
              ) : (
                'the configuration, by value'
              ),
            },
            {
              term: 'Generated',
              value: key.generatedAt ? (
                <>
                  by this gateway at its first start, on <LocalDate ts={key.generatedAt} />
                </>
              ) : (
                'no: the key was provided at installation'
              ),
            },
            {
              term: 'Handed over',
              value: key.handedOverAt ? (
                <>
                  an administrator confirmed keeping a copy on <LocalDate ts={key.handedOverAt} />
                </>
              ) : key.generatedAt ? (
                'not yet: the setup page asks for it'
              ) : (
                'not applicable'
              ),
            },
          ]}
        />
        <Hint>
          Every account credential and every stored secret is sealed with a key derived from it. A
          backup of the store opens with this key only; rotating it is described in the
          configuration handbook. The key is never shown on a page: it leaves as a file.
        </Hint>
      </Section>

      <BackupSection view={backup} />

      <Section title="Download the key" id="download" testId="master-key-download">
        {fresh ? (
          <form method="post" action={MASTER_KEY_DOWNLOAD_ACTION} className={styles.form}>
            <input type="hidden" name={FROM_FIELD} value="settings" readOnly />
            <Checkbox name={CONFIRMED_FIELD} required data-testid="master-key-confirm">
              I understand that this file opens every secret of this gateway, and that I keep it in
              a safe place, outside this host.
            </Checkbox>
            <div className={styles.formActions}>
              <Button type="submit" variant="primary">
                Download the key
              </Button>
              <span className={styles.formHint}>
                <Mono>{MASTER_KEY_FILE_NAME}</Mono> · recorded in the activity, with your name
              </span>
            </div>
          </form>
        ) : (
          <Callout tone="neutral" title="Sign in again first" testId="master-key-sign-in-again">
            The key is handed over to an administrator who signed in less than {minutes} minutes
            ago. Sign out, sign in again and come back to this page.
            <form method="post" action="/logout" className={styles.inlineForm}>
              <Button type="submit" size="sm">
                Sign out
              </Button>
            </form>
          </Callout>
        )}
      </Section>
    </>
  );
}

function every(seconds: number): string {
  const hours = seconds / 3600;
  return hours === 24 ? 'every day' : hours === 1 ? 'every hour' : `every ${hours} hours`;
}

/** The scheduled backup: off, or where, when, the latest one and the latest failure. */
function BackupSection({ view }: { view: BackupView }) {
  const { config, status } = view;
  if (!config) {
    return (
      <Section title="Scheduled backup" note={CONFIG_WORDS.fileReadOnly} testId="backup-status">
        <Hint>
          Off. This gateway backs nothing up by itself. Set the <Mono>backup.s3.*</Mono> keys of the
          configuration (an S3-compatible bucket and its access key) and it uploads a backup,
          encrypted with a key derived from the master key and checked before it leaves, on the
          schedule you give it. The <Mono>backup</Mono> command still makes a copy by hand.
        </Hint>
      </Section>
    );
  }
  const latest = status.latest;
  return (
    <Section title="Scheduled backup" note={CONFIG_WORDS.fileReadOnly} testId="backup-status">
      {status.lastOutcome === 'failed' && status.lastError && (
        <div className={styles.notes}>
          <Callout tone="bad" title="The latest backup failed" testId="backup-failed">
            {status.lastAttemptAt && (
              <>
                On <LocalDate ts={status.lastAttemptAt} />, at the {status.lastError.stage}{' '}
                step:{' '}
              </>
            )}
            {status.lastError.message}. Nothing was uploaded by that run.
          </Callout>
        </div>
      )}
      <KeyValue
        items={[
          {
            term: 'Destination',
            value: (
              <>
                the bucket <Mono>{config.s3.bucket}</Mono> at <Mono>{config.s3.endpoint.host}</Mono>
                {config.s3.prefix && (
                  <>
                    , under <Mono>{config.s3.prefix}</Mono>
                  </>
                )}
              </>
            ),
          },
          {
            term: 'Schedule',
            value: `${every(config.everySeconds)} from ${timeOfDay(config.atMinutes)} UTC; ${
              config.keep === 0
                ? 'every backup is kept'
                : `the ${formatNumber(config.keep)} newest are kept`
            }`,
          },
          {
            term: 'Next run',
            value: view.running ? (
              'running now'
            ) : view.nextRunAt ? (
              <LocalDate ts={view.nextRunAt.toISOString()} />
            ) : (
              'not scheduled'
            ),
          },
          {
            term: 'Latest backup',
            value: latest ? (
              <span data-testid="backup-latest">
                <LocalDate ts={latest.at} /> · <Mono>{latest.objectKey}</Mono> ·{' '}
                {formatNumber(latest.bytes)} bytes
                {latest.storeBytes === undefined
                  ? ''
                  : ` (a store of ${formatNumber(latest.storeBytes)} bytes, compressed)`}{' '}
                · encrypted under key version {latest.keyVersion} · checked before upload
                <span className={styles.sub}>
                  SHA-256 <Mono>{latest.sha256}</Mono>
                </span>
              </span>
            ) : (
              'none yet'
            ),
          },
          ...(status.pruneError
            ? [{ term: 'Old backups', value: `not all deleted: ${status.pruneError}` }]
            : []),
        ]}
      />
      <Hint>
        A backup opens only with the master key of the version it names: keep a previous key after a
        rotation for as long as a backup made under it is kept. Each backup and each failure is in
        the activity.
      </Hint>
    </Section>
  );
}

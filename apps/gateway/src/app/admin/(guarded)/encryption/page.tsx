/**
 * `/admin/encryption` — Settings → Encryption: where the master key comes
 * from, whether this gateway generated it and handed it over, and its
 * download for an administrator signed in recently (ADR
 * master-key-generated-and-handed-over-by-the-instance). The key itself
 * appears nowhere on the page: it leaves as a file, audited.
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
import { CONFIG_WORDS, SETTINGS_PAGES } from '@/lib/vocabulary';
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
  const [key, fresh] = await Promise.all([
    root.masterKey.service.state(),
    signedInFreshly(root.auth.sessions, await headers(), new Date()),
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

/**
 * Small server components shared by the Accounts pages and Settings → Company
 * apps: the note a redirect left, the state of an account, and the inputs of a
 * plugin-declared `CredentialField` list.
 */
import type { CredentialAlternative, CredentialField } from '@vaubaan/plugin-sdk';

import { Callout, CodeBlock, Field, Input, StatusMark, Textarea, type Tone } from '@/components/ui';
import { ACCOUNT_STATES } from '@/lib/vocabulary';
import { FIELD_PREFIX, type FieldProblem, type Notice, type NoticeTone } from '@/server/accounts';
import type { AccountStatus } from '@/server/store';

import styles from './account.module.css';
import { shapeOfPattern } from './shape';

const NOTICE_TONE: Readonly<Record<NoticeTone, Tone>> = {
  success: 'ok',
  info: 'info',
  warning: 'warn',
  danger: 'bad',
};

/**
 * The state of an account: a mark only when it differs from normal (needs
 * reconnecting, needs an owner); "connected" and "disconnected" are plain words.
 */
export function AccountState({ status }: { status: AccountStatus }) {
  const state = ACCOUNT_STATES[status];
  if (state.tone === null) return <span className={styles.quiet}>{state.label}</span>;
  return <StatusMark tone={state.tone}>{state.label}</StatusMark>;
}

/** True when the state of an account is an exception a row or a title should show. */
export function isAccountException(status: AccountStatus): boolean {
  return ACCOUNT_STATES[status].tone !== null;
}

/** What the act the person just made did, said once after the redirect. */
export function NoticeBanner({ notice }: { notice: Notice | null }) {
  if (!notice) return null;
  return (
    <div className={styles.notice}>
      <Callout tone={NOTICE_TONE[notice.tone]} title={notice.title} testId="notice">
        {notice.lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
        {notice.codes && notice.codes.length > 0 && (
          <CodeBlock label="Recovery codes" testId="notice-codes">
            {notice.codes.join('\n')}
          </CodeBlock>
        )}
      </Callout>
    </div>
  );
}

const CREDENTIAL_KIND_LABEL = {
  oauth2: 'OAuth authorization',
  'api-key': 'API key',
  'ssh-key': 'SSH key pair',
} as const;

/**
 * How an account was made, in a few words. A way its plugin no longer offers
 * (`retired`: a Gmail account connected by OAuth) or a kind the contract no
 * longer knows (`app-install`) says so, with what it means now.
 */
export function credentialKindLabel(kind: string | null, retired = false): string {
  if (kind === null) return 'unknown';
  const known = kind in CREDENTIAL_KIND_LABEL;
  const label = known ? CREDENTIAL_KIND_LABEL[kind as keyof typeof CREDENTIAL_KIND_LABEL] : kind;
  return known && !retired
    ? label
    : `${label} (a way this gateway no longer offers: reconnect the account)`;
}

/** Multi-line secrets (PEM private keys) need a textarea; other secrets are masked. */
function isMultiline(field: CredentialField): boolean {
  return field.secret && /private[_ ]key|pem/i.test(`${field.name} ${field.label}`);
}

/**
 * One input per field, named `field.<name>`. A secret is never pre-filled:
 * `secretsSet` names the ones that already hold a value, which a blank input
 * keeps.
 *
 * Each label is bound to its input through `credentialFieldId(idPrefix,
 * name)`. `idPrefix` must be unique on the page: a page that renders several
 * forms (the connect form and the OAuth-client form of a service) gives each its own.
 *
 * The shape a value must have is said before the person types: in the label,
 * read from the plugin's `pattern` (`shapeOfPattern`), in the field as its
 * `placeholder`, and under it as its `help`. A field that may stay empty says
 * "optional" in its label.
 */
export function credentialFieldId(idPrefix: string, fieldName: string): string {
  return `${idPrefix}-${fieldName}`;
}

/**
 * What a field in error says under itself: what is wrong, the shape again —
 * the sentence a person needs is beside the field, not only at the top of the
 * page — and, for a secret, that it was not kept and is typed again.
 */
export function fieldErrorWords(field: CredentialField, problem: FieldProblem): string {
  const shape = shapeOfPattern(field.pattern);
  const what =
    problem === 'required'
      ? 'This is needed.'
      : problem === 'too-long'
        ? 'This is too long.'
        : shape
          ? `This does not have the expected shape: it ${shape}.`
          : 'This does not have the expected shape.';
  return field.secret ? `${what} A secret is never kept: type it again.` : what;
}

export function CredentialFieldInputs({
  idPrefix,
  fields,
  alternatives = [],
  values = {},
  secretsSet = [],
  invalid = {},
  disabled = false,
}: {
  idPrefix: string;
  fields: readonly CredentialField[];
  /**
   * The shapes of the key (`CredentialAlternative`): a field of one of them
   * sits in that alternative's panel (`data-alternative-panel`), which the
   * page hides while another alternative is chosen, and the browser does not
   * hold it required — the server reads only the chosen alternative's fields.
   */
  alternatives?: readonly CredentialAlternative[];
  values?: Readonly<Record<string, string>>;
  secretsSet?: readonly string[];
  /** The fields a refused form got wrong: each is marked and says why under itself. */
  invalid?: Readonly<Record<string, FieldProblem>>;
  disabled?: boolean;
}) {
  return (
    <>
      {fields.map((field) => {
        const stored = secretsSet.includes(field.name);
        const panel = alternatives.findIndex((a) => a.fields.includes(field.name));
        const required = field.required !== false && !stored && panel < 0;
        const hint = [field.help, stored ? 'A value is stored; leave blank to keep it.' : null]
          .filter(Boolean)
          .join(' ');
        const id = credentialFieldId(idPrefix, field.name);
        const problem = invalid[field.name];
        const common = {
          id,
          name: `${FIELD_PREFIX}${field.name}`,
          required,
          disabled,
          placeholder: field.placeholder,
          autoComplete: 'off',
          spellCheck: false,
        };
        const input = (
          <Field
            key={field.name}
            htmlFor={id}
            label={field.label}
            shape={shapeOfPattern(field.pattern) ?? undefined}
            optional={field.required === false}
            hint={hint || undefined}
            error={problem ? fieldErrorWords(field, problem) : undefined}
          >
            {isMultiline(field) ? (
              <Textarea {...common} rows={4} mono />
            ) : (
              <Input
                {...common}
                type={field.secret ? 'password' : 'text'}
                autoComplete={field.secret ? 'new-password' : 'off'}
                defaultValue={field.secret ? undefined : (values[field.name] ?? '')}
                pattern={field.secret ? undefined : field.pattern}
                mono
              />
            )}
          </Field>
        );
        return panel < 0 ? (
          input
        ) : (
          <div key={field.name} data-alternative-panel={panel}>
            {input}
          </div>
        );
      })}
    </>
  );
}

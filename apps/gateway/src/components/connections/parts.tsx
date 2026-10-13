/**
 * Small server components shared by the Connections pages and Admin →
 * Provider apps: the notice banner, the state and "experimental" badges, and
 * the inputs of a plugin-declared `CredentialField` list.
 */
import type { CredentialField } from '@vaubaan/plugin-sdk';

import { Badge, Banner, Field, Input, Textarea, type BadgeTone } from '@/components/ui';
import { FIELD_PREFIX, type Notice } from '@/server/connections';
import type { ConnectionStatus } from '@/server/store';

import styles from './connections.module.css';

const STATE_TONE: Readonly<Record<ConnectionStatus, BadgeTone>> = {
  active: 'success',
  expired: 'warning',
  revoked: 'neutral',
  unowned: 'warning',
};

export function StateBadge({ status }: { status: ConnectionStatus }) {
  return <Badge tone={STATE_TONE[status]}>{status}</Badge>;
}

export function ExperimentalBadge() {
  return <Badge tone="warning">experimental</Badge>;
}

export function NoticeBanner({ notice }: { notice: Notice | null }) {
  if (!notice) return null;
  return (
    <Banner tone={notice.tone} title={notice.title}>
      {notice.lines.map((line) => (
        <p key={line} className={styles.noticeLine}>
          {line}
        </p>
      ))}
    </Banner>
  );
}

const CREDENTIAL_KIND_LABEL = {
  oauth2: 'OAuth authorization',
  'app-install': 'App installation',
  'api-key': 'API key',
  'ssh-key': 'SSH key pair',
} as const;

export function credentialKindLabel(kind: keyof typeof CREDENTIAL_KIND_LABEL | null): string {
  return kind ? CREDENTIAL_KIND_LABEL[kind] : 'unknown';
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
 * lists (Admin → Provider apps, one per provider) gives each its own.
 */
export function credentialFieldId(idPrefix: string, fieldName: string): string {
  return `${idPrefix}-${fieldName}`;
}

export function CredentialFieldInputs({
  idPrefix,
  fields,
  values = {},
  secretsSet = [],
  disabled = false,
}: {
  idPrefix: string;
  fields: readonly CredentialField[];
  values?: Readonly<Record<string, string>>;
  secretsSet?: readonly string[];
  disabled?: boolean;
}) {
  return (
    <>
      {fields.map((field) => {
        const stored = secretsSet.includes(field.name);
        const required = field.required !== false && !stored;
        const hint = [field.help, stored ? 'A value is stored; leave blank to keep it.' : null]
          .filter(Boolean)
          .join(' ');
        const id = credentialFieldId(idPrefix, field.name);
        const common = {
          id,
          name: `${FIELD_PREFIX}${field.name}`,
          required,
          disabled,
          placeholder: field.placeholder,
          autoComplete: 'off',
          spellCheck: false,
        };
        return (
          <Field
            key={field.name}
            htmlFor={id}
            label={field.required === false ? `${field.label} (optional)` : field.label}
            hint={hint || undefined}
          >
            {isMultiline(field) ? (
              <Textarea {...common} rows={4} className={styles.mono} />
            ) : (
              <Input
                {...common}
                type={field.secret ? 'password' : 'text'}
                autoComplete={field.secret ? 'new-password' : 'off'}
                defaultValue={field.secret ? undefined : (values[field.name] ?? '')}
                pattern={field.secret ? undefined : field.pattern}
              />
            )}
          </Field>
        );
      })}
    </>
  );
}

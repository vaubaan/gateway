/**
 * The form of one sign-in provider (Settings → Sign-in): add one, or edit one
 * saved here. A plain HTML form posting to `/api/admin/sign-in-providers`; the
 * server validates everything again and sends the problems back. The client
 * secret is never shown back: blank keeps the stored one, for the same issuer.
 *
 * Admission is one of three rules, as radio buttons: everyone the directory
 * signs in (a company directory only — the server refuses it for an open
 * provider such as GitHub or personal Google accounts), the people of some
 * email domains and the invited addresses, or the invited addresses only.
 */
import styles from '@/components/settings/settings.module.css';
import { Button, ButtonLink, CodeBlock, Field, Input, Radio } from '@/components/ui';
import { ACTIONS, SETTINGS_ACTIONS } from '@/lib/vocabulary';

export type AdmissionChoice = 'everyone' | 'domains' | 'invited';

export interface SignInProviderFormValues {
  readonly kind: 'oidc' | 'github';
  /** A preset the form was opened with (Google, Entra ID): fills the issuer or asks for the tenant. */
  readonly preset?: 'google' | 'entra';
  readonly id: string;
  readonly name: string;
  readonly issuer: string;
  /** The Entra tenant (id or domain), when the preset asks for it instead of the issuer. */
  readonly tenant?: string;
  readonly clientId: string;
  readonly claims: { readonly sub: string; readonly email: string; readonly groups: string };
  readonly domains: string;
  readonly admission: AdmissionChoice;
}

export function admissionOf(provider: {
  readonly allowedEmailDomains: readonly string[];
  readonly invitationOnly: boolean;
}): AdmissionChoice {
  if (provider.invitationOnly) return 'invited';
  return provider.allowedEmailDomains.length > 0 ? 'domains' : 'everyone';
}

export function SignInProviderForm({
  mode,
  values,
  hasSecret,
  callbackUrl,
  cancelHref,
}: {
  mode: 'create' | 'update';
  values: SignInProviderFormValues;
  /** A secret is stored for this provider (edit): blank keeps it. */
  hasSecret: boolean;
  /** The address to register at the provider. */
  callbackUrl: string;
  cancelHref: string;
}) {
  const github = values.kind === 'github';
  const entra = values.preset === 'entra';
  const google = values.preset === 'google';
  const prefix = `sign-in-${mode}`;
  return (
    <form method="post" action="/api/admin/sign-in-providers" className={styles.form}>
      <input type="hidden" name="mode" value={mode} />
      <input type="hidden" name="kind" value={values.kind} />
      {values.preset && <input type="hidden" name="preset" value={values.preset} />}
      {mode === 'update' && <input type="hidden" name="provider_id" value={values.id} />}
      <div className={styles.block}>
        <CodeBlock label={github ? 'Authorization callback URL' : 'Redirect URI'}>
          {callbackUrl}
        </CodeBlock>
      </div>
      {mode === 'create' && (
        <Field
          label="Id"
          shape="lower-case letters, digits and hyphens; it ends the address above"
          htmlFor={`${prefix}-id`}
          hint="It cannot change later. It also names the provider in the admin rule (id:group)."
        >
          <Input
            id={`${prefix}-id`}
            name="provider_id"
            required
            pattern="[a-z][a-z0-9-]{0,31}"
            defaultValue={values.id}
            autoComplete="off"
            mono
          />
        </Field>
      )}
      <Field label="Name on the sign-in button" htmlFor={`${prefix}-name`} optional>
        <Input
          id={`${prefix}-name`}
          name="name"
          defaultValue={values.name}
          placeholder={github ? 'GitHub' : 'Acme (Entra ID)'}
        />
      </Field>
      {entra ? (
        <Field
          label="Tenant"
          shape="the tenant ID (a GUID) or the tenant domain"
          htmlFor={`${prefix}-tenant`}
          hint="From the Entra admin center, Overview of your tenant. The issuer becomes https://login.microsoftonline.com/<tenant>/v2.0."
        >
          <Input
            id={`${prefix}-tenant`}
            name="tenant"
            required
            defaultValue={values.tenant ?? ''}
            placeholder="contoso.onmicrosoft.com"
            autoComplete="off"
            mono
          />
        </Field>
      ) : (
        <Field
          label={github ? 'GitHub Enterprise Server address' : 'Issuer URL'}
          shape={github ? 'https; leave blank for github.com' : 'https, as the provider prints it'}
          optional={github}
          htmlFor={`${prefix}-issuer`}
          hint={
            github
              ? undefined
              : google
                ? 'Google’s one issuer, for every account and every Workspace.'
                : 'Discovery runs against <issuer>/.well-known/openid-configuration.'
          }
        >
          <Input
            id={`${prefix}-issuer`}
            name="issuer"
            type="url"
            required={!github}
            defaultValue={values.issuer}
            placeholder={
              github ? 'https://github.example.com' : 'https://login.example.com/realms/acme'
            }
            readOnly={google}
            mono
          />
        </Field>
      )}
      <Field
        label="Client ID"
        htmlFor={`${prefix}-client-id`}
        hint={
          github
            ? 'Of the OAuth App you registered at GitHub.'
            : entra
              ? 'The "Application (client) ID" of the app registration.'
              : google
                ? 'Of the OAuth client ID you created in the Google Cloud Console.'
                : undefined
        }
      >
        <Input
          id={`${prefix}-client-id`}
          name="client_id"
          required
          defaultValue={values.clientId}
          autoComplete="off"
          mono
        />
      </Field>
      <Field
        label="Client secret"
        htmlFor={`${prefix}-client-secret`}
        hint={
          hasSecret
            ? 'A secret is stored; leave blank to keep it. It is asked again when the address changes.'
            : 'Stored encrypted with the master key; never shown again.'
        }
      >
        <Input
          id={`${prefix}-client-secret`}
          name="client_secret"
          type="password"
          autoComplete="new-password"
          required={!hasSecret}
          mono
        />
      </Field>
      {!github && (
        <Field
          label="Claim names"
          shape="subject, email, teams"
          hint="As they appear in the ID token or userinfo. Entra ID sends team ids, not names, unless the app is configured for names."
        >
          <div className={styles.claims}>
            <Input
              name="claim_sub"
              required
              defaultValue={values.claims.sub}
              aria-label="Subject claim"
              mono
            />
            <Input
              name="claim_email"
              required
              defaultValue={values.claims.email}
              aria-label="Email claim"
              mono
            />
            <Input
              name="claim_groups"
              required
              defaultValue={values.claims.groups}
              aria-label="Groups claim"
              mono
            />
          </div>
        </Field>
      )}
      <Field
        label="Who may sign in"
        hint="Invited addresses (Settings → People) and the administrators’ emails are always admitted, on an address the provider verified."
      >
        <div className={styles.form}>
          {!github && (
            <Radio
              name="admission"
              value="everyone"
              defaultChecked={values.admission === 'everyone'}
            >
              Everyone your directory signs in — only for your company’s own provider; refused for
              one where anyone can open an account
            </Radio>
          )}
          <Radio name="admission" value="domains" defaultChecked={values.admission === 'domains'}>
            People of these email domains, and invited people
          </Radio>
          <Input
            name="allowed_email_domains"
            defaultValue={values.domains}
            placeholder="example.com"
            aria-label="Allowed email domains, separated by spaces or commas"
          />
          <Radio name="admission" value="invited" defaultChecked={values.admission === 'invited'}>
            Invited people only
          </Radio>
        </div>
      </Field>
      <div className={styles.formActions}>
        <Button type="submit" variant="primary">
          {mode === 'create' ? SETTINGS_ACTIONS.addProvider : SETTINGS_ACTIONS.save}
        </Button>
        <ButtonLink href={cancelHref} variant="ghost">
          {ACTIONS.cancel}
        </ButtonLink>
      </div>
    </form>
  );
}

/**
 * The form of a local-accounts provider (ADR local-accounts-sign-in-provider):
 * an id and a name, nothing to register anywhere. The accounts themselves are
 * created from People (invitations) and from the setup.
 */
export function LocalSignInProviderForm({
  mode,
  id,
  name,
  cancelHref,
}: {
  mode: 'create' | 'update';
  id: string;
  name: string;
  cancelHref: string;
}) {
  const prefix = `sign-in-local-${mode}`;
  return (
    <form method="post" action="/api/admin/sign-in-providers" className={styles.form}>
      <input type="hidden" name="mode" value={mode} />
      <input type="hidden" name="kind" value="local" />
      {mode === 'update' && <input type="hidden" name="provider_id" value={id} />}
      {mode === 'create' && (
        <Field
          label="Id"
          shape="lower-case letters, digits and hyphens"
          htmlFor={`${prefix}-id`}
          hint="It cannot change later. It also names the provider in the admin rule (id:group)."
        >
          <Input
            id={`${prefix}-id`}
            name="provider_id"
            required
            pattern="[a-z][a-z0-9-]{0,31}"
            defaultValue={id}
            autoComplete="off"
            mono
          />
        </Field>
      )}
      <Field
        label="Name on the sign-in page"
        htmlFor={`${prefix}-name`}
        optional
        hint="People sign in with their email address and password, then a code from their authenticator app; nothing to register at any service."
      >
        <Input
          id={`${prefix}-name`}
          name="name"
          defaultValue={name}
          placeholder="Email and password"
        />
      </Field>
      <div className={styles.formActions}>
        <Button type="submit" variant="primary">
          {mode === 'create' ? SETTINGS_ACTIONS.addProvider : SETTINGS_ACTIONS.save}
        </Button>
        <ButtonLink href={cancelHref} variant="ghost">
          {ACTIONS.cancel}
        </ButtonLink>
      </div>
    </form>
  );
}

/**
 * The OAuth client an administrator declares for a service that connects
 * through the service's own sign-in (`oauth2`, Gmail today): the redirect
 * address to register at the service and the fields the plugin asks for
 * (`ProviderAppStatus.fields`), on the service's connect page (ADR
 * one-place-to-authorize-services-token-first). Secrets are sealed in
 * `instance_config` and never echoed; a service set by the mounted
 * configuration is read-only here (the file wins).
 */
import { CredentialFieldInputs } from '@/components/connections/parts';
import styles from '@/components/settings/settings.module.css';
import { Button, CodeBlock } from '@/components/ui';
import { CONFIG_WORDS, SETTINGS_ACTIONS } from '@/lib/vocabulary';
import { CLEAR_PROVIDER_APP_ACTION, providerAppActionPath } from '@/server/connections';
import type { ProviderAppStatus } from '@/server/provider-apps';

export function OAuthClientForm({
  app,
  callbackUrl,
}: {
  app: ProviderAppStatus;
  /** The redirect address to register at the service. */
  callbackUrl: string;
}) {
  const readOnly = app.source === 'file';
  return (
    <div className={styles.detail} data-testid={`oauth-client-form-${app.providerId}`}>
      <div className={styles.block}>
        <p className={styles.quiet}>Redirect address to register at {app.displayName}:</p>
        <CodeBlock label="Address to register">{callbackUrl}</CodeBlock>
      </div>
      <form method="post" action={providerAppActionPath(app.providerId)} className={styles.form}>
        <fieldset disabled={readOnly} className={styles.fieldset}>
          <CredentialFieldInputs
            idPrefix={`provider-app-${app.providerId}`}
            fields={app.fields}
            values={app.values}
            secretsSet={app.secretsSet}
            disabled={readOnly}
          />
          <div className={styles.formActions}>
            <Button type="submit" variant="primary" size="sm" disabled={readOnly}>
              {SETTINGS_ACTIONS.save}
            </Button>
            {app.source === 'store' && (
              <Button
                type="submit"
                name="action"
                value={CLEAR_PROVIDER_APP_ACTION}
                variant="danger"
                size="sm"
                formNoValidate
              >
                {SETTINGS_ACTIONS.remove}
              </Button>
            )}
            {readOnly && <span className={styles.formHint}>{CONFIG_WORDS.fileReadOnly}</span>}
          </div>
        </fieldset>
      </form>
    </div>
  );
}

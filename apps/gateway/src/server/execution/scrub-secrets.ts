/**
 * A service's error text, without the account's secrets in it.
 *
 * The `detail` of a failed call is the service's own message, returned to the
 * agent. A service that echoes what it was sent ("invalid token ghp_…", a
 * request dump, a URL with its key) would hand the agent the credential the
 * gateway exists to keep from it. Every secret value of the credentials the call
 * used is replaced before the text leaves.
 *
 * What a plugin derived from the credential itself (an installation token it
 * minted, a signed request) is not known here and is not scrubbed: the plugin's
 * own error handling owns that.
 */
import type { CredentialSecret, CredentialSpec } from '@vaubaan/plugin-sdk';

/** What a secret is replaced with. */
export const SCRUBBED = '[credential]';

/** Below this length a value is not looked for: it would match ordinary words. */
const SECRET_LENGTH_MIN = 6;

/**
 * The secret values of `secret`: the tokens of an OAuth account, the private key
 * of an SSH account, the fields of an API-key account its spec marks secret (a
 * field the spec does not know counts as secret).
 */
export function secretValuesOf(spec: CredentialSpec, secret: CredentialSecret): string[] {
  const values: string[] = [];
  switch (secret.kind) {
    case 'oauth2':
      values.push(secret.accessToken);
      if (secret.refreshToken !== null) values.push(secret.refreshToken);
      break;
    case 'ssh-key':
      values.push(secret.privateKeyPem);
      break;
    case 'api-key': {
      const declared = spec.kind === 'api-key' ? spec.fields : [];
      for (const [name, value] of Object.entries(secret.fields)) {
        const field = declared.find((f) => f.name === name);
        if (field === undefined || field.secret) values.push(value);
      }
      break;
    }
    case 'host':
      break;
  }
  return values.filter((v) => v.length >= SECRET_LENGTH_MIN);
}

/** `text` with every value of `secrets` replaced by {@link SCRUBBED}, the longest first. */
export function scrubSecrets(text: string, secrets: Iterable<string>): string {
  const ordered = [...new Set(secrets)].sort((a, b) => b.length - a.length);
  let out = text;
  for (const secret of ordered) {
    if (secret.length >= SECRET_LENGTH_MIN) out = out.split(secret).join(SCRUBBED);
  }
  return out;
}

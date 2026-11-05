/**
 * `/.well-known/microsoft-identity-association.json`: the file Microsoft reads
 * to verify that vaubaan.com is the publisher domain of an Entra application
 * (the OAuth broker's `microsoft` client; handbook oauth-broker-contract,
 * "Outside the repo"). The application ids come from the request-time
 * variable `MICROSOFT_IDENTITY_APP_IDS` (comma-separated GUIDs), never from
 * the code: without it, or with nothing valid in it, the route answers 404.
 */

export const MICROSOFT_IDENTITY_APP_IDS = 'MICROSOFT_IDENTITY_APP_IDS';

/** An Entra application (client) id: a lowercase GUID. */
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The ids of the variable, lower-cased, in order, without the values that are not GUIDs. */
export function microsoftIdentityAppIds(raw: string | undefined): readonly string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((id) => id.trim().toLowerCase())
    .filter((id) => GUID.test(id));
}

/** The JSON document Microsoft expects, or `null` when no application id is configured. */
export function microsoftIdentityAssociation(raw: string | undefined): string | null {
  const ids = microsoftIdentityAppIds(raw);
  if (ids.length === 0) return null;
  const document = {
    associatedApplications: ids.map((applicationId) => ({ applicationId })),
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

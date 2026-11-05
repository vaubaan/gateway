/**
 * `/.well-known/microsoft-identity-association.json`: Microsoft's publisher
 * domain check for the Entra applications named by `MICROSOFT_IDENTITY_APP_IDS`
 * (handbook website, "Outside the repo"). Read at request time, so the
 * variable takes effect without a build; 404 when it is unset.
 */
import {
  MICROSOFT_IDENTITY_APP_IDS,
  microsoftIdentityAssociation,
} from '../../../site/microsoft-identity';

export const dynamic = 'force-dynamic';

export function GET(): Response {
  const body = microsoftIdentityAssociation(process.env[MICROSOFT_IDENTITY_APP_IDS]);
  if (body === null) return new Response(null, { status: 404 });
  return new Response(body, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  });
}

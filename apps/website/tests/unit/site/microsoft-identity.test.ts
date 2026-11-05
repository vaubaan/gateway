/**
 * The publisher-domain file Microsoft reads at
 * `/.well-known/microsoft-identity-association.json`: built from the
 * request-time variable only, in Microsoft's shape, absent when nothing is
 * configured.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { GET } from '../../../src/app/.well-known/microsoft-identity-association.json/route';
import {
  MICROSOFT_IDENTITY_APP_IDS,
  microsoftIdentityAppIds,
  microsoftIdentityAssociation,
} from '../../../src/site/microsoft-identity';

const APP = '2dc89dc1-b431-4b24-a5bc-ab58948580fe';
const OTHER = '11111111-2222-3333-4444-555555555555';

describe('microsoftIdentityAppIds', () => {
  it('reads comma-separated GUIDs, trimmed and lower-cased, in order', () => {
    expect(microsoftIdentityAppIds(` ${APP.toUpperCase()} , ${OTHER}`)).toEqual([APP, OTHER]);
  });

  it('drops anything that is not a GUID and answers nothing for an empty variable', () => {
    expect(microsoftIdentityAppIds(`${APP},not-a-guid,,${APP}x`)).toEqual([APP]);
    expect(microsoftIdentityAppIds(undefined)).toEqual([]);
    expect(microsoftIdentityAppIds('')).toEqual([]);
  });
});

describe('microsoftIdentityAssociation', () => {
  it("writes Microsoft's document", () => {
    expect(JSON.parse(microsoftIdentityAssociation(APP) ?? 'null')).toEqual({
      associatedApplications: [{ applicationId: APP }],
    });
  });

  it('is null without a valid id', () => {
    expect(microsoftIdentityAssociation(undefined)).toBeNull();
    expect(microsoftIdentityAssociation('nope')).toBeNull();
  });
});

describe('GET /.well-known/microsoft-identity-association.json', () => {
  const previous = process.env[MICROSOFT_IDENTITY_APP_IDS];
  afterEach(() => {
    if (previous === undefined) delete process.env[MICROSOFT_IDENTITY_APP_IDS];
    else process.env[MICROSOFT_IDENTITY_APP_IDS] = previous;
  });

  it('answers the document as JSON when the variable is set', async () => {
    process.env[MICROSOFT_IDENTITY_APP_IDS] = APP;
    const response = GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await response.json()).toEqual({ associatedApplications: [{ applicationId: APP }] });
  });

  it('answers 404 when the variable is unset', () => {
    delete process.env[MICROSOFT_IDENTITY_APP_IDS];
    expect(GET().status).toBe(404);
  });
});

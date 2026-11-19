/**
 * The trust level of an archive (ADR plugin-signature-sets-the-trust-level), over a real
 * Sigstore bundle: cosign's own release signs `cosign_checksums.txt` keyless, so the
 * signature verifies offline against the embedded trusted root — and is still refused as
 * "Vaubaan", because the certificate names another identity. The positive case needs an
 * archive the catalog signed (tests/integration/plugins, once a release exists); here the
 * identity is set to cosign's to prove the comparison passes when it matches.
 */
import { readFileSync } from 'node:fs';

import { readArchive } from '@vaubaan/plugin-sdk/archive';

import {
  ARCHIVE_MANIFEST_FILE,
  generateSigningKey,
  SIGNATURE_FILE,
  signManifest,
} from '@vaubaan/plugin-sdk/archive';
import { describe, expect, it } from 'vitest';

import {
  certificateExtension,
  SIGSTORE_BUNDLE_FILE,
  trustOf,
  VAUBAAN_CATALOG_IDENTITY,
  type CatalogIdentity,
} from './trust';

const FIXTURES = new URL('../../../tests/fixtures/sigstore/', import.meta.url);
const SIGNED = readFileSync(new URL('cosign_checksums.txt', FIXTURES));
const BUNDLE = readFileSync(new URL('cosign_checksums.txt.sigstore.json', FIXTURES));
const CERT = Buffer.from(
  (
    JSON.parse(BUNDLE.toString('utf8')) as {
      verificationMaterial: { certificate: { rawBytes: string } };
    }
  ).verificationMaterial.certificate.rawBytes,
  'base64',
);

/** The files of an "archive" whose manifest is cosign's checksums file, signed by cosign's release. */
function cosignSigned(bundle: Uint8Array = BUNDLE): Map<string, Uint8Array> {
  return new Map([
    [ARCHIVE_MANIFEST_FILE, SIGNED],
    [SIGSTORE_BUNDLE_FILE, bundle],
  ]);
}

/** Cosign's own release identity, read from its certificate. */
function cosignIdentity(san: string): CatalogIdentity {
  return {
    subjectAlternativeName: san,
    issuer: certificateExtension(CERT, '1.3.6.1.4.1.57264.1.8') ?? '',
    repositoryId: certificateExtension(CERT, '1.3.6.1.4.1.57264.1.15'),
  };
}

describe('the trust level of an archive', () => {
  it('recognises an archive the catalog published as signed by Vaubaan, offline', () => {
    // notion 0.2.0, as the release workflow of vaubaan/gateway-plugins published it.
    const archive = readArchive(readFileSync(new URL('notion-v0.2.0.tgz', FIXTURES)));
    expect(archive.manifest).toMatchObject({ id: 'notion', version: '0.2.0' });
    expect(trustOf(archive.files, { trustedKeys: [] })).toEqual({ level: 'vaubaan' });
  });

  it('refuses the catalog’s signature over a manifest changed since', () => {
    const files = new Map(readArchive(readFileSync(new URL('notion-v0.2.0.tgz', FIXTURES))).files);
    const manifest = Buffer.from(files.get(ARCHIVE_MANIFEST_FILE) as Uint8Array).toString('utf8');
    files.set(ARCHIVE_MANIFEST_FILE, Buffer.from(manifest.replace('0.2.0', '0.2.1')));
    expect(trustOf(files, { trustedKeys: [] })).toMatchObject({ level: 'invalid' });
  });

  it('refuses a valid Sigstore signature of another identity as Vaubaan', () => {
    const verdict = trustOf(cosignSigned(), { trustedKeys: [] });
    expect(verdict).toMatchObject({ level: 'invalid' });
    expect((verdict as { reason: string }).reason).toMatch(/not the catalog's release/);
  });

  it('accepts it when the identity is exactly the one expected, offline', () => {
    const issuer = certificateExtension(CERT, '1.3.6.1.4.1.57264.1.8');
    expect(issuer).toMatch(/^https:\/\//);
    // The subject alternative name is read by the verifier; a wrong one is refused above.
    const sanOf = (verdict: ReturnType<typeof trustOf>): string =>
      (verdict as { reason?: string }).reason?.replace(/^signed by (.*), not.*$/, '$1') ?? '';
    const san = sanOf(trustOf(cosignSigned(), { trustedKeys: [] }));
    expect(
      trustOf(cosignSigned(), { trustedKeys: [], catalogIdentity: cosignIdentity(san) }),
    ).toEqual({
      level: 'vaubaan',
    });
  });

  it('never matches an identity by substring or pattern', () => {
    const san = (trustOf(cosignSigned(), { trustedKeys: [] }) as { reason: string }).reason.replace(
      /^signed by (.*), not.*$/,
      '$1',
    );
    for (const lookalike of [san.slice(0, -1), `${san}x`, san.replace('.', '-')]) {
      expect(
        trustOf(cosignSigned(), { trustedKeys: [], catalogIdentity: cosignIdentity(lookalike) }),
        lookalike,
      ).toMatchObject({ level: 'invalid' });
    }
  });

  it('refuses a DSSE envelope: only a signature of the manifest itself counts', () => {
    const json = JSON.parse(BUNDLE.toString('utf8')) as Record<string, unknown>;
    delete json.messageSignature;
    json.dsseEnvelope = {
      payload: Buffer.from('{}').toString('base64'),
      payloadType: 'application/vnd.in-toto+json',
      signatures: [{ sig: Buffer.from('sig').toString('base64'), keyid: '' }],
    };
    const verdict = trustOf(cosignSigned(Buffer.from(JSON.stringify(json))), {
      trustedKeys: [],
    });
    expect(verdict).toEqual({
      level: 'invalid',
      reason: 'the Sigstore bundle does not sign the manifest itself',
    });
  });

  it('reads an extension from the parsed certificate, never from bytes that only look like one', () => {
    // The issuer extension's encoding, followed by a string, outside any certificate.
    const oid = Buffer.from([
      0x06, 0x0a, 0x2b, 0x06, 0x01, 0x04, 0x01, 0x83, 0xbf, 0x30, 0x01, 0x08,
    ]);
    const lookalike = Buffer.concat([
      oid,
      Buffer.from([0x04, 0x06, 0x0c, 0x04]),
      Buffer.from('evil'),
    ]);
    expect(certificateExtension(lookalike, '1.3.6.1.4.1.57264.1.8')).toBeNull();
    expect(
      certificateExtension(Buffer.concat([lookalike, CERT]), '1.3.6.1.4.1.57264.1.8'),
    ).toBeNull();
    expect(certificateExtension(CERT, '1.3.6.1.4.1.57264.1.8')).toBe('https://accounts.google.com');
  });

  it('refuses a manifest changed after it was signed', () => {
    const files = cosignSigned();
    files.set(ARCHIVE_MANIFEST_FILE, Buffer.concat([SIGNED, Buffer.from('\n')]));
    expect(trustOf(files, { trustedKeys: [] })).toMatchObject({ level: 'invalid' });
  });

  it('names the trusted key that signed, and refuses an unknown one', () => {
    const manifest = Buffer.from('{"format":"vaubaan-plugin-manifest/v1"}');
    const key = generateSigningKey();
    const files = new Map<string, Uint8Array>([
      [ARCHIVE_MANIFEST_FILE, manifest],
      [SIGNATURE_FILE, Buffer.from(JSON.stringify(signManifest(manifest, key.privateKeyPem)))],
    ]);
    expect(
      trustOf(files, {
        trustedKeys: [{ name: 'Acme release key', publicKeyPem: key.publicKeyPem }],
      }),
    ).toEqual({ level: 'signer', signer: 'Acme release key' });
    expect(trustOf(files, { trustedKeys: [] })).toMatchObject({ level: 'invalid' });
  });

  it('is unsigned with neither file', () => {
    expect(
      trustOf(new Map([[ARCHIVE_MANIFEST_FILE, Buffer.from('{}')]]), { trustedKeys: [] }),
    ).toEqual({
      level: 'unsigned',
    });
  });

  it('expects the catalog of vaubaan/gateway-plugins on main, by its repository id too', () => {
    expect(VAUBAAN_CATALOG_IDENTITY.repositoryId).toBe('1462543575');
    expect(VAUBAAN_CATALOG_IDENTITY.subjectAlternativeName).toBe(
      'https://github.com/vaubaan/gateway-plugins/.github/workflows/release.yml@refs/heads/main',
    );
  });
});

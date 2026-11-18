/**
 * The trust level of a plugin archive (ADR plugin-signature-sets-the-trust-level; spec
 * vaubaan-gateway §5): what its verified signature says of who built it, computed here at
 * every upload and every start, never read from the archive.
 *
 *   vaubaan    `vaubaan-manifest.json.sigstore.json`: a Sigstore bundle over the manifest,
 *              verified offline against the trusted root embedded in this release, whose
 *              certificate names exactly the catalog's release workflow on main, GitHub's
 *              issuer and the catalog repository's numeric id
 *   signer     `vaubaan-manifest.json.sig.json`: an ed25519 signature by a key the instance's
 *              administrators named as trusted
 *   unsigned   neither file
 *   invalid    a signature present that does not verify, or names an identity or a key this
 *              instance does not trust: never loaded, never installed
 *
 * The identity is compared for equality, field by field: the library's own policy matches a
 * string as an unanchored pattern, which would accept a look-alike workflow.
 */
import { bundleFromJSON } from '@sigstore/bundle';
import { TrustedRoot } from '@sigstore/protobuf-specs';
import { toSignedEntity, toTrustMaterial, Verifier } from '@sigstore/verify';
import {
  ARCHIVE_MANIFEST_FILE,
  parseSignature,
  SIGNATURE_FILE,
  verifyManifestSignature,
  type TrustedKey,
} from '@vaubaan/plugin-sdk/archive';

import embeddedRoot from './sigstore-trusted-root.json' with { type: 'json' };

/** The Sigstore bundle of a catalog archive, beside its manifest. */
export const SIGSTORE_BUNDLE_FILE = `${ARCHIVE_MANIFEST_FILE}.sigstore.json`;

/** Who signs "Vaubaan": the catalog's release workflow (ADR plugin-catalog-rebuilt-from-source). */
export interface CatalogIdentity {
  /** The certificate's subject alternative name: the workflow file at its ref. */
  readonly subjectAlternativeName: string;
  /** The OIDC issuer (certificate extension 1.3.6.1.4.1.57264.1.8). */
  readonly issuer: string;
  /**
   * The repository's numeric id (extension 1.3.6.1.4.1.57264.1.15): survives a rename. The
   * catalog's always names one; `null` only for an identity outside GitHub (tests).
   */
  readonly repositoryId: string | null;
}

export const VAUBAAN_CATALOG_IDENTITY: CatalogIdentity = {
  subjectAlternativeName:
    'https://github.com/vaubaan/gateway-plugins/.github/workflows/release.yml@refs/heads/main',
  issuer: 'https://token.actions.githubusercontent.com',
  repositoryId: '1462543575',
};

export type TrustVerdict =
  | { readonly level: 'vaubaan' }
  | { readonly level: 'signer'; readonly signer: string }
  | { readonly level: 'unsigned' }
  | { readonly level: 'invalid'; readonly reason: string };

export interface TrustInputs {
  /** The keys the administrators named as trusted. */
  readonly trustedKeys: readonly TrustedKey[];
  /** Tests: another identity; default the catalog's. */
  readonly catalogIdentity?: CatalogIdentity;
  /** Tests or an air-gapped site: another trusted root (its protobuf JSON); default the embedded one. */
  readonly trustedRoot?: unknown;
}

const verifiers = new WeakMap<object, Verifier>();

function verifierFor(root: unknown): Verifier {
  const key = root as object;
  let verifier = verifiers.get(key);
  if (verifier === undefined) {
    verifier = new Verifier(toTrustMaterial(TrustedRoot.fromJSON(root)), {
      tlogThreshold: 1,
      ctlogThreshold: 1,
      timestampThreshold: 1,
    });
    verifiers.set(key, verifier);
  }
  return verifier;
}

/** The DER of an OID, its content bytes only. */
function oidBytes(oid: string): Buffer {
  const parts = oid.split('.').map(Number);
  const out: number[] = [40 * (parts[0] as number) + (parts[1] as number)];
  for (const part of parts.slice(2)) {
    const groups: number[] = [];
    let value = part;
    do {
      groups.unshift(value & 0x7f);
      value >>>= 7;
    } while (value > 0);
    for (let index = 0; index < groups.length - 1; index += 1)
      groups[index] = (groups[index] as number) | 0x80;
    out.push(...groups);
  }
  return Buffer.from(out);
}

function lengthAt(der: Buffer, offset: number): { length: number; next: number } | null {
  const first = der[offset];
  if (first === undefined) return null;
  if (first < 0x80) return { length: first, next: offset + 1 };
  const count = first & 0x7f;
  if (count < 1 || count > 3) return null;
  let length = 0;
  for (let index = 1; index <= count; index += 1)
    length = length * 256 + (der[offset + index] ?? 0);
  return { length, next: offset + 1 + count };
}

/**
 * The text of a Fulcio certificate extension: the OID, then an OCTET STRING holding a
 * UTF8String (the newer extensions), or the raw string (the older ones). `null` when absent.
 */
export function certificateExtension(der: Buffer, oid: string): string | null {
  const encoded = Buffer.concat([Buffer.from([0x06, oidBytes(oid).length]), oidBytes(oid)]);
  const at = der.indexOf(encoded);
  if (at < 0) return null;
  let offset = at + encoded.length;
  if (der[offset] === 0x01) offset += 3; // a `critical` BOOLEAN
  if (der[offset] !== 0x04) return null;
  const octet = lengthAt(der, offset + 1);
  if (octet === null) return null;
  const inner = der.subarray(octet.next, octet.next + octet.length);
  if (inner[0] === 0x0c) {
    const utf8 = lengthAt(inner, 1);
    return utf8 === null
      ? null
      : inner.subarray(utf8.next, utf8.next + utf8.length).toString('utf8');
  }
  return inner.toString('utf8');
}

const OID_ISSUER_V2 = '1.3.6.1.4.1.57264.1.8';
const OID_REPOSITORY_ID = '1.3.6.1.4.1.57264.1.15';

function sigstoreVerdict(
  manifest: Uint8Array,
  bundleBytes: Uint8Array,
  inputs: TrustInputs,
): TrustVerdict {
  const identity = inputs.catalogIdentity ?? VAUBAAN_CATALOG_IDENTITY;
  let parsed;
  try {
    parsed = bundleFromJSON(JSON.parse(Buffer.from(bundleBytes).toString('utf8')));
  } catch {
    return { level: 'invalid', reason: 'the Sigstore bundle is not one this gateway reads' };
  }
  let signer;
  try {
    signer = verifierFor(inputs.trustedRoot ?? embeddedRoot).verify(
      toSignedEntity(parsed, Buffer.from(manifest)),
    );
  } catch (err) {
    return {
      level: 'invalid',
      reason: `the Sigstore signature does not verify: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const san = signer.identity?.subjectAlternativeName;
  if (san !== identity.subjectAlternativeName) {
    return {
      level: 'invalid',
      reason: `signed by ${san ?? 'an unnamed identity'}, not the catalog's release`,
    };
  }
  const material = parsed.verificationMaterial.content;
  const der =
    material.$case === 'certificate'
      ? material.certificate.rawBytes
      : material.$case === 'x509CertificateChain'
        ? material.x509CertificateChain.certificates[0]?.rawBytes
        : undefined;
  if (der === undefined)
    return { level: 'invalid', reason: 'no signing certificate in the bundle' };
  const cert = Buffer.from(der);
  if (certificateExtension(cert, OID_ISSUER_V2) !== identity.issuer) {
    return { level: 'invalid', reason: 'the certificate was not issued for GitHub Actions' };
  }
  if (
    identity.repositoryId !== null &&
    certificateExtension(cert, OID_REPOSITORY_ID) !== identity.repositoryId
  ) {
    return { level: 'invalid', reason: 'the certificate names another repository' };
  }
  return { level: 'vaubaan' };
}

/**
 * The trust level of an archive's files (from an upload, or read back from its folder).
 * The manifest must be among them; whether every other file matches it is checked
 * elsewhere (`readArchive`, `installedFolderProblem`).
 */
export function trustOf(files: ReadonlyMap<string, Uint8Array>, inputs: TrustInputs): TrustVerdict {
  const manifest = files.get(ARCHIVE_MANIFEST_FILE);
  if (manifest === undefined) return { level: 'invalid', reason: `no ${ARCHIVE_MANIFEST_FILE}` };
  const bundle = files.get(SIGSTORE_BUNDLE_FILE);
  if (bundle !== undefined) return sigstoreVerdict(manifest, bundle, inputs);
  const raw = files.get(SIGNATURE_FILE);
  if (raw === undefined) return { level: 'unsigned' };
  let signature;
  try {
    signature = parseSignature(JSON.parse(Buffer.from(raw).toString('utf8')));
  } catch {
    signature = null;
  }
  if (signature === null)
    return { level: 'invalid', reason: `${SIGNATURE_FILE} is not a signature this gateway reads` };
  const key = verifyManifestSignature(manifest, signature, inputs.trustedKeys);
  if (key === null) {
    return {
      level: 'invalid',
      reason: `signed by the key ${signature.keyId}, which this instance does not trust (or the signature does not verify)`,
    };
  }
  return { level: 'signer', signer: key.name };
}

/** What the instance admits, given who signed (ADR plugin-signature-sets-the-trust-level). */
export interface AdmissionRules {
  /** Ids only a Vaubaan signature may carry: the image's plugins and the catalog's. */
  readonly reservedIds: ReadonlySet<string>;
  /** `plugins.allow_unsigned`. */
  readonly allowUnsigned: ReadonlySet<string>;
}

export type AdmissionCode = 'signature-invalid' | 'reserved-id' | 'unsigned-not-allowed';

/**
 * Why an archive of `pluginId` with this verdict is not admitted, or `null`. The same rule at
 * upload and at every start: a key removed since, or an id the catalog took since, turns a
 * version away at the next start too.
 */
export function admissionProblem(
  pluginId: string,
  verdict: TrustVerdict,
  rules: AdmissionRules,
): { readonly code: AdmissionCode; readonly message: string } | null {
  if (verdict.level === 'invalid') return { code: 'signature-invalid', message: verdict.reason };
  if (verdict.level !== 'vaubaan' && rules.reservedIds.has(pluginId)) {
    return {
      code: 'reserved-id',
      message: `'${pluginId}' is a plugin of the image or the catalog: only a version signed by Vaubaan may replace it`,
    };
  }
  if (verdict.level === 'unsigned' && !rules.allowUnsigned.has(pluginId)) {
    return {
      code: 'unsigned-not-allowed',
      message: `'${pluginId}' is not signed, and plugins.allow_unsigned does not name it`,
    };
  }
  return null;
}

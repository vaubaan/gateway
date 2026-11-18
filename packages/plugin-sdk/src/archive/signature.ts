/**
 * The signature of an archive by a company key (ADR plugin-signature-sets-the-trust-level):
 * an ed25519 signature over the archive's manifest, in `vaubaan-manifest.json.sig.json`
 * beside it. A private plugin is signed this way; nothing about it is published.
 *
 *   {
 *     "format": "vaubaan-plugin-signature/v1",
 *     "alg": "ed25519",
 *     "keyId": "sha256:<hex sha256 of the public key's SPKI DER>",
 *     "signedFile": "vaubaan-manifest.json",
 *     "signature": "<base64 of 64 bytes>"
 *   }
 *
 * What is signed is `SIGNATURE_CONTEXT` followed by the manifest's bytes: a signature
 * made for something else cannot be replayed as one of a manifest. The key id lets an
 * instance hold several keys and rotate them. A key made with OpenSSL
 * (`openssl genpkey -algorithm ed25519`) works as well.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';

// The manifest's name, written here rather than imported: `index.ts` re-exports this module.
const ARCHIVE_MANIFEST_FILE = 'vaubaan-manifest.json';

export const SIGNATURE_FILE = `${ARCHIVE_MANIFEST_FILE}.sig.json`;
export const SIGNATURE_FORMAT = 'vaubaan-plugin-signature/v1';
const SIGNATURE_CONTEXT = Buffer.from('vaubaan-plugin-manifest-v1\n', 'utf8');

export interface ArchiveSignature {
  readonly format: typeof SIGNATURE_FORMAT;
  readonly alg: 'ed25519';
  readonly keyId: string;
  readonly signedFile: typeof ARCHIVE_MANIFEST_FILE;
  readonly signature: string;
}

/** A key pair as files hold it: PKCS#8 and SPKI PEM, and the id of the public key. */
export interface SigningKeyPair {
  readonly privateKeyPem: string;
  readonly publicKeyPem: string;
  readonly keyId: string;
}

function publicKeyOf(pem: string): KeyObject {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('not an ed25519 public key');
  return key;
}

/** `sha256:<hex>` of the public key's SPKI DER: how a signature names its key. */
export function keyIdOf(publicKeyPem: string): string {
  const der = publicKeyOf(publicKeyPem).export({ type: 'spki', format: 'der' });
  return `sha256:${createHash('sha256').update(der).digest('hex')}`;
}

/** A new ed25519 key pair. */
export function generateSigningKey(): SigningKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem,
    keyId: keyIdOf(publicKeyPem),
  };
}

/** Signs a manifest's bytes with a private key (PKCS#8 PEM). */
export function signManifest(manifest: Uint8Array, privateKeyPem: string): ArchiveSignature {
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('not an ed25519 private key');
  const publicKeyPem = createPublicKey(privateKey)
    .export({ type: 'spki', format: 'pem' })
    .toString();
  const signature = sign(null, Buffer.concat([SIGNATURE_CONTEXT, manifest]), privateKey);
  return {
    format: SIGNATURE_FORMAT,
    alg: 'ed25519',
    keyId: keyIdOf(publicKeyPem),
    signedFile: ARCHIVE_MANIFEST_FILE,
    signature: signature.toString('base64'),
  };
}

/** A signature file's JSON, read; `null` when it is not one. Pure. */
export function parseSignature(raw: unknown): ArchiveSignature | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    r['format'] !== SIGNATURE_FORMAT ||
    r['alg'] !== 'ed25519' ||
    r['signedFile'] !== ARCHIVE_MANIFEST_FILE ||
    typeof r['keyId'] !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(r['keyId']) ||
    typeof r['signature'] !== 'string'
  ) {
    return null;
  }
  return {
    format: SIGNATURE_FORMAT,
    alg: 'ed25519',
    keyId: r['keyId'],
    signedFile: ARCHIVE_MANIFEST_FILE,
    signature: r['signature'],
  };
}

/** A key an instance trusts: its name, as the interface shows it, and its public key. */
export interface TrustedKey {
  readonly name: string;
  readonly publicKeyPem: string;
}

/**
 * The trusted key that signed this manifest, or `null`: the key named by the signature's
 * id must be trusted and the signature must verify with it.
 */
export function verifyManifestSignature(
  manifest: Uint8Array,
  signature: ArchiveSignature,
  trusted: readonly TrustedKey[],
): TrustedKey | null {
  const key = trusted.find((candidate) => {
    try {
      return keyIdOf(candidate.publicKeyPem) === signature.keyId;
    } catch {
      return false;
    }
  });
  if (key === undefined) return null;
  const bytes = Buffer.from(signature.signature, 'base64');
  if (bytes.length !== 64) return null;
  const ok = verify(
    null,
    Buffer.concat([SIGNATURE_CONTEXT, manifest]),
    publicKeyOf(key.publicKeyPem),
    bytes,
  );
  return ok ? key : null;
}

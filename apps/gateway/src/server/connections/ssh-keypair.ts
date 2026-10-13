/**
 * Key pair of an `ssh-key` connection (ADR plugin-contract-and-credential-spec
 * D2): the instance generates an ed25519 pair, the private key is sealed with
 * the connection's credential and never leaves the instance, the public key
 * is shown to the owner to append to `authorized_keys` on the target.
 *
 * The private key is written in the OpenSSH `openssh-key-v1` container
 * (unencrypted: it is sealed at rest by the store). That is the only ed25519
 * private-key format SSH clients read — PKCS#8 PEM is refused — so the key is
 * encoded here from the raw seed rather than exported by `node:crypto`.
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';

const KEY_TYPE = 'ssh-ed25519';
const AUTH_MAGIC = 'openssh-key-v1\0';
const CIPHER_BLOCK_SIZE = 8;
const PEM_LINE_LENGTH = 70;
const ED25519_KEY_BYTES = 32;
/** PEM armor label of the container (a format marker, not key material). */
const PEM_LABEL = 'OPENSSH PRIVATE KEY';

export interface SshKeyPair {
  /** The OpenSSH private-key container, PEM-armored. */
  readonly privateKeyPem: string;
  /** One `authorized_keys` line: `ssh-ed25519 <base64> <comment>`. */
  readonly publicKey: string;
}

export function generateEd25519KeyPair(comment: string): SshKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwkPublic = publicKey.export({ format: 'jwk' });
  const jwkPrivate = privateKey.export({ format: 'jwk' });
  if (typeof jwkPublic.x !== 'string' || typeof jwkPrivate.d !== 'string') {
    throw new Error('ssh key pair: the runtime did not export the ed25519 key material');
  }
  const pub = Buffer.from(jwkPublic.x, 'base64url');
  const seed = Buffer.from(jwkPrivate.d, 'base64url');
  if (pub.length !== ED25519_KEY_BYTES || seed.length !== ED25519_KEY_BYTES) {
    throw new Error('ssh key pair: unexpected ed25519 key length');
  }
  const safeComment = comment.replace(/[^A-Za-z0-9@._-]/g, '-');
  return {
    privateKeyPem: encodeOpenSshPrivateKey(seed, pub, safeComment),
    publicKey: `${KEY_TYPE} ${publicKeyBlob(pub).toString('base64')} ${safeComment}`,
  };
}

function sshString(value: Buffer | string): Buffer {
  const data = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  return Buffer.concat([length, data]);
}

function publicKeyBlob(pub: Buffer): Buffer {
  return Buffer.concat([sshString(KEY_TYPE), sshString(pub)]);
}

function encodeOpenSshPrivateKey(seed: Buffer, pub: Buffer, comment: string): string {
  const check = randomBytes(4);
  const unpadded = Buffer.concat([
    check,
    check,
    sshString(KEY_TYPE),
    sshString(pub),
    sshString(Buffer.concat([seed, pub])),
    sshString(comment),
  ]);
  const padLength = (CIPHER_BLOCK_SIZE - (unpadded.length % CIPHER_BLOCK_SIZE)) % CIPHER_BLOCK_SIZE;
  const padding = Buffer.from(Array.from({ length: padLength }, (_, i) => i + 1));
  const keyCount = Buffer.alloc(4);
  keyCount.writeUInt32BE(1, 0);
  const container = Buffer.concat([
    Buffer.from(AUTH_MAGIC, 'binary'),
    sshString('none'), // cipher
    sshString('none'), // kdf
    sshString(''), // kdf options
    keyCount,
    sshString(publicKeyBlob(pub)),
    sshString(Buffer.concat([unpadded, padding])),
  ]);
  const body = container.toString('base64').match(new RegExp(`.{1,${PEM_LINE_LENGTH}}`, 'g')) ?? [];
  return [`-----BEGIN ${PEM_LABEL}-----`, ...body, `-----END ${PEM_LABEL}-----`, ''].join('\n');
}

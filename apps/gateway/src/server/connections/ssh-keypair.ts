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
import { createPrivateKey, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';

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
  const { privateKey } = generateKeyPairSync('ed25519');
  return pairOf(privateKey, comment);
}

/** Why an existing private key cannot become the key of an `ssh-key` connection. */
export class SshKeyImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SshKeyImportError';
  }
}

/**
 * The pair of an ed25519 private key that already exists (the importer from
 * v4, ADR import-from-v4-one-shot-importer D5): a PKCS#8 PEM (what v4
 * generated) or an unencrypted OpenSSH container. The private key is written
 * again in the OpenSSH container, the one format SSH clients read, with this
 * instance's comment. Any other key type, an encrypted key or a malformed one
 * is refused; the message never quotes the key.
 */
export function importEd25519PrivateKey(pem: string, comment: string): SshKeyPair {
  const text = pem.trim();
  if (text.startsWith(`-----BEGIN ${PEM_LABEL}-----`)) {
    const { seed } = decodeOpenSshPrivateKey(text);
    return pairOf(ed25519KeyFromSeed(seed), comment);
  }
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: text, format: 'pem' });
  } catch {
    throw new SshKeyImportError('the private key is neither a PEM key nor an OpenSSH key');
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new SshKeyImportError(
      `the private key is ${key.asymmetricKeyType ?? 'of an unknown type'}, not ed25519`,
    );
  }
  return pairOf(key, comment);
}

function pairOf(privateKey: KeyObject, comment: string): SshKeyPair {
  const jwkPrivate = privateKey.export({ format: 'jwk' });
  if (typeof jwkPrivate.x !== 'string' || typeof jwkPrivate.d !== 'string') {
    throw new Error('ssh key pair: the runtime did not export the ed25519 key material');
  }
  const pub = Buffer.from(jwkPrivate.x, 'base64url');
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

/** DER prefix of a PKCS#8 ed25519 private key (RFC 8410): the 32-byte seed follows. */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function ed25519KeyFromSeed(seed: Buffer): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
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

/** Reads the length-prefixed strings of the OpenSSH container, refusing any overrun. */
class SshReader {
  private offset = 0;
  constructor(private readonly data: Buffer) {}

  string(): Buffer {
    if (this.offset + 4 > this.data.length) throw truncated();
    const length = this.data.readUInt32BE(this.offset);
    const start = this.offset + 4;
    if (start + length > this.data.length) throw truncated();
    this.offset = start + length;
    return this.data.subarray(start, start + length);
  }

  uint32(): number {
    if (this.offset + 4 > this.data.length) throw truncated();
    const value = this.data.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }
}

function truncated(): SshKeyImportError {
  return new SshKeyImportError('the OpenSSH private key is truncated');
}

/** The ed25519 seed of an unencrypted `openssh-key-v1` container holding one key. */
function decodeOpenSshPrivateKey(text: string): { seed: Buffer } {
  const body = text
    .replace(`-----BEGIN ${PEM_LABEL}-----`, '')
    .replace(`-----END ${PEM_LABEL}-----`, '')
    .replace(/\s+/g, '');
  const data = Buffer.from(body, 'base64');
  const magic = Buffer.from(AUTH_MAGIC, 'binary');
  if (data.length < magic.length || !data.subarray(0, magic.length).equals(magic)) {
    throw new SshKeyImportError('the OpenSSH private key does not start with its magic');
  }
  const reader = new SshReader(data.subarray(magic.length));
  const cipher = reader.string().toString('utf8');
  const kdf = reader.string().toString('utf8');
  reader.string(); // kdf options
  if (cipher !== 'none' || kdf !== 'none') {
    throw new SshKeyImportError('the OpenSSH private key is encrypted with a passphrase');
  }
  if (reader.uint32() !== 1) {
    throw new SshKeyImportError('the OpenSSH container holds more than one key');
  }
  reader.string(); // public key blob
  const section = new SshReader(reader.string());
  if (section.uint32() !== section.uint32()) {
    throw new SshKeyImportError('the OpenSSH private key fails its check bytes');
  }
  const type = section.string().toString('utf8');
  if (type !== KEY_TYPE) {
    throw new SshKeyImportError(`the private key is ${type.slice(0, 40)}, not ed25519`);
  }
  const pub = section.string();
  const secret = section.string();
  if (pub.length !== ED25519_KEY_BYTES || secret.length !== 2 * ED25519_KEY_BYTES) {
    throw new SshKeyImportError('the OpenSSH ed25519 key has an unexpected length');
  }
  if (!secret.subarray(ED25519_KEY_BYTES).equals(pub)) {
    throw new SshKeyImportError('the OpenSSH ed25519 key does not match its public half');
  }
  return { seed: Buffer.from(secret.subarray(0, ED25519_KEY_BYTES)) };
}

/**
 * `encryption.*` and where the master key comes from: the winning source's file, and
 * the absent key file the boot may tolerate (ADR
 * master-key-generated-and-handed-over-by-the-instance).
 */
import { KEY_BYTES } from '../crypto/aead';
import type { IssueList } from './errors';
import { type Reader, typeName } from './reader';
import type { AbsentSecretFile, SourceTrace } from './secret-refs';
import { envNamesFor, isKeyRequired, keySpec } from './sources';
import { getPath, type RawTree } from './tree';
import type { AbsentMasterKeyReason, EncryptionConfig } from './types';

/** The master key is the AEAD key: one size, defined by the crypto module. */
export const MASTER_KEY_BYTES = KEY_BYTES;

export const MASTER_KEY_PATH = 'encryption.master_key';
const GENERATE_PATH = 'encryption.generate_master_key';

/** What the two sources said about the master key, beside its value. */
export interface MasterKeySource {
  /** The file the key is read from, when it is read from one: the winning source's. */
  readonly file: string | null;
  /** The absent key file the boot may tolerate, with the reason the configuration gives. */
  readonly absent: {
    readonly file: AbsentSecretFile;
    readonly reason: AbsentMasterKeyReason;
  } | null;
}

/**
 * Where the master key comes from, by the precedence of the sources: the YAML file
 * when it sets the key, else the environment. An absent key file of the winning
 * source is tolerated when the raw configuration enables generation or names a
 * restore source; every other absent secret file is reported as the problem it is.
 */
export function masterKeySource(
  raw: RawTree,
  fileTree: RawTree | null,
  envTrace: SourceTrace,
  fileTrace: SourceTrace,
  issues: IssueList,
): MasterKeySource {
  const fileWins = fileTree !== null && getPath(fileTree, MASTER_KEY_PATH) !== undefined;
  const winner = fileWins ? fileTrace : envTrace;
  const reason = absenceReason(raw);
  let absent: MasterKeySource['absent'] = null;
  for (const trace of [envTrace, fileTrace]) {
    for (const file of trace.absentFiles) {
      if (
        file.keyPath === MASTER_KEY_PATH &&
        trace === winner &&
        reason !== null &&
        absent === null
      ) {
        absent = { file, reason };
        continue;
      }
      issues.add(file.keyPath, file.message, file.env);
    }
  }
  return { file: winner.secretFiles.get(MASTER_KEY_PATH) ?? absent?.file.filePath ?? null, absent };
}

function absenceReason(raw: RawTree): AbsentMasterKeyReason | null {
  if (getPath(raw, GENERATE_PATH) === true) return 'generate';
  const from = getPath(raw, 'restore.from');
  if (typeof from === 'string' && from.trim() !== '') return 'restore';
  return null;
}

/**
 * `encryption.*`. With `generate_master_key` the key must be a file (there is nothing
 * to write otherwise) and no restore may be configured (the copy needs *its* key, not
 * a new one). An absent key file the loader tolerates leaves `masterKey` empty: the
 * caller never hands that block to an encryptor (`loadInstanceConfigOrSetup`).
 */
export function readEncryption(
  r: Reader,
  source: MasterKeySource,
  restoreConfigured: boolean,
): EncryptionConfig | null {
  const path = MASTER_KEY_PATH;
  const generateMasterKey = r.bool(keySpec(GENERATE_PATH));
  const acceptKeyBesideStore = r.bool(keySpec('encryption.accept_key_beside_store'));
  const absent = source.absent !== null;
  const encoded = absent ? undefined : r.string(path, { required: isKeyRequired(keySpec(path)) });
  const masterKey = encoded === undefined ? undefined : decodeKey(encoded, path, r.issues);
  const keyVersion = r.int(keySpec('encryption.key_version'));
  if (generateMasterKey && restoreConfigured) {
    r.issues.add(
      GENERATE_PATH,
      'cannot be set with restore.from: a restored copy opens with the key it was sealed with, not a new one',
      envNamesFor(GENERATE_PATH),
    );
  }
  if (generateMasterKey && source.file === null && encoded !== undefined) {
    r.issues.add(
      GENERATE_PATH,
      `applies to a key read from a file: name the file (${envNamesFor(path)[1] ?? ''} or \${file:…}) or unset this key`,
      envNamesFor(GENERATE_PATH),
    );
  }

  const previousKeys = new Map<number, Uint8Array>();
  const previous = r.tree('encryption.previous_keys');
  if (previous) {
    for (const [versionText, value] of Object.entries(previous)) {
      const subPath = `encryption.previous_keys.${versionText}`;
      const version = Number(versionText);
      if (!Number.isInteger(version) || version < 1) {
        r.issues.add(
          subPath,
          'version must be an integer >= 1',
          envNamesFor('encryption.previous_keys'),
        );
        continue;
      }
      if (version === keyVersion) {
        r.issues.add(subPath, `duplicates the current key_version ${keyVersion}`, [
          ...envNamesFor('encryption.previous_keys'),
        ]);
        continue;
      }
      if (typeof value !== 'string') {
        r.issues.add(subPath, `expected a base64 string, got ${typeName(value)}`, [
          ...envNamesFor('encryption.previous_keys'),
        ]);
        continue;
      }
      const key = decodeKey(value, subPath, r.issues);
      if (key) previousKeys.set(version, key);
    }
  }
  if (absent) {
    // Taken out again by the caller: a placeholder so the rest of the block is checked.
    return {
      masterKey: new Uint8Array(0),
      keyVersion,
      previousKeys,
      masterKeyFile: source.file,
      generateMasterKey,
      acceptKeyBesideStore,
    };
  }
  if (!masterKey) return null;
  return {
    masterKey,
    keyVersion,
    previousKeys,
    masterKeyFile: source.file,
    generateMasterKey,
    acceptKeyBesideStore,
  };
}

function decodeKey(encoded: string, path: string, issues: IssueList): Uint8Array | undefined {
  const trimmed = encoded.trim();
  const bytes = Buffer.from(trimmed, 'base64');
  if (bytes.length !== MASTER_KEY_BYTES || bytes.toString('base64') !== normalizeBase64(trimmed)) {
    issues.add(
      path,
      `must be ${MASTER_KEY_BYTES} random bytes encoded in base64 (generate one with \`npm run gen-master-key\`)`,
      envNamesFor(path),
    );
    return undefined;
  }
  return new Uint8Array(bytes);
}

function normalizeBase64(text: string): string {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  return padded + '='.repeat((4 - (padded.length % 4)) % 4);
}

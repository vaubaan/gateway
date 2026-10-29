/**
 * Where a restore reads a store copy from (see
 * docs/handbook/store.md): an absolute file
 * path, or an https URL — typically a presigned object-storage URL, which is a
 * secret. Shared by the configuration loader (`restore.from`) and the `restore`
 * command, so both accept and refuse the same values.
 *
 * Problems are fixed sentences: the value is never quoted back.
 */
import { isAbsolute } from 'node:path';

export type RestoreSource =
  { readonly kind: 'file'; readonly path: string } | { readonly kind: 'url'; readonly url: URL };

export type ParsedRestoreSource =
  | { readonly ok: true; readonly source: RestoreSource }
  | { readonly ok: false; readonly problem: string };

export const RESTORE_SOURCE_PROBLEMS = {
  http: 'must use https (an http URL is refused)',
  url: 'is not a valid https URL',
  credentials: 'must not carry a user name or password in the URL',
  shape: 'must be an https URL or an absolute file path',
} as const;

export function parseRestoreSource(raw: string): ParsedRestoreSource {
  const text = raw.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text)?.[1]?.toLowerCase();
  if (scheme === 'http') return { ok: false, problem: RESTORE_SOURCE_PROBLEMS.http };
  if (scheme === 'https') {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return { ok: false, problem: RESTORE_SOURCE_PROBLEMS.url };
    }
    if (url.username !== '' || url.password !== '') {
      return { ok: false, problem: RESTORE_SOURCE_PROBLEMS.credentials };
    }
    return { ok: true, source: { kind: 'url', url } };
  }
  if (scheme === undefined && isAbsolute(text)) {
    return { ok: true, source: { kind: 'file', path: text } };
  }
  return { ok: false, problem: RESTORE_SOURCE_PROBLEMS.shape };
}

/** A SHA-256 written as 64 hexadecimal characters; lower-cased, or `null`. */
export function parseSha256(raw: string): string | null {
  const text = raw.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(text) ? text : null;
}

/** How the source is named in a report or a log line: never the URL. */
export function describeRestoreSource(source: RestoreSource): string {
  return source.kind === 'file' ? `the file ${source.path}` : 'an https URL (not shown)';
}

/**
 * `Reader` — reads one typed value at a time from the merged raw tree, and reports
 * each problem by its key and variable(s) on the shared issue list.
 */
import { parseDuration } from './duration';
import type { IssueList } from './errors';
import { envNamesFor } from './sources';
import { getPath, isPlainObject, type RawTree } from './tree';

/** `git.max_pack_mb` is in mebibytes. */
export const BYTES_PER_MEGABYTE = 1024 * 1024;

export interface IntKey {
  readonly path: string;
  readonly default: number;
  readonly min: number;
}
export interface OptionalIntKey {
  readonly path: string;
  readonly min: number;
}
export interface BoolKey {
  readonly path: string;
  readonly default: boolean;
}
export interface TextKey {
  readonly path: string;
  readonly default: string;
}

export class Reader {
  constructor(
    private readonly raw: RawTree,
    readonly issues: IssueList,
  ) {}

  has(path: string): boolean {
    return getPath(this.raw, path) !== undefined;
  }

  string(path: string, opts: { required?: boolean; fallback?: string } = {}): string | undefined {
    const value = getPath(this.raw, path);
    if (value === undefined || value === null) {
      if (opts.fallback !== undefined) return opts.fallback;
      if (opts.required) this.issues.missing(path, envNamesFor(path));
      return undefined;
    }
    if (typeof value !== 'string') {
      this.issues.add(path, `expected a string, got ${typeName(value)}`, envNamesFor(path));
      return undefined;
    }
    if (value.trim() === '') {
      if (opts.required) this.issues.add(path, 'must not be empty', envNamesFor(path));
      return opts.fallback;
    }
    return value;
  }

  /** A string key with a default: the default stands in for an absent or empty value. */
  text(key: TextKey): string {
    return this.string(key.path, { fallback: key.default }) ?? key.default;
  }

  int(key: IntKey): number {
    const { path, default: fallback, min } = key;
    const value = getPath(this.raw, path);
    if (value === undefined || value === null) return fallback;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
      this.issues.add(path, `expected an integer >= ${min}, got ${show(value)}`, envNamesFor(path));
      return fallback;
    }
    return value;
  }

  /** An integer key without a default: `null` when absent (a ceiling: unlimited). */
  optionalInt(key: OptionalIntKey): number | null {
    const { path, min } = key;
    const value = getPath(this.raw, path);
    if (value === undefined || value === null) return null;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
      this.issues.add(path, `expected an integer >= ${min}, got ${show(value)}`, envNamesFor(path));
      return null;
    }
    return value;
  }

  bool(key: BoolKey): boolean {
    const { path, default: fallback } = key;
    const value = getPath(this.raw, path);
    if (value === undefined || value === null) return fallback;
    if (typeof value !== 'boolean') {
      this.issues.add(path, `expected true or false, got ${show(value)}`, envNamesFor(path));
      return fallback;
    }
    return value;
  }

  stringList(path: string): string[] {
    const value = getPath(this.raw, path);
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
      this.issues.add(
        path,
        `expected a list of strings, got ${typeName(value)}`,
        envNamesFor(path),
      );
      return [];
    }
    return value.map((v) => v.trim()).filter((v) => v.length > 0);
  }

  duration(key: TextKey): number {
    const { path, default: fallback } = key;
    const text = this.string(path, { fallback }) ?? fallback;
    const seconds = parseDuration(text);
    if (seconds === null) {
      this.issues.add(path, `expected a duration like 30s, 10m, 24h or 7d, got "${text}"`, [
        ...envNamesFor(path),
      ]);
      return parseDuration(fallback) ?? 0;
    }
    return seconds;
  }

  url(
    path: string,
    opts: { required?: boolean; fallback?: string; https: boolean },
  ): URL | undefined {
    const text = this.string(path, { required: opts.required, fallback: opts.fallback });
    if (text === undefined) return undefined;
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      // expected: the configured value is not a URL: recorded as a config issue
      this.issues.add(path, `is not a valid URL: "${text}"`, envNamesFor(path));
      return undefined;
    }
    if (opts.https && url.protocol !== 'https:') {
      this.issues.add(path, `must use https (got ${url.protocol.slice(0, -1)})`, envNamesFor(path));
      return undefined;
    }
    return url;
  }

  tree(path: string): RawTree | undefined {
    const value = getPath(this.raw, path);
    if (value === undefined || value === null) return undefined;
    if (!isPlainObject(value)) {
      this.issues.add(path, `expected a mapping, got ${typeName(value)}`, envNamesFor(path));
      return undefined;
    }
    return value;
  }
}

export function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  return typeof value === 'object' ? 'a mapping' : `a ${typeof value}`;
}

export function show(value: unknown): string {
  return typeof value === 'string' ? `"${value}"` : String(value);
}

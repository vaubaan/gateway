/**
 * Naming helpers for E2E resources. Spec §12.3.
 *
 *   vauban-e2e-<testfile-hash6>-<run-uuid8>
 *
 * Goals:
 *  - Every transient resource (GitHub repo, Vercel project,
 *    Supabase project, Infisical secret, etc.) gets a unique name.
 *  - The prefix lets the sweeper (scripts/e2e-sweeper.ts) match
 *    orphans, regardless of which test created them.
 *  - The testfile-hash narrows the blast radius: a sweeper can choose
 *    to delete only resources from one test file when debugging.
 *
 * Constraint: provider name policies are strict (kebab-case, length
 * limits). The naming scheme above gives us 11 + 6 + 1 + 8 = 26 chars
 * which fits all current providers (GitHub repo: 100, Vercel project:
 * 100, Supabase project: 100, Infisical secret name: 64).
 */

import { createHash } from 'node:crypto';

const PREFIX = 'vauban-e2e';

export function fileHash(testFilePath: string): string {
  return createHash('sha256').update(testFilePath).digest('hex').slice(0, 6);
}

export function makeRunUuid(): string {
  // 8 hex chars : 4.3B combinations is plenty for a nightly window.
  return createHash('sha256').update(`${Date.now()}-${Math.random()}`).digest('hex').slice(0, 8);
}

export interface NameContext {
  readonly fileHash: string;
  readonly runUuid: string;
}

export function makeNameContext(testFilePath: string): NameContext {
  return { fileHash: fileHash(testFilePath), runUuid: makeRunUuid() };
}

export function makeResourceName(ctx: NameContext, suffix?: string): string {
  const base = `${PREFIX}-${ctx.fileHash}-${ctx.runUuid}`;
  if (suffix !== undefined && suffix !== '') return `${base}-${suffix}`;
  return base;
}

export function isE2EResourceName(name: string): boolean {
  return name.startsWith(`${PREFIX}-`);
}

export const E2E_RESOURCE_PREFIX = PREFIX;

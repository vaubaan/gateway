/**
 * Shape check of a mission draft arriving as JSON (the creation form, a
 * pasted agent proposal, later the management door). It only answers "is this
 * a draft?"; whether the draft may be issued is `previewDraft`'s question.
 * Unknown keys are refused so a typo never silently drops a restriction.
 */
import { GATES } from '@vaubaan/shared';
import { z } from 'zod';

import type { MissionDraft } from './model';

const MAX_CONNECTIONS = 32;
const MAX_ENTRIES = 2000;
const MAX_RESOURCES = 5000;

const text = z.string().min(1).max(300);

const rateLimitSchema = z.object({ max: z.number(), window_seconds: z.number() }).strict();

const entrySchema = z
  .object({
    risk_id: text,
    quota: z.number().optional(),
    rate_limit: rateLimitSchema.optional(),
    gate: z.enum(GATES).optional(),
  })
  .strict();

const resourcesSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('all') }).strict(),
  z
    .object({
      scope: z.literal('selected'),
      resource_ids: z.array(text).max(MAX_RESOURCES).optional(),
      resource_refs: z.array(text).max(MAX_RESOURCES).optional(),
    })
    .strict(),
]);

const connectionSchema = z
  .object({
    connection_id: text.optional(),
    provider: text.optional(),
    resources: resourcesSchema.optional(),
    preset: text.nullable().optional(),
    policy: z.array(entrySchema).max(MAX_ENTRIES).optional(),
  })
  .strict();

const periodSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('one-off') }).strict(),
  z.object({ kind: z.literal('recurring'), length_seconds: z.number() }).strict(),
]);

const draftSchema = z
  .object({
    name: z.string().max(1000),
    connections: z.array(connectionSchema).max(MAX_CONNECTIONS),
    period: periodSchema,
    expires_at: z.string().max(64).nullable(),
  })
  .strict();

export type ParsedDraft =
  | { readonly ok: true; readonly draft: MissionDraft }
  | { readonly ok: false; readonly problems: readonly string[] };

export function parseMissionDraft(raw: unknown): ParsedDraft {
  const result = draftSchema.safeParse(raw);
  if (result.success) return { ok: true, draft: result.data };
  return {
    ok: false,
    problems: result.error.issues.map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    }),
  };
}

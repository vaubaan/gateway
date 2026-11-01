/**
 * Shape check of a mission draft arriving as JSON (the creation form, a
 * pasted agent proposal, the management door). It only answers "is this a
 * draft?"; whether the draft may be issued is `previewDraft`'s question.
 * Unknown keys are refused so a typo never silently drops a restriction.
 *
 * `missionDraftSchema` is also the input schema of the management door's
 * `preview_policy` and `issue_mission` tools: the descriptions below are what
 * an agent reads when it composes a draft, so they state the rules of
 * issuance, not only the types.
 */
import { TRUST_LEVELS } from '@vaubaan/policy-engine';
import { GATES } from '@vaubaan/shared';
import { z } from 'zod';

import type { MissionDraft } from '../../lib/missions/model';

const MAX_CONNECTIONS = 32;
const MAX_ENTRIES = 2000;
const MAX_RESOURCES = 5000;
const MAX_RESOURCE_SETS = 32;

const text = z.string().min(1).max(300);

const rateLimitSchema = z
  .object({
    max: z.number().describe('Actions allowed per window.'),
    window_seconds: z.number().describe('Length of the window, in seconds.'),
  })
  .strict()
  .describe('Short-window cap on one risk, inside its quota.');

const entrySchema = z
  .object({
    risk_id: text.describe(
      'One explicit RiskId of the connection’s catalog, exactly as `get_catalog` lists it, e.g. `github.pr-write` or `supabase[staging].bulk-row-write`. Never a wildcard, never a pattern.',
    ),
    quota: z
      .number()
      .optional()
      .describe(
        'Actions allowed per period on this risk. Mandatory unless the connection gives `everything_i_hold: true`, which then supplies it.',
      ),
    rate_limit: rateLimitSchema.optional(),
    gate: z
      .enum(GATES)
      .optional()
      .describe(
        '`auto` (default): calls pass within the budget. `approval`: every call waits for the mission creator to approve it in the interface.',
      ),
  })
  .strict();

const resourcesSchema = z.discriminatedUnion('scope', [
  z
    .object({ scope: z.literal('all') })
    .strict()
    .describe(
      'Every resource of the connection known now, stored as that list: a resource discovered later is NOT reached. The usual choice.',
    ),
  z
    .object({ scope: z.literal('connection') })
    .strict()
    .describe(
      'The whole connection: every resource known now AND every resource discovered later (except the ones the owner hid). Only when the task creates resources or operates the whole account; the user sees the mission marked so.',
    ),
  z
    .object({
      scope: z.literal('selected'),
      resource_ids: z.array(text).max(MAX_RESOURCES).optional(),
      resource_refs: z
        .array(text)
        .max(MAX_RESOURCES)
        .optional()
        .describe('Resource refs as `list_my_connections` shows them, e.g. `acme/app`.'),
    })
    .strict(),
]);

const resourcesField = () =>
  resourcesSchema
    .optional()
    .describe(
      'The resources the mission may touch on this connection. Default: `all` (every resource known now). `connection` also reaches resources discovered later.',
    );

const everythingField = () =>
  z
    .boolean()
    .optional()
    .describe(
      '`true` for the built-in everything-i-hold: every non-deprecated risk the user holds on the connection that the selected resources can reach, the fallback included, written out as explicit lines (catalog rate ceiling, generous quota for a daily period, gate `auto`). Alone, it is the whole policy of the connection (bounded by the user’s authority). With `policy`, it only supplies the budget of the risks that give none. Only when the user asks for everything they hold.',
    );

const policyField = () =>
  z
    .array(entrySchema)
    .max(MAX_ENTRIES)
    .optional()
    .describe('Exactly the risks the mission accepts on this connection, each with its budget.');

const trustLevelsField = () =>
  z
    .record(z.string().max(64), z.enum(TRUST_LEVELS))
    .optional()
    .describe(
      'The trust level (`careful`, `trusting`, `autonomous`) of each macro-action of `get_catalog` to tick, by macro-action id. Without `policy`, the macro-actions at their trust levels write the policy (gate from each risk’s tier, budget from its base budget ×1, ×3 or ×10), bounded by the user’s authority and the selected resources; with `policy`, `policy` is the whole list and the trust levels are only kept to redraw the form. The usual way to compose a mission: tick the macro-actions the task needs at the lowest trust level that does it.',
    );

const resourceSetSchema = z
  .object({
    id: text
      .optional()
      .describe('The stored set an edit of the mission keeps; ignored when a mission is issued.'),
    resources: resourcesField(),
    everything_i_hold: everythingField(),
    policy: policyField(),
    trust_levels: trustLevelsField(),
  })
  .strict()
  .describe('One resource set: some resources of the connection with their own policy and budget.');

const connectionSchema = z
  .object({
    connection_id: text
      .optional()
      .describe('Id of one of the user’s connections (`list_my_connections`).'),
    provider: text
      .optional()
      .describe(
        'Instead of `connection_id`, when the user holds exactly one usable connection of that provider.',
      ),
    resources: resourcesField(),
    everything_i_hold: everythingField(),
    policy: policyField(),
    trust_levels: trustLevelsField(),
    resource_sets: z
      .array(resourceSetSchema)
      .min(1)
      .max(MAX_RESOURCE_SETS)
      .optional()
      .describe(
        'Instead of `resources`, `everything_i_hold`, `policy` and `trust_levels` (which must then be absent): several resource sets on this connection, each with its own resources, trust levels and policy, judged and budgeted apart. A resource belongs to one set only; at most one set takes `all` or `connection` (every resource no other set selects). A call naming no resource, or resources of several sets, must be accepted in every set it may touch. Only when the task needs different trust on different resources of one account (staging free, production careful).',
      ),
  })
  .strict();

const periodSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('one-off') })
    .strict()
    .describe('One budget for the life of the mission.'),
  z
    .object({
      kind: z.literal('recurring'),
      length_seconds: z.number().describe('Period length in seconds, e.g. 86400 for a day.'),
    })
    .strict()
    .describe('Quotas reload at every period.'),
]);

/** A mission draft: name, connections with their policy, period, expiry. */
export const missionDraftSchema = z
  .object({
    name: z.string().max(1000).describe('What the mission is for, as the user will read it.'),
    connections: z
      .array(connectionSchema)
      .max(MAX_CONNECTIONS)
      .describe('At least one connection; at most one connection per provider.'),
    period: periodSchema,
    expires_at: z
      .string()
      .max(64)
      .nullable()
      .describe('ISO-8601 instant in the future, or null for a mission that does not expire.'),
  })
  .strict();

export type ParsedDraft =
  | { readonly ok: true; readonly draft: MissionDraft }
  | { readonly ok: false; readonly problems: readonly string[] };

export function parseMissionDraft(raw: unknown): ParsedDraft {
  const result = missionDraftSchema.safeParse(raw);
  if (result.success) return { ok: true, draft: result.data };
  return {
    ok: false,
    problems: result.error.issues.map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    }),
  };
}

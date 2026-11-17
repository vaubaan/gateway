/**
 * The arguments of the `vaubaan` plugin's tools, as the host reads them: one
 * zod schema per act, strict (a typo never silently drops a restriction).
 *
 * The plugin declares the same schemas as JSON Schema in its tool
 * declarations (`plugins/vaubaan/src/tool-schemas.json`), which is what an
 * agent reads in `tools/list`; `inputs.test.ts` holds the file to these
 * schemas, so the two cannot drift (`npm run vaubaan:schemas` writes the file
 * again). A draft's schema is the mission module's (`missionDraftSchema`), the
 * one the creation form reads.
 */
// The identity alone: the plugin's index reads `tool-schemas.json`, which this module writes.
import { ACT, type VaubaanActName } from '@vaubaan/plugin-vaubaan/identity';
import { z } from 'zod';

import { MISSION_NAME_MAX_LENGTH, missionDraftSchema } from '../missions';
import { MAX_ARCHIVE_BASE64 } from './plugin-acts';

const missionId = z
  .string()
  .min(1)
  .max(300)
  .describe('Id of one of the user’s missions, as `list_my_missions` returns it.');

/** A draft naming the mission it edits: the whole mission after the edit. */
const editDraft = missionDraftSchema.extend({
  mission_id: missionId.describe(
    'Id of one of the user’s missions, as `list_my_missions` returns it: the mission the draft edits.',
  ),
});

export const VAUBAAN_INPUTS = {
  listMyAccounts: z
    .object({
      // Retired with the experimental state (docs/handbook/plugin-sdk.md): every
      // account is listed. Still accepted, and ignored, so that a client written
      // against an earlier build is not refused by the strict input.
      include_experimental: z
        .boolean()
        .optional()
        .describe('Deprecated and ignored: every account is listed.'),
    })
    .strict(),
  getCatalog: z
    .object({
      service: z
        .string()
        .min(1)
        .max(100)
        .describe('Service id, as `list_my_accounts` shows it, e.g. `github`.'),
      account_id: z
        .string()
        .min(1)
        .max(300)
        .optional()
        .describe('One of the user’s accounts of that service.'),
    })
    .strict(),
  listMyMissions: z
    .object({
      mission_id: missionId.optional(),
      include_closed: z
        .boolean()
        .optional()
        .describe('Also list revoked and expired missions (left out by default).'),
    })
    .strict(),
  previewPolicy: missionDraftSchema.extend({
    mission_id: missionId
      .optional()
      .describe(
        'Preview an edit of this mission instead of an issuance: the draft is the whole mission after the edit.',
      ),
  }),
  issueMission: missionDraftSchema,
  renameMission: z
    .object({
      mission_id: missionId,
      name: z
        .string()
        .min(1)
        .max(MISSION_NAME_MAX_LENGTH)
        .regex(/\S/, 'The name is blank.')
        .describe('The new name, as the user will read it: not empty, at most 120 characters.'),
    })
    .strict(),
  editMission: editDraft,
  rotateMissionToken: z.object({ mission_id: missionId }).strict(),
  revokeMission: z.object({ mission_id: missionId }).strict(),
  uploadPlugin: z
    .object({
      archive_base64: z
        .string()
        .min(1)
        .max(MAX_ARCHIVE_BASE64)
        .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'Not base64.')
        .describe(
          'The bytes of the plugin archive (the .tgz `vaubaan-plugin build` writes), in base64: at most 16 MB once decoded.',
        ),
    })
    .strict(),
  pluginStatus: z.object({}).strict(),
} as const satisfies Record<VaubaanActName, z.ZodType>;

export type VaubaanInput<A extends VaubaanActName> = z.infer<(typeof VAUBAAN_INPUTS)[A]>;

/**
 * The JSON Schema of an act's arguments, as MCP clients read it: the conversion
 * the MCP SDK applied when the management door registered these schemas
 * (draft 2020-12, the input side), without the `$schema` line.
 */
export function inputJsonSchemaOf(act: VaubaanActName): Record<string, unknown> {
  const { $schema: _dialect, ...schema } = z.toJSONSchema(VAUBAAN_INPUTS[act], {
    target: 'draft-2020-12',
    io: 'input',
  });
  return schema;
}

/** Every act's schema, keyed by the act's tool name: the content of `tool-schemas.json`. */
export function toolSchemasDocument(): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    (Object.keys(ACT) as VaubaanActName[]).map((act) => [ACT[act], inputJsonSchemaOf(act)]),
  );
}

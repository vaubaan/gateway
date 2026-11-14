/**
 * The host side of the `vaubaan` plugin (spec §4.1 bis; ADR
 * platform-management-is-a-plugin-on-the-execution-door): the ports the plugin's
 * `execute` is bound to. Built once by the composition root
 * (`compose/vaubaan.ts`) from the mission service, the registry's catalogs and
 * a logger — and nothing else (`ports.ts`).
 *
 * A call reaches a port only after the execution door admitted the mission key
 * and the pipeline decided it like any other call: the mission's resources, its
 * accepted risks, its budget and gates. A port then reads the arguments with its
 * own schema (`inputs.ts`; a mismatch is the `invalid-arguments` refusal), checks
 * the self rule and acts (`acts.ts`).
 *
 * Handbook: docs/handbook/providers/vaubaan.md.
 */
import {
  VAUBAAN_PORT_NAMES,
  type VaubaanAnswer,
  type VaubaanCaller,
  type VaubaanPorts,
} from '@vaubaan/plugin-vaubaan';
import type { z } from 'zod';

import { VaubaanActs, type ActOutcome } from './acts';
import { VAUBAAN_INPUTS } from './inputs';
import type { VaubaanModuleDeps } from './ports';

/** The answer of an argument its schema refuses: where and why, never the value. */
function invalidArguments(error: z.ZodError): VaubaanAnswer {
  return {
    ok: false,
    refusal: {
      code: 'invalid-arguments',
      message: 'The arguments do not match the tool’s input schema. Nothing was done.',
      hint: 'Fix every entry of `issues` (the path of the argument and what is expected there), as the tool’s input schema in `tools/list` describes it.',
      issues: error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    },
  };
}

/**
 * A teammate's key never acts in the creator's name: the acts reach the
 * creator's whole authority, wider than the mission a teammate was added to.
 */
function teammateKeyRefusal(): VaubaanAnswer {
  return {
    ok: false,
    refusal: {
      code: 'teammate-key-not-allowed',
      message:
        'This key belongs to a teammate of the mission, not to its creator. Nothing was done.',
      hint: 'The Vaubaan tools act in the name of the mission’s creator: only the creator’s own key or a machine key the creator made may call them. Ask the creator to do it.',
    },
  };
}

/** One port: check the key's holder, read the arguments, then act. */
function portOf<S extends z.ZodType>(
  schema: S,
  act: (caller: VaubaanCaller, input: z.infer<S>) => Promise<ActOutcome<unknown>>,
) {
  return async (
    caller: VaubaanCaller,
    args: Readonly<Record<string, unknown>>,
  ): Promise<VaubaanAnswer> => {
    if (caller.holderUserId !== null && caller.holderUserId !== caller.userId) {
      return teammateKeyRefusal();
    }
    const parsed = schema.safeParse(args);
    if (!parsed.success) return invalidArguments(parsed.error);
    const outcome = await act(caller, parsed.data);
    return outcome.ok
      ? { ok: true, data: outcome.data as object }
      : { ok: false, refusal: outcome.refusal };
  };
}

/** The seven ports, as a frozen object of closures over the acts: nothing else is reachable. */
export function createVaubaanPorts(deps: VaubaanModuleDeps): VaubaanPorts {
  const acts = new VaubaanActs({
    missions: deps.missions,
    catalog: deps.catalog,
    logger: deps.logger.child({ component: 'vaubaan-plugin' }),
  });
  const ports: VaubaanPorts = {
    listMyAccounts: portOf(VAUBAAN_INPUTS.listMyAccounts, (caller) => acts.listMyAccounts(caller)),
    getCatalog: portOf(VAUBAAN_INPUTS.getCatalog, (caller, input) =>
      acts.getCatalog(caller, input),
    ),
    listMyMissions: portOf(VAUBAAN_INPUTS.listMyMissions, (caller, input) =>
      acts.listMyMissions(caller, input),
    ),
    previewPolicy: portOf(VAUBAAN_INPUTS.previewPolicy, (caller, draft) =>
      acts.previewPolicy(caller, draft),
    ),
    issueMission: portOf(VAUBAAN_INPUTS.issueMission, (caller, draft) =>
      acts.issueMission(caller, draft),
    ),
    rotateMissionToken: portOf(VAUBAAN_INPUTS.rotateMissionToken, (caller, input) =>
      acts.rotateMissionToken(caller, input),
    ),
    revokeMission: portOf(VAUBAAN_INPUTS.revokeMission, (caller, input) =>
      acts.revokeMission(caller, input),
    ),
  };
  const extra = Object.keys(ports).filter(
    (key) => !(VAUBAAN_PORT_NAMES as readonly string[]).includes(key),
  );
  if (extra.length > 0) throw new Error(`vaubaan plugin: unexpected ports ${extra.join(', ')}`);
  return Object.freeze(ports);
}

export {
  VAUBAAN_PROVIDER,
  VAUBAAN_REFUSAL_CODES,
  VaubaanActs,
  type ActOutcome,
  type ActRefusal,
  type BootstrapKitView,
  type AccountsAnswer,
  type IssuedMissionAnswer,
  type MissionsAnswer,
  type RevealedTokenView,
  type RevokedMissionAnswer,
  type RotatedTokenAnswer,
  type VaubaanActsDeps,
  type VaubaanRefusalCode,
} from './acts';
export { inputJsonSchemaOf, toolSchemasDocument, VAUBAAN_INPUTS } from './inputs';
export {
  VAUBAAN_DEPENDENCIES,
  VAUBAAN_MISSION_METHODS,
  type ProviderCatalog,
  type VaubaanCatalog,
  type VaubaanMissions,
  type VaubaanModuleDeps,
} from './ports';
export {
  catalogView,
  accountView,
  missionDetailView,
  missionView,
  previewView,
  uncoveredOfPreview,
  type CatalogView,
  type AccountView,
  type MissionDetailView,
  type MissionView,
  type OrphanView,
  type PreviewView,
  type UncoveredView,
} from './views';

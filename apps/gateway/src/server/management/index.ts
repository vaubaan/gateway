/**
 * The management MCP door (feature P2.4; spec §4.1 bis, §7.10): the tools an
 * agent holding a delegated token uses to read the user's authority, preview
 * a policy and issue, rotate or revoke missions in the user's name. Built
 * once by the composition root (`compose/management.ts`) as part of
 * `root.management`, behind the admission gate of the authorization server
 * (`oauth-as`, feature P2.3).
 *
 * What the module is given is the whole of what it can do: see `ports.ts`.
 * Handbook: docs/handbook/management-door.md.
 */
import { ManagementDoor } from './door';
import type { ManagementModuleDeps } from './ports';
import { ManagementTools } from './tools';

export interface ManagementHandlers {
  /** `/mcp/manage` — MCP Streamable HTTP. */
  readonly mcp: (request: Request) => Promise<Response>;
}

export interface ManagementModule {
  /** The seven acts, as typed methods (the MCP tools call these). */
  readonly tools: ManagementTools;
  readonly door: ManagementDoor;
  readonly handlers: ManagementHandlers;
}

export function createManagementModule(deps: ManagementModuleDeps): ManagementModule {
  const logger = deps.logger.child({ component: 'management-door' });
  const tools = new ManagementTools({
    missions: deps.missions,
    catalog: deps.catalog,
    rateLimit: deps.rateLimit,
    logger,
  });
  const door = new ManagementDoor({
    admit: deps.admit,
    tools,
    rateLimit: deps.rateLimit,
    build: deps.build,
    logger,
  });
  return { tools, door, handlers: { mcp: (request) => door.handle(request) } };
}

export {
  MANAGEMENT_INSTRUCTIONS,
  MANAGEMENT_TOOL_NAMES,
  MANAGEMENT_TOOLS,
  type ManagementToolDefinition,
  type ManagementToolKind,
  type ManagementToolName,
} from './definitions';
export {
  MANAGEMENT_RATE_LIMITED_RPC_CODE,
  MANAGEMENT_REQUEST_WINDOW_MS,
  MANAGEMENT_REQUESTS_PER_WINDOW,
  MANAGEMENT_SERVER_INFO_NAME,
  ManagementDoor,
  toolResultOf,
  type ManagementDoorDeps,
} from './door';
export { MANAGEMENT_OUTPUT_SCHEMAS } from './output-schemas';
export {
  MANAGEMENT_DEPENDENCIES,
  MANAGEMENT_MISSION_METHODS,
  type ManagementActor,
  type ManagementAdmission,
  type ManagementCatalog,
  type ManagementMissions,
  type ManagementModuleDeps,
  type ManagementRateLimit,
  type ProviderCatalog,
} from './ports';
export {
  MANAGEMENT_MUTATION_WINDOW_MS,
  MANAGEMENT_MUTATIONS_PER_WINDOW,
  MANAGEMENT_REFUSAL_CODES,
  ManagementTools,
  type BootstrapKitView,
  type ConnectionsAnswer,
  type IssuedMissionAnswer,
  type ManagementRefusal,
  type ManagementRefusalCode,
  type ManagementToolsDeps,
  type MissionsAnswer,
  type RevealedTokenView,
  type RevokedMissionAnswer,
  type RotatedTokenAnswer,
  type ToolOutcome,
} from './tools';
export {
  catalogView,
  connectionView,
  missionDetailView,
  missionView,
  previewView,
  uncoveredOfPreview,
  type CatalogView,
  type ConnectionView,
  type MissionDetailView,
  type MissionView,
  type OrphanView,
  type PreviewView,
  type UncoveredView,
} from './views';

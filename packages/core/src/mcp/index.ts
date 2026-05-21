/**
 * `@crm/core/mcp` — pure MCP composition helpers.
 *
 * Spec: docs/spec/cloud-resource-manager.md §6.6.
 */

export type { McpServerFragment } from './fragment.js';
export {
  composeMcpConfig,
  type ComposableKind,
  type ComposableResource,
  type ComposedMcpConfig,
  type ComposeEnv,
  type ComposeInput,
  type EnvManifestEntry,
} from './compose.js';

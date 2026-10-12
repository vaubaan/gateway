/**
 * Gmail tools — declarations the gateway exposes to MCP clients.
 *
 * **Empty at MVP.** The Gmail adapter / `execute` / wire is explicitly
 * out-of-scope for the provider-modeler skill (cf.
 * `docs/skills/provider-modeler.md`). The coding agent who picks Gmail up
 * after this modelling pass should add the 9 official Google MCP tools +
 * the synthetic `gmail__describe_zones` here (cf. handbook §"Reste à
 * faire").
 *
 * For now we export an empty array so the web provider-info registry
 * (`apps/gateway/src/components/providers/provider-info.ts`) can compile.
 * The catalog coverage lint runs on the classifier directly via a hard-
 * coded list of supported tool names — it does not depend on this array.
 */

import type { McpToolDeclaration } from '@vaubaan/shared';

export const availableTools: ReadonlyArray<McpToolDeclaration> = [];

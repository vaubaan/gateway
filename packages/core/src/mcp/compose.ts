/**
 * `composeMcpConfig` — pure function that turns a set of CRM Resources
 * into a deterministic `mcp.json` snapshot plus an env manifest.
 *
 * Spec docs/spec/cloud-resource-manager.md §6.6 (MCPConfigs), §6.7
 * (Exports), §11.1.
 *
 * Inputs (caller does the resolution upstream):
 *
 *   - `resources` — already-filtered list of visible Resources for the
 *     requested scope (org-wide UNION project-scoped per §7.5). Each
 *     row carries the Resource id, kind, name, variant, and the raw
 *     `provider_metadata`. Order in == order out (the function is
 *     stable so two calls with the same input produce byte-equivalent
 *     output and let the caller short-circuit on no-op regenerate).
 *
 * Outputs:
 *
 *   - `mcpJson.mcpServers` — keyed by `<resource.name>`, value is the
 *     fragment returned by `kind.mcpFragment(metadata)`. Resources
 *     whose kind has no `mcpFragment` or whose fragment is null are
 *     skipped silently — the function does NOT throw on kinds without
 *     MCP support.
 *   - `envManifest.keys` — flat list of `{ key, source_resource_id,
 *     source_kind }` deduplicated by (resource_id, key). The caller
 *     (a REST handler or a UI assembler) is responsible for fetching
 *     the matching sealed blobs from `resource_access` and resolving
 *     the placeholders client-side via `unsealAs` (§7.5).
 *
 * ZK invariant: this function is **pure metadata**. It never reads
 * cleartext, never reaches the DB, never touches `resource_access`.
 *
 * `findKind` is injected via the `env.findKind` callback so we keep
 * the `@crm/core` package free of an explicit dependency on
 * `@crm/catalog` (the dep graph stays `web → catalog → core`).
 */

import type { McpServerFragment } from './fragment.js';

/**
 * Minimal Resource shape the composer needs. Mirrors the columns of
 * `resources` listed in spec §3.1 but only carries what the composer
 * actually reads.
 */
export interface ComposableResource {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly variant: string | null;
  readonly provider_metadata: Readonly<Record<string, unknown>>;
}

/**
 * Minimal kind contract — duplicates the relevant slice of
 * `ResourceKind` from `@crm/catalog`. Used to keep `@crm/core` free of
 * a runtime dependency on the catalogue package.
 */
export interface ComposableKind {
  readonly id: string;
  readonly accessSchema: Readonly<Record<string, unknown>>;
  mcpFragment?(metadata: unknown): McpServerFragment | null;
}

export interface ComposeEnv {
  findKind(id: string): ComposableKind | undefined;
}

export interface EnvManifestEntry {
  readonly key: string;
  readonly source_resource_id: string;
  readonly source_kind: string;
}

export interface ComposedMcpConfig {
  /** `mcp.json` snapshot — `{ mcpServers: { <name>: fragment, ... } }`. */
  readonly mcpJson: {
    readonly mcpServers: Readonly<Record<string, McpServerFragment>>;
  };
  /** Flat manifest of access keys referenced by the snapshot. */
  readonly envManifest: {
    readonly keys: ReadonlyArray<EnvManifestEntry>;
  };
}

export interface ComposeInput {
  readonly resources: ReadonlyArray<ComposableResource>;
  readonly env: ComposeEnv;
}

/**
 * Extract the access-key names referenced by an `${KEY}` placeholder
 * inside the fragment's `args` / `env`. The MCP spec doesn't formalise
 * placeholder syntax — we use the convention adopted by the CRM
 * catalogue (Phase 3): `${IDENTIFIER}` where IDENTIFIER matches
 * `[A-Z_][A-Z0-9_]*`.
 */
const PLACEHOLDER_REGEX = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

function extractPlaceholders(fragment: McpServerFragment): ReadonlyArray<string> {
  const keys = new Set<string>();
  const scan = (value: unknown): void => {
    if (typeof value === 'string') {
      let match: RegExpExecArray | null;
      PLACEHOLDER_REGEX.lastIndex = 0;
      while ((match = PLACEHOLDER_REGEX.exec(value)) !== null) {
        const key = match[1];
        if (typeof key === 'string') keys.add(key);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const v of value) scan(v);
      return;
    }
    if (typeof value === 'object' && value !== null) {
      for (const v of Object.values(value)) scan(v);
    }
  };
  // Scan args + env explicitly so the regex doesn't traverse the whole
  // fragment when callers add arbitrary `extra` fields.
  if (fragment.args !== undefined) scan(fragment.args);
  if (fragment.env !== undefined) scan(fragment.env);
  return Array.from(keys);
}

/**
 * Compose an `mcp.json` snapshot from a list of CRM Resources. Pure —
 * no I/O, no clock, no random. The output is deterministic for a given
 * input (caller passes resources in their canonical order — usually
 * sorted by id ASC upstream).
 */
export function composeMcpConfig(input: ComposeInput): ComposedMcpConfig {
  const mcpServers: Record<string, McpServerFragment> = {};
  const manifest: EnvManifestEntry[] = [];
  const seenKeys = new Set<string>();

  for (const resource of input.resources) {
    const kind = input.env.findKind(resource.kind);
    if (!kind) continue;
    if (typeof kind.mcpFragment !== 'function') continue;
    let fragment: McpServerFragment | null;
    try {
      fragment = kind.mcpFragment(resource.provider_metadata);
    } catch {
      // A kind that throws on malformed metadata (defensive `if
      // (!isXxxMetadata(...)) return null`) is treated as "no
      // fragment". We never let one corrupt Resource break the whole
      // snapshot.
      continue;
    }
    if (fragment === null) continue;

    // Collision safety: if two Resources end up with the same `name`
    // (shouldn't happen — the resources table has a unique
    // `(organization_id, project_id, name)` constraint, but a
    // variant-aware union can pull rows from different projects), we
    // suffix with the resource id so the output stays deterministic
    // and lossless.
    const baseName = resource.name;
    const slotKey = mcpServers[baseName] === undefined ? baseName : `${baseName}-${resource.id}`;
    mcpServers[slotKey] = fragment;

    for (const placeholder of extractPlaceholders(fragment)) {
      const dedup = `${resource.id}:${placeholder}`;
      if (seenKeys.has(dedup)) continue;
      seenKeys.add(dedup);
      manifest.push({
        key: placeholder,
        source_resource_id: resource.id,
        source_kind: resource.kind,
      });
    }
  }

  return {
    mcpJson: { mcpServers },
    envManifest: { keys: manifest },
  };
}

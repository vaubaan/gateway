/**
 * Turn a provider's declarative `DataModel` into a mermaid `erDiagram`
 * source string. Each entity becomes an ER node ; the `parent` field
 * becomes a directional relationship `parent → child` whose cardinality
 * is rendered ON THE EDGE (true ERD, not flowchart with a card label).
 *
 * Mapping of `DataModelEntity.cardinalities` (child side) → ER notation :
 *   - `['one']`               → `||--||` (parent 1 — child 1)
 *   - `['bounded']`           → `||--o{` (parent 1 — child 0..N)
 *   - `['unbounded']`         → `||--o{` (parent 1 — child 0..*)
 *   - mixed (`one`+`bounded`) → `||--o{` (the multi case wins — the entity
 *                                          accepts a list at slice time)
 *
 * Identifier conventions (mermaid v11 ER) :
 *   - Entity ID  = `<plane>--<name>` in kebab-case (e.g. `repo--branch-protection`).
 *                   Mermaid's `UNICODE_TEXT` token accepts `[\w\-\*\.]+` plus
 *                   non-ASCII — kebab-case is parsed as a single identifier.
 *                   Prefixing by plane keeps IDs unique when multiple planes
 *                   are concatenated in one diagram (`project` appears in
 *                   every Supabase plane).
 *   - Display alias = the raw entity name (e.g. `branch-protection`), set
 *                     via the mermaid alias syntax `ID["alias text"]`. This
 *                     is what the user sees on the node — no more shouty
 *                     UPPERCASE_SNAKE_CASE.
 *   - Env-scopable entities get a discrete suffix `· env` appended to the
 *     alias (provider-specific convention — cf. `DataModelEntity.envScopable`
 *     in @vaubaan/shared).
 *
 * Edges :
 *   - The ER grammar makes `: <label>` mandatory after a `relSpec`. Since
 *     every edge means the same thing (containment), the label is just
 *     visual noise. We render it as a single space inside quotes (`" "`)
 *     so the SVG shows nothing on the edge.
 *
 * Root entities (parent === null) are rendered as solo nodes : ER requires
 * relationships to declare entities, so we use an attribute-less entity
 * declaration (`ROOT["root"] { }`) to make them visible.
 *
 * Highlights (`opts.highlights`) :
 *  - the first entity (root of the plane) is the **ORG binding** anchor
 *    (mapped via Vaubaan's `provider_admins`),
 *  - the first child of the root that LOOKS like a project container
 *    (`repo`, `project`, `service`) is the **PROJECT binding** anchor
 *    (mapped via Vaubaan's `provider_bindings`).
 * The caller can override the heuristic via `opts.highlights`. The function
 * emits both a `class` directive AND returns the resolved tag map so the
 * caller can use it (e.g. to drive an out-of-band legend if needed).
 */

import type { DataModel, DataModelEntity, DataModelPlane } from '@vaubaan/shared';

/** Heuristic — entity names that *typically* represent the project container. */
const PROJECT_LIKE_ENTITY_NAMES = new Set(['repo', 'project', 'service']);

export type EntityBindingKind = 'org' | 'project';

export interface MermaidRenderOptions {
  /** Restrict rendering to a single plane (matching `plane.slug`). When
   *  unset, every plane is rendered (legacy behaviour). */
  readonly planeSlug?: string;
  /** Pre-computed binding-anchor tags. When unset, the function falls back
   *  to the default heuristic (see file header). */
  readonly highlights?: ReadonlyMap<string, EntityBindingKind>;
}

export interface MermaidRenderResult {
  /** The mermaid `erDiagram` source — ready to feed into mermaid.render(). */
  readonly source: string;
  /** Resolved entity-id → binding-kind map (so callers can render a legend). */
  readonly highlights: ReadonlyMap<string, EntityBindingKind>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the mermaid ER node ID for an entity. The ID is kebab-case
 * (`<plane>--<name>`) so the diagram displays human-readable identifiers
 * without uppercase-snake noise. Plane-prefixed to keep IDs unique across
 * planes that share an entity name (e.g. `project` in every Supabase plane).
 *
 * Mermaid's ER `UNICODE_TEXT` lexer rule allows `[\w\-\*\.]+` plus non-ASCII,
 * so hyphens / dots / non-ASCII are all valid in an unquoted ID. We still
 * strip anything outside `[A-Za-z0-9_\-]` defensively in case a future
 * entity slug grows odd characters.
 */
export function entityNodeId(planeSlug: string, entityName: string): string {
  const safe = `${planeSlug}--${entityName}`.replace(/[^A-Za-z0-9_-]/g, '_');
  return safe;
}

/** ER cardinality glyph for a child entity. Parent side is always `||` (one). */
function childCardinalityGlyph(card: DataModelEntity['cardinalities']): string {
  // If ANY non-`one` cardinality exists, the child is a many-side.
  const hasMany = card.some((c) => c === 'bounded' || c === 'unbounded');
  // Mermaid ER right-side glyphs :
  //   `o{` = zero-to-many (`||--o{`),
  //   `||` = exactly one  (`||--||`).
  if (hasMany) return 'o{';
  return '||';
}

/**
 * ER edge — the parent is the LEFT side (`||`), the child is the RIGHT side.
 *
 * Mermaid ER grammar : `entityName relSpec entityName COLON role` — the
 * `: role` part is MANDATORY. We never want a visible label on these edges
 * (every relation is containment, the cardinality glyph already says
 * everything), so we emit a quoted single space — mermaid happily parses
 * it as an empty-looking role and the SVG renders no text.
 */
function edge(parent: string, child: string, childCard: DataModelEntity['cardinalities']): string {
  const childGlyph = childCardinalityGlyph(childCard);
  return `    ${parent} ||--${childGlyph} ${child} : " "`;
}

/**
 * Build the alias text shown on the node — the entity's raw name, plus a
 * discrete `· env` suffix when the entity carries the provider's env layer.
 * Wrapped in double quotes (mermaid `ENTITY_NAME` token) — accepts every
 * char except `"%\r\n\v\b\\`.
 */
function entityAlias(entity: DataModelEntity): string {
  const suffix = entity.envScopable ? ' · env' : '';
  return `"${entity.name}${suffix}"`;
}

/** Sanitise an entity for ER block — strip risky characters. */
function safeEntityLine(planeSlug: string, entity: DataModelEntity): string {
  const id = entityNodeId(planeSlug, entity.name);
  // ER entities accept an attribute block ; we keep it empty (the data-model
  // doesn't carry typed columns). The block ensures the entity is rendered
  // even when it has no relationships (root entities of a 1-entity plane).
  // The `[alias]` between id and block sets the user-visible display name.
  return `    ${id}[${entityAlias(entity)}] { }`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Highlights — ORG / PROJECT binding anchors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Default heuristic to detect the two binding anchors :
 *   - ORG       : the root entity (`parent === null`).
 *   - PROJECT   : a direct child of the root whose name matches
 *                 PROJECT_LIKE_ENTITY_NAMES (`repo` / `project` / `service`).
 * Returns a map keyed by ER node id.
 */
function defaultHighlights(plane: DataModelPlane): Map<string, EntityBindingKind> {
  const out = new Map<string, EntityBindingKind>();
  const root = plane.entities.find((e) => e.parent === null);
  if (!root) return out;
  out.set(entityNodeId(plane.slug, root.name), 'org');
  const projectChild = plane.entities.find(
    (e) => e.parent === root.name && PROJECT_LIKE_ENTITY_NAMES.has(e.name),
  );
  if (projectChild) {
    out.set(entityNodeId(plane.slug, projectChild.name), 'project');
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Renderer
// ─────────────────────────────────────────────────────────────────────────────

function renderPlane(plane: DataModelPlane, highlights: Map<string, EntityBindingKind>): string[] {
  const lines: string[] = [];
  // 1. Declare every entity (an attribute-less block is enough — ensures the
  //    entity exists even if it has no parent).
  for (const entity of plane.entities) {
    lines.push(safeEntityLine(plane.slug, entity));
  }
  // 2. Emit edges parent → child.
  for (const entity of plane.entities) {
    if (entity.parent === null) continue;
    const parentExists = plane.entities.some((e) => e.name === entity.parent);
    if (!parentExists) continue;
    lines.push(
      edge(
        entityNodeId(plane.slug, entity.parent),
        entityNodeId(plane.slug, entity.name),
        entity.cardinalities,
      ),
    );
  }
  // 3. Merge default highlights for this plane (if the caller didn't pass any).
  for (const [k, v] of defaultHighlights(plane)) {
    if (!highlights.has(k)) highlights.set(k, v);
  }
  return lines;
}

export function renderDataModelMermaid(
  model: DataModel,
  opts?: MermaidRenderOptions,
): MermaidRenderResult {
  const planesToRender = opts?.planeSlug
    ? model.planes.filter((p) => p.slug === opts.planeSlug)
    : model.planes;

  const highlights = new Map<string, EntityBindingKind>(opts?.highlights ?? []);
  const planeLines: string[] = [];
  for (const plane of planesToRender) {
    planeLines.push(...renderPlane(plane, highlights));
  }

  // Build the ER source.
  // Note : mermaid ER doesn't support per-plane `subgraph`. When multiple
  // planes are rendered we just concatenate them — the rendered graph
  // makes the planes visually distinct because they share no edges.
  const erLines: string[] = ['erDiagram'];
  erLines.push(...planeLines);

  // ClassDef-style highlights — mermaid v11 ER supports `classDef` + `class
  // ID classname`. The binding-anchor highlights still ship as the only
  // visual cue (the out-of-band BindingLegend was removed — the diagram
  // colors are enough).
  if (highlights.size > 0) {
    erLines.push(
      '    classDef orgBinding fill:#fef3c7,stroke:#d97706,stroke-width:3px,color:#92400e',
    );
    erLines.push(
      '    classDef projectBinding fill:#dbeafe,stroke:#2563eb,stroke-width:3px,color:#1e3a8a',
    );
    for (const [nodeId, kind] of highlights) {
      erLines.push(`    class ${nodeId} ${kind === 'org' ? 'orgBinding' : 'projectBinding'}`);
    }
  }

  return {
    source: erLines.join('\n'),
    highlights,
  };
}

/**
 * Legacy entry-point — returns just the mermaid string. Kept for backward
 * compatibility with any non-UI caller (handbook generators, scripts).
 */
export function dataModelToMermaid(model: DataModel, opts?: MermaidRenderOptions): string {
  return renderDataModelMermaid(model, opts).source;
}

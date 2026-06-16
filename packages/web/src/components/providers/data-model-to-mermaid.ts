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
 * Root entities (parent === null) are rendered as solo nodes : ER requires
 * relationships to declare entities, so we use an attribute-less entity
 * declaration (`ROOT { }`) to make them visible.
 *
 * Used by :
 *  - the provider info page (`/orgs/:slug/providers/:provider[/:plane]`),
 *  - eventually the markdown handbook (kept stable for downstream scripts).
 *
 * Highlights (`opts.highlights`) :
 *  - the first entity (root of the plane) is the **ORG binding** anchor
 *    (mapped via Vaubaan's `provider_admins`),
 *  - the first child of the root that LOOKS like a project container
 *    (`repo`, `project`, `service`) is the **PROJECT binding** anchor
 *    (mapped via Vaubaan's `provider_bindings`).
 * The caller can override the heuristic via `opts.highlights`. The function
 * emits both a `class` directive AND returns the resolved tag map so the
 * caller can render an external legend (mermaid's ER classDef styling is
 * sometimes ignored on certain themes — having an out-of-band legend means
 * the user always sees what's highlighted).
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
 * Convert an entity name into the ER-uppercase node id mermaid expects.
 * We prefix with the plane slug to guarantee uniqueness across planes
 * (e.g. `project` appears in every Supabase plane) and ensure ASCII-safe
 * identifiers (replace anything outside [A-Za-z0-9_]).
 */
export function entityNodeId(planeSlug: string, entityName: string): string {
  const safe = `${planeSlug}__${entityName}`.replace(/[^A-Za-z0-9_]/g, '_');
  return safe.toUpperCase();
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

/** ER edge — the parent is the LEFT side (`||`), the child is the RIGHT side. */
function edge(parent: string, child: string, childCard: DataModelEntity['cardinalities']): string {
  const childGlyph = childCardinalityGlyph(childCard);
  // Mermaid ER syntax : LEFT_GLYPH--RIGHT_GLYPH ENTITY : "label"
  //   ||--o{  =  one-to-many (parent 1, child 0..N)
  //   ||--||  =  one-to-one
  // We are emitting parent (one) → child (many|one) so the LEFT is ||.
  return `    ${parent} ||--${childGlyph} ${child} : "has"`;
}

/** Sanitise an entity for ER block — strip risky characters. */
function safeEntityLine(planeSlug: string, entity: DataModelEntity): string {
  const id = entityNodeId(planeSlug, entity.name);
  // ER entities accept an attribute block ; we keep it empty (the data-model
  // doesn't carry typed columns). The block ensures the entity is rendered
  // even when it has no relationships (root entities of a 1-entity plane).
  return `    ${id} { }`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Highlights — ORG / PROJECT binding anchors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Default heuristic to detect the two binding anchors :
 *   - ORG       : the root entity (`parent === null`).
 *   - PROJECT   : a direct child of the root whose name matches
 *                 PROJECT_LIKE_ENTITY_NAMES (`repo` / `project` / `service`).
 * Returns a map keyed by ER node id (uppercase, plane-prefixed).
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
  // ID classname`. If a future version drops this, the legend in the UI is
  // still shown as a fallback.
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

/**
 * DataModel — declarative graph of entities for a provider's plane(s).
 *
 * Spec : docs/spec/gateway-risk-model.md §2.
 *
 * Each provider declares its planes (1+), each plane lists the entities
 * (`row`, `branch`, `env-var`, ...) with their cardinalities and parent
 * (containment graph). The DataModel serves three purposes :
 *
 *   1. **Modeling** : a single canonical source from which the handbook's
 *      mermaid diagram is auto-rendered. Reviewers see the same picture
 *      everywhere.
 *   2. **Threat-modeling** : the risk catalog's `matches` patterns refer
 *      to entity names. Keeping the data-model declarative makes it
 *      impossible to write a catalog entry on an unknown entity (CI lint).
 *   3. **Lint coverage** : every tool MCP must classify to at least one
 *      slice rooted at a declared entity. Unknown entities = silent gap.
 *
 * The structure is intentionally minimal — no fields beyond what the
 * scripts and lints need.
 */

export interface DataModel {
  readonly provider: string;
  readonly planes: readonly DataModelPlane[];
}

export interface DataModelPlane {
  /** Plane slug (e.g. 'repo', 'runtime', 'db', 'storage', 'auth', 'host'). */
  readonly slug: string;
  /** Optional one-liner explaining the plane to a new contributor. */
  readonly description?: string;
  readonly entities: readonly DataModelEntity[];
}

/**
 * One entity in the plane's graph.
 *
 *   - `name`            : entity slug as it appears in slices
 *                         (`branch`, `env-var`, `row`, ...).
 *   - `parent`          : entity slug of the immediate parent (containment) ;
 *                         null at the root of the plane.
 *   - `cardinalities`   : which cardinality forms make sense for this entity
 *                         (at least one). `one` = identifier ; `bounded` =
 *                         finite list / glob ; `unbounded` = wildcard.
 *   - `description`     : one-liner shown in tooltips / handbook diagrams.
 *   - `envScopable`     : when true, this entity is the carrier of the
 *                         provider's "env" layer (risk-model spec §2.3 + §4 : env is a
 *                         per-datum layer, not an orthogonal axis). The exact
 *                         convention is provider-specific :
 *                           - github : `branch` carries the env layer ;
 *                           - vercel : `env` entity ({prod, preview, dev}) ;
 *                           - supabase : `project` (one project_ref per env) ;
 *                           - railway : `environment` (Railway-native node) +
 *                                       `project` (resource-level slug) ;
 *                           - ssh : `host` (one resource = one host = one env).
 *                         Rendered as a small `env` tag next to the entity
 *                         name in the data-model diagram & per-plane lists.
 */
export interface DataModelEntity {
  readonly name: string;
  readonly parent: string | null;
  readonly cardinalities: readonly DataModelCardinality[];
  readonly description: string;
  readonly envScopable?: boolean;
}

export type DataModelCardinality = 'one' | 'bounded' | 'unbounded';

/**
 * Validate that every entity's `parent` either is null or references an
 * existing entity in the same plane. Returns the list of errors (empty
 * array when the data-model is internally consistent). Pure — no IO.
 *
 * The TS type `parent: string | null`
 * does not enforce referential integrity. A typo silently turns the
 * mermaid renderer into a graph with orphan nodes. This function lets the
 * provider unit tests assert the invariant in CI.
 */
export function validateDataModel(model: DataModel): readonly string[] {
  const errors: string[] = [];
  for (const plane of model.planes) {
    const names = new Set(plane.entities.map((e) => e.name));
    for (const entity of plane.entities) {
      if (entity.parent === null) continue;
      if (!names.has(entity.parent)) {
        errors.push(
          `provider '${model.provider}' plane '${plane.slug}': entity '${entity.name}' ` +
            `has parent '${entity.parent}' which is not declared in this plane.`,
        );
      }
    }
  }
  return errors;
}

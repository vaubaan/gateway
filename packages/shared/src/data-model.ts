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
 */
export interface DataModelEntity {
  readonly name: string;
  readonly parent: string | null;
  readonly cardinalities: readonly DataModelCardinality[];
  readonly description: string;
}

export type DataModelCardinality = 'one' | 'bounded' | 'unbounded';

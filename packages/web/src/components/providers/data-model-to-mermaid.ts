/**
 * Turn a provider's declarative `DataModel` into a mermaid `flowchart`
 * source string. One subgraph per plane ; each entity is a node ; the
 * `parent` field becomes a directed edge `parent → child`. Cardinalities
 * are rendered inline in the node label between brackets.
 *
 * Used by the provider info page (`/orgs/:slug/providers/:provider`) to
 * visualise the slice graph reviewers have in mind when authoring catalog
 * patterns.
 */

import type { DataModel, DataModelEntity, DataModelPlane } from '@vaubaan/shared';

const CARDINALITY_GLYPH: Record<string, string> = {
  one: '1',
  bounded: 'N',
  unbounded: '*',
};

function nodeId(planeSlug: string, entityName: string): string {
  // Mermaid node ids must be ASCII-safe — replace anything outside [A-Za-z0-9_]
  // with `_`. We prefix with the plane slug to guarantee uniqueness when an
  // entity name (e.g. `project`) repeats across planes.
  const safe = `${planeSlug}__${entityName}`.replace(/[^A-Za-z0-9_]/g, '_');
  return safe;
}

function nodeLabel(entity: DataModelEntity): string {
  const card = entity.cardinalities.map((c) => CARDINALITY_GLYPH[c] ?? c).join('/');
  // Escape any character that could break the mermaid `[label]` parser. We
  // strip backticks / quotes / parentheses defensively (they show up in
  // long entity descriptions which we do NOT include here anyway).
  const safeName = entity.name.replace(/[`"|]/g, '');
  return `${safeName}<br/><span style='font-size:0.75em;opacity:0.7'>${card}</span>`;
}

function renderPlane(plane: DataModelPlane): string {
  const lines: string[] = [];
  const safePlaneId = plane.slug.replace(/[^A-Za-z0-9_]/g, '_');
  const safePlaneTitle = plane.slug.replace(/"/g, '');
  lines.push(`  subgraph plane_${safePlaneId} ["plane: ${safePlaneTitle}"]`);
  // Declare every node first (so edges below resolve cleanly).
  for (const entity of plane.entities) {
    lines.push(`    ${nodeId(plane.slug, entity.name)}["${nodeLabel(entity)}"]`);
  }
  // Then edges parent → child (skip roots).
  for (const entity of plane.entities) {
    if (entity.parent === null) continue;
    const parentExists = plane.entities.some((e) => e.name === entity.parent);
    if (!parentExists) continue; // defensive — should be caught by lint
    lines.push(`    ${nodeId(plane.slug, entity.parent)} --> ${nodeId(plane.slug, entity.name)}`);
  }
  lines.push('  end');
  return lines.join('\n');
}

export function dataModelToMermaid(model: DataModel): string {
  const head = 'flowchart TD';
  const planes = model.planes.map(renderPlane).join('\n');
  return `${head}\n${planes}`;
}

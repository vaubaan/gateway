/**
 * The data model as an outline: each plane a tree with connectors, in a
 * monospace block; the entity that carries the environment is marked, and the
 * cardinalities are small annotations next to the name.
 */
import { Badge, Slug } from '@/components/ui';
import {
  CARDINALITY_WORDS,
  type EntityNode,
  type EnvironmentReference,
  type PlaneTree,
} from '@/server/providers/reference';

import styles from '../providers.module.css';

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** One line of the outline: the connectors that lead to the entity, then the entity. */
interface OutlineLine {
  readonly node: EntityNode;
  /** `│  ├─ `: drawn in the monospace family, one cell per level. */
  readonly prefix: string;
}

function outlineOf(nodes: readonly EntityNode[], trail = '', depth = 0): OutlineLine[] {
  return nodes.flatMap((node, index) => {
    const last = index === nodes.length - 1;
    // The roots of a plane hang from nothing: no connector, and none below them either.
    const prefix = depth === 0 ? '' : `${trail}${last ? '└─ ' : '├─ '}`;
    const below = depth === 0 ? '' : `${trail}${last ? '   ' : '│  '}`;
    return [{ node, prefix }, ...outlineOf(node.children, below, depth + 1)];
  });
}

export function DataModelSection({
  planes,
  environment,
}: {
  /** The planes in view. */
  planes: readonly PlaneTree[];
  environment: EnvironmentReference;
}) {
  return (
    <div className={styles.section}>
      <p className={styles.sectionLine}>
        How the plugin pictures the provider: the things that exist there and how they nest. Every
        risk is written over these entities; a resource of a connection is one of them, named by its
        ref.
      </p>
      <dl className={styles.envFacts} data-testid="provider-environment">
        <dt>Environment</dt>
        <dd>{environment.explanation}</dd>
        {environment.envs.length > 0 && (
          <>
            <dt>Known</dt>
            <dd className={styles.badges}>
              {environment.envs.map((env) => (
                <Badge key={env} mono>
                  {env}
                </Badge>
              ))}
            </dd>
          </>
        )}
        <dt>Carried by</dt>
        <dd>
          {environment.carriers.length === 0
            ? 'no entity of the model'
            : environment.carriers.map((carrier) => (
                <Slug key={carrier} kind="plane" className={styles.inlineSlug}>
                  {carrier}
                </Slug>
              ))}
          {environment.carriers.length > 0 && environment.source === 'none' && (
            <span className={styles.muted}>
              {' '}
              — in the model only: no risk of this catalog is environment-scoped
            </span>
          )}
        </dd>
      </dl>
      {planes.map((plane) => (
        <section
          key={plane.slug}
          aria-label={`Plane ${plane.slug}`}
          className={styles.planeBlock}
          data-kind="plane"
          data-testid={`plane-${plane.slug}`}
        >
          <h2 className={styles.planeTitle}>
            <Slug kind="plane">{plane.slug}</Slug>
            <span className={styles.muted}>{plural(plane.entity_count, 'entity', 'entities')}</span>
            {plane.description && <span className={styles.planeText}>{plane.description}</span>}
          </h2>
          <ul className={styles.outline}>
            {outlineOf(plane.roots).map(({ node, prefix }) => (
              <li
                key={`${prefix}${node.name}`}
                className={node.carries_env ? styles.outlineEnv : undefined}
              >
                <span className={styles.outlineName}>
                  <span className={styles.connector} aria-hidden="true">
                    {prefix}
                  </span>
                  <strong>{node.name}</strong>
                  <span
                    className={styles.cardinality}
                    title={node.cardinalities
                      .map((name) => `${name} — ${CARDINALITY_WORDS[name]}`)
                      .join('; ')}
                  >
                    {node.cardinalities.join(' · ')}
                  </span>
                  {node.carries_env && <Badge tone="info">carries the environment</Badge>}
                </span>
                <span className={styles.outlineText}>{node.description}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <p className={styles.muted}>
        Cardinalities:{' '}
        {Object.entries(CARDINALITY_WORDS)
          .map(([name, words]) => `${name} — ${words}`)
          .join('; ')}
        .
      </p>
    </div>
  );
}

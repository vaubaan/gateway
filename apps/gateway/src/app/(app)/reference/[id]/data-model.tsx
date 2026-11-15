/**
 * How a service is modelled: where the environment of a call comes from, then
 * each plane as an outline with connectors, in the monospace face. The entity
 * that carries the environment is marked; the cardinalities are small
 * annotations next to the name.
 */
import { EnvTag, KeyValue, Mono, Tag } from '@/components/ui';
import {
  CARDINALITY_WORDS,
  type EntityNode,
  type EnvironmentReference,
  type PlaneTree,
} from '@/lib/services/reference';

import styles from '../reference.module.css';

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
    <section aria-label="How the service is modelled">
      <p className={styles.note}>
        The things that exist at the service and how they nest. Every permission is written over
        these; a resource of an account is one of them, named by its ref.
      </p>
      <div className={styles.callout} data-testid="service-environment">
        <KeyValue
          items={[
            { term: 'Environment', value: environment.explanation },
            ...(environment.envs.length > 0
              ? [
                  {
                    term: 'Known',
                    value: (
                      <span className={styles.inline}>
                        {environment.envs.map((env) => (
                          <EnvTag key={env} env={env} />
                        ))}
                      </span>
                    ),
                  },
                ]
              : []),
            {
              term: 'Carried by',
              value:
                environment.carriers.length === 0 ? (
                  'nothing in the model'
                ) : (
                  <span className={styles.inline}>
                    {environment.carriers.map((carrier) => (
                      <Mono key={carrier}>{carrier}</Mono>
                    ))}
                    {environment.source === 'none' && (
                      <span className={styles.quiet}>
                        in the model only: no permission of this service depends on an environment
                      </span>
                    )}
                  </span>
                ),
            },
          ]}
        />
      </div>
      {planes.map((plane) => (
        <section
          key={plane.slug}
          aria-label={`Part ${plane.slug}`}
          className={styles.plane}
          data-testid={`plane-${plane.slug}`}
        >
          <h3 className={styles.planeTitle}>
            <Mono>{plane.slug}</Mono>
            <span className={styles.quiet}>
              {plural(plane.entity_count, 'thing', 'things')}
              {plane.description ? ` · ${plane.description}` : ''}
            </span>
          </h3>
          <ul className={styles.outline}>
            {outlineOf(plane.roots).map(({ node, prefix }) => (
              <li key={`${prefix}${node.name}`}>
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
                  {node.carries_env && <Tag tone="info">carries the environment</Tag>}
                </span>
                <span className={styles.outlineText}>{node.description}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <p className={styles.note}>
        How many of a thing there can be:{' '}
        {Object.entries(CARDINALITY_WORDS)
          .map(([name, words]) => `${name} — ${words}`)
          .join('; ')}
        .
      </p>
    </section>
  );
}

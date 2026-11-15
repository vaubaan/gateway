/**
 * The tools of a service as a table: the name as the protocol spells it, what
 * it does, its arguments, its plane when the service has several, and the
 * permissions it needs — "by arguments" for every tool: the plugin decides
 * them call by call.
 */
import { DataTable, Mono, Tag, type Column } from '@/components/ui';
import { REFERENCE_WORDS } from '@/lib/vocabulary';
import { REFERENCE_SECTIONS } from '@/lib/services/links';
import { OTHER_PLANE } from '@/lib/services/planes';
import { TOOL_RISKS_NOTE, type ToolReference } from '@/lib/services/reference';

import styles from '../reference.module.css';

export function ToolList({
  tools,
  total,
  serviceName,
  showPlane,
  onGo,
}: {
  /** The tools in view (one plane, a text filter, or all of them). */
  tools: readonly ToolReference[];
  total: number;
  serviceName: string;
  showPlane: boolean;
  onGo: (fragment: string) => void;
}) {
  const columns: readonly Column<ToolReference>[] = [
    {
      id: 'tool',
      header: 'Tool',
      width: '28%',
      cell: (tool) => <Mono>{tool.name}</Mono>,
    },
    { id: 'does', header: 'What it does', cell: (tool) => tool.description },
    {
      id: 'arguments',
      header: 'Arguments',
      width: '18%',
      cell: (tool) =>
        tool.required.length === 0 && tool.optional.length === 0 ? (
          <span className={styles.quiet}>none</span>
        ) : (
          <span className={styles.arguments}>
            {tool.required.map((name) => (
              <Mono key={name} title="Required">
                {name}
              </Mono>
            ))}
            {tool.optional.map((name) => (
              <Mono key={name} quiet title="Optional">
                {`${name}?`}
              </Mono>
            ))}
          </span>
        ),
    },
    ...(showPlane
      ? [
          {
            id: 'plane',
            header: 'Part',
            width: '9%',
            cell: (tool: ToolReference) =>
              tool.planes.map((plane) =>
                plane === OTHER_PLANE ? (
                  <span key={plane} className={styles.quiet}>
                    other
                  </span>
                ) : (
                  <Tag key={plane} mono>
                    {plane}
                  </Tag>
                ),
              ),
          } satisfies Column<ToolReference>,
        ]
      : []),
    {
      id: 'permissions',
      header: REFERENCE_WORDS.tabs.permissions,
      width: '19%',
      cell: () => <span className={styles.quiet}>{REFERENCE_WORDS.byArguments}</span>,
    },
  ];

  return (
    <section aria-label={`Tools of ${serviceName}`}>
      <p className={styles.note}>
        What an agent can call through a mission that uses a {serviceName} account. Which
        permissions a call needs depends on its arguments, so none is listed per tool.{' '}
        <a
          href={`#${REFERENCE_SECTIONS.risks}`}
          onClick={(event) => {
            event.preventDefault();
            onGo('permissions');
          }}
        >
          See the permissions
        </a>
        .
      </p>
      <details className={styles.more}>
        <summary>Why no permission is listed per tool</summary>
        <p>{TOOL_RISKS_NOTE}</p>
      </details>
      {total === 0 ? (
        <p className={styles.empty}>This service declares no tool.</p>
      ) : tools.length === 0 ? (
        <p className={styles.empty}>{REFERENCE_WORDS.noMatch}</p>
      ) : (
        <DataTable
          caption={`The tools of ${serviceName}`}
          columns={columns}
          rows={tools}
          rowKey={(tool) => tool.name}
          density="tight"
          testId="tool-table"
        />
      )}
    </section>
  );
}

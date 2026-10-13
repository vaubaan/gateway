/**
 * The tools of a plugin as a dense table: the name as a tool-coloured slug,
 * what it does, its arguments, its plane when the provider has several, and
 * the risks the plugin declares for it — which is "depends on the arguments"
 * for every tool but the ones that hand the agent a token.
 */
import { RiskIdLink } from '@/components/risk/RiskExplain';
import { Badge, Callout, Help, Slug } from '@/components/ui';
import { noteBody } from '@/server/missions/catalog-view';
import { REFERENCE_SECTIONS } from '@/server/providers/links';
import { OTHER_PLANE } from '@/server/providers/planes';
import {
  TOKEN_HANDOUT_NOTE,
  TOOL_RISKS_NOTE,
  type ToolReference,
} from '@/server/providers/reference';

import styles from '../providers.module.css';

export function ToolTable({
  tools,
  total,
  providerName,
  experimental,
  showPlane,
  onGo,
}: {
  /** The tools in view (one plane, or all of them). */
  tools: readonly ToolReference[];
  total: number;
  providerName: string;
  experimental: boolean;
  showPlane: boolean;
  onGo: (fragment: string) => void;
}) {
  return (
    <div className={styles.section}>
      <Help
        id="provider-tools"
        line={
          <>
            What an agent can call through a mission that carries a {providerName} connection. The
            risks a call touches depend on its arguments, so no risk is listed per tool.
          </>
        }
      >
        <p>
          {TOOL_RISKS_NOTE}{' '}
          <a
            href={`#${REFERENCE_SECTIONS.risks}`}
            className={styles.link}
            onClick={(event) => {
              event.preventDefault();
              onGo(REFERENCE_SECTIONS.risks);
            }}
          >
            See the risk catalog
          </a>
          .
        </p>
      </Help>
      {tools.some((tool) => tool.hands_token) && (
        <Callout
          tone="danger"
          icon="key"
          title="One tool hands a token to the agent"
          testId="token-handout-note"
        >
          {noteBody(TOKEN_HANDOUT_NOTE)}
        </Callout>
      )}
      {experimental && (
        <Callout tone="warning" icon="flask" title="Experimental plugin">
          Kept out of the default connect and issuance flows; its tools are not listed to agents.
        </Callout>
      )}
      {total === 0 ? (
        <p className={styles.empty}>This plugin declares no tool.</p>
      ) : tools.length === 0 ? (
        <p className={styles.empty}>No tool is filed under this plane.</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.tools} data-kind="tool" data-testid="tool-table">
            <thead>
              <tr>
                <th scope="col">Tool</th>
                <th scope="col">What it does</th>
                <th scope="col">Arguments</th>
                {showPlane && <th scope="col">Plane</th>}
                <th scope="col">Risks</th>
              </tr>
            </thead>
            <tbody>
              {tools.map((tool) => (
                <tr key={tool.name} data-testid={`tool-${tool.name}`}>
                  <th scope="row">
                    <Slug kind="tool">{tool.name}</Slug>
                  </th>
                  <td>{tool.description}</td>
                  <td>
                    {tool.required.length === 0 && tool.optional.length === 0 && (
                      <span className={styles.muted}>none</span>
                    )}
                    {tool.required.map((name) => (
                      <code key={name} className={styles.arg} title="Required">
                        {name}
                      </code>
                    ))}
                    {tool.optional.map((name) => (
                      <code
                        key={name}
                        className={`${styles.arg} ${styles.argOptional}`}
                        title="Optional"
                      >
                        {name}?
                      </code>
                    ))}
                  </td>
                  {showPlane && (
                    <td className={styles.nowrap}>
                      {tool.planes.map((plane) =>
                        plane === OTHER_PLANE ? (
                          <span key={plane} className={styles.muted}>
                            other
                          </span>
                        ) : (
                          <Slug key={plane} kind="plane">
                            {plane}
                          </Slug>
                        ),
                      )}
                    </td>
                  )}
                  <td>
                    {tool.declared_risks === null ? (
                      <span className={`${styles.muted} ${styles.nowrap}`}>by arguments</span>
                    ) : (
                      <span className={styles.toolRisks}>
                        {tool.hands_token && (
                          <Badge tone="danger">
                            <span title={TOKEN_HANDOUT_NOTE}>hands a token to the agent</span>
                          </Badge>
                        )}
                        {tool.declared_risks.map((riskId) => (
                          <RiskIdLink key={riskId} riskId={riskId} />
                        ))}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

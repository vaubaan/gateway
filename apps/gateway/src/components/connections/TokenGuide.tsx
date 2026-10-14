/**
 * How to create a token by hand at a service, read from the plugin's
 * declaration (`ConnectMethod.guide`): where to go, the permissions to tick
 * with the tools each one serves, the expiry to choose, and the tools a
 * token cannot run. Nothing about a service is written here; the frame's
 * words are `TOKEN_CONNECT`.
 */
import { Callout, Disclosure, Hint, Mono, Row, Rows, Section } from '@/components/ui';
import { listed, TOKEN_CONNECT } from '@/lib/vocabulary';
import type { ConnectMethod, TokenPermissionView } from '@/server/connections';

import styles from './TokenGuide.module.css';

/** At most this many tool titles are named after a permission; the rest are counted. */
const TOOLS_NAMED = 3;

function accessWords(permission: TokenPermissionView): string {
  return permission.access === 'read-write' ? TOKEN_CONNECT.writeAccess : TOKEN_CONNECT.readAccess;
}

export function TokenGuide({ service, method }: { service: string; method: ConnectMethod }) {
  const guide = method.guide;
  return (
    <div className={styles.guide} data-testid="token-guide">
      {guide && (
        <Section title={TOKEN_CONNECT.stepsTitle(service)} first>
          <ol className={styles.steps}>
            {guide.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          {method.createUrl && (
            <p className={styles.link}>
              <a href={method.createUrl} target="_blank" rel="noreferrer noopener">
                {TOKEN_CONNECT.openTokenPage(service)}
              </a>
            </p>
          )}
          <Hint>
            {guide.recommendedExpiryDays === null
              ? TOKEN_CONNECT.noExpiry(service)
              : TOKEN_CONNECT.expiry(guide.recommendedExpiryDays)}
          </Hint>
        </Section>
      )}

      {guide && guide.permissions.length > 0 && (
        <Section
          title={TOKEN_CONNECT.permissionsTitle}
          count={guide.permissions.length}
          note={TOKEN_CONNECT.permissionsNote}
          testId="token-permissions"
        >
          <Rows label={TOKEN_CONNECT.permissionsTitle}>
            {guide.permissions.map((permission) => (
              <Row
                key={`${permission.name}:${permission.access}`}
                title={permission.name}
                aside={<span className={styles.access}>{accessWords(permission)}</span>}
                description={TOKEN_CONNECT.usedBy(
                  listed(
                    permission.tools.map((tool) => tool.title),
                    TOOLS_NAMED,
                  ),
                )}
              />
            ))}
          </Rows>
        </Section>
      )}

      {method.unavailableTools.length > 0 && (
        <Callout
          tone="neutral"
          title={TOKEN_CONNECT.notWithToken(method.unavailableTools.length)}
          testId="token-unavailable"
        >
          {method.unavailableTools.length === 1 ? (
            <p className={styles.unavailable}>
              {method.unavailableTools[0]!.title} (<Mono>{method.unavailableTools[0]!.name}</Mono>){' '}
              {method.unavailableTools[0]!.reason}
            </p>
          ) : (
            <>
              <p className={styles.unavailable}>{method.unavailableTools[0]!.reason}</p>
              <Disclosure
                id="account-connect:unavailable-tools"
                show={`Show the ${method.unavailableTools.length} tools`}
                hide="Hide the tools"
              >
                <ul className={styles.toolList}>
                  {method.unavailableTools.map((tool) => (
                    <li key={tool.name}>
                      {tool.title} <Mono>{tool.name}</Mono>
                    </li>
                  ))}
                </ul>
              </Disclosure>
            </>
          )}
        </Callout>
      )}
    </div>
  );
}

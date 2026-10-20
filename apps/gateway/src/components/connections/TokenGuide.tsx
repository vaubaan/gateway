/**
 * How to create a token by hand at a service, read from the plugin's
 * declaration (`ConnectableProvider.guide`): where to go and the expiry to
 * choose (step 1), the permissions to tick with the tools each one serves
 * (step 2). The connect page adds step 3, the form.
 * Nothing about a service is written here; the frame's words are
 * `TOKEN_CONNECT`.
 */
import { FormStep, Hint, Row, Rows } from '@/components/ui';
import { listed, TOKEN_CONNECT } from '@/lib/vocabulary';
import type { ConnectableProvider, TokenPermissionView, ToolLabel } from '@/server/connections';

import styles from './TokenGuide.module.css';

/** At most this many tool titles are named after a permission; the rest are counted. */
const TOOLS_NAMED = 3;

/** One row per permission name: "read and write" when any tool writes, every tool it serves. */
interface PermissionLine {
  readonly name: string;
  readonly write: boolean;
  readonly tools: readonly ToolLabel[];
}

export function permissionLines(permissions: readonly TokenPermissionView[]): PermissionLine[] {
  const lines = new Map<string, { write: boolean; tools: ToolLabel[] }>();
  for (const permission of permissions) {
    const line = lines.get(permission.name) ?? { write: false, tools: [] };
    line.write ||= permission.access === 'read-write';
    for (const tool of permission.tools) {
      if (!line.tools.some((known) => known.name === tool.name)) line.tools.push(tool);
    }
    lines.set(permission.name, line);
  }
  return [...lines].map(([name, line]) => ({ name, ...line }));
}

/** Steps 1 and 2 of the connect page for a way that has a guide. */
export function TokenGuide({
  service,
  provider,
}: {
  service: string;
  provider: ConnectableProvider;
}) {
  const guide = provider.guide;
  if (!guide) return null;
  const lines = permissionLines(guide.permissions);
  return (
    <div className={styles.guide} data-testid="token-guide">
      <FormStep n={1} title={TOKEN_CONNECT.stepsTitle(service)}>
        <ol className={styles.steps}>
          {guide.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        {provider.createUrl && (
          <p className={styles.link}>
            <a href={provider.createUrl} target="_blank" rel="noreferrer noopener">
              {TOKEN_CONNECT.openTokenPage(service)}
            </a>
          </p>
        )}
        <Hint>
          {guide.recommendedExpiryDays === null
            ? TOKEN_CONNECT.noExpiry(service)
            : TOKEN_CONNECT.expiry(guide.recommendedExpiryDays)}
        </Hint>
      </FormStep>

      {lines.length > 0 && (
        <FormStep
          n={2}
          title={TOKEN_CONNECT.permissionsTitle}
          hint={lines.length > 0 ? TOKEN_CONNECT.permissionsNote : undefined}
          testId="token-permissions"
        >
          {lines.length > 0 && (
            <Rows label={TOKEN_CONNECT.permissionsTitle}>
              {lines.map((line) => (
                <Row
                  key={line.name}
                  title={line.name}
                  aside={
                    <span className={styles.access}>
                      {line.write ? TOKEN_CONNECT.writeAccess : TOKEN_CONNECT.readAccess}
                    </span>
                  }
                  description={TOKEN_CONNECT.usedBy(
                    listed(
                      line.tools.map((tool) => tool.title),
                      TOOLS_NAMED,
                    ),
                  )}
                />
              ))}
            </Rows>
          )}
        </FormStep>
      )}
    </div>
  );
}

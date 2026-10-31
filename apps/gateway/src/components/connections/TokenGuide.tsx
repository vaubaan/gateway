/**
 * How to create a token by hand at a service, read from the plugin's
 * declaration (`ConnectableProvider.guide`): how wide to grant and why, the
 * steps with their pages and commands, the token page, who knows the expiry
 * and the service's documentation (step 1); the permissions to tick with the
 * tools each one serves (step 2). The connect page adds the last step, the
 * form. Nothing about a service is written here; the frame's words are
 * `TOKEN_CONNECT`.
 */
import { Callout, CodeBlock, FormStep, Hint, Row, Rows } from '@/components/ui';
import { listed, TOKEN_CONNECT } from '@/lib/vocabulary';
import type {
  ConnectableProvider,
  TokenGuideView,
  TokenPermissionView,
  ToolLabel,
} from '@/server/connections';

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

/** What the page says about the token's lifetime, by who knows it. */
export function expiryWords(service: string, expiry: TokenGuideView['expiry']): string {
  switch (expiry.kind) {
    case 'provider-reports':
      return TOKEN_CONNECT.expiryReported(service);
    case 'person-types':
      return TOKEN_CONNECT.expiryTyped(service, expiry.recommendedDays);
    case 'none':
      return expiry.reason;
  }
}

function Steps({ steps }: { steps: TokenGuideView['steps'] }) {
  return (
    <ol className={styles.steps}>
      {steps.map((step) => (
        <li key={step.do}>
          {step.do}
          {step.url && (
            <>
              {' '}
              (
              <a href={step.url} target="_blank" rel="noreferrer noopener">
                {TOKEN_CONNECT.openStepPage}
              </a>
              )
            </>
          )}
          {step.code && (
            <div className={styles.code}>
              <CodeBlock label={TOKEN_CONNECT.stepCommand} wrap>
                {step.code}
              </CodeBlock>
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}

/** Steps 1 and 2 of the connect page for a token way. */
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
        <Callout
          tone="info"
          title={TOKEN_CONNECT.reachTitle(guide.reach.what, guide.reach.grant)}
          testId="token-reach"
        >
          {guide.reach.why}
        </Callout>
        <Steps steps={guide.steps} />
        {provider.createUrl && (
          <p className={styles.link}>
            <a href={provider.createUrl} target="_blank" rel="noreferrer noopener">
              {TOKEN_CONNECT.openTokenPage(service)}
            </a>
          </p>
        )}
        <Hint>
          <span data-testid="token-expiry">{expiryWords(service, guide.expiry)}</span>{' '}
          <a href={guide.docsUrl} target="_blank" rel="noreferrer noopener">
            {TOKEN_CONNECT.docsLink(service)}
          </a>
        </Hint>
      </FormStep>

      {lines.length > 0 && (
        <FormStep
          n={2}
          title={TOKEN_CONNECT.permissionsTitle}
          hint={TOKEN_CONNECT.permissionsNote}
          testId="token-permissions"
        >
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
        </FormStep>
      )}
    </div>
  );
}

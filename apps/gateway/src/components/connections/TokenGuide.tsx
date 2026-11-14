/**
 * How to create a token by hand at a service, read from the plugin's
 * declaration (`ConnectableProvider.guide`): how wide to grant and why, the
 * steps with their menu paths (highlighted chips), pages, commands and
 * screenshots (a figure with its provenance line), the token page, who knows the expiry
 * and the service's documentation (step 1); the permissions to tick, each with
 * its access (step 2) — not the tools they serve: the person is configuring a
 * service here, not reading the detail of what each permission is for. The connect page adds the last step, the
 * form. Nothing about a service is written here; the frame's words are
 * `TOKEN_CONNECT`.
 */
import type { CredentialAlternative } from '@vaubaan/plugin-sdk';

import { Callout, CodeBlock, FormStep, Hint, Radio, Row, Rows } from '@/components/ui';
import { TOKEN_CONNECT } from '@/lib/vocabulary';
import {
  ALTERNATIVE_FIELD,
  type AlternativeView,
  type ConnectableProvider,
  type GuideStepView,
  type TokenGuideView,
  type TokenPermissionView,
} from '@/server/connections';

import styles from './TokenGuide.module.css';

/** One row per permission name: "read and write" when any declaration of it writes. */
interface PermissionLine {
  readonly name: string;
  readonly write: boolean;
}

export function permissionLines(permissions: readonly TokenPermissionView[]): PermissionLine[] {
  const lines = new Map<string, boolean>();
  for (const permission of permissions) {
    lines.set(
      permission.name,
      (lines.get(permission.name) ?? false) || permission.access === 'read-write',
    );
  }
  return [...lines].map(([name, write]) => ({ name, write }));
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

/** A step, and the alternative whose panel it belongs to (`-1`: every alternative). */
interface PanelStep {
  readonly step: GuideStepView;
  readonly panel: number;
}

/**
 * The steps of every alternative, each in its panel, then the guide's own:
 * one numbered list, the page hiding the panels of the alternatives not chosen.
 */
export function panelSteps(
  alternatives: readonly AlternativeView[],
  steps: readonly GuideStepView[],
): PanelStep[] {
  return [
    ...alternatives.flatMap((alt, panel) => alt.steps.map((step) => ({ step, panel }))),
    ...steps.map((step) => ({ step, panel: -1 })),
  ];
}

/** The menus to follow at the service, as highlighted chips: "Settings › Developer settings". */
export function GuidePath({ path, service }: { path: readonly string[]; service: string }) {
  return (
    <span className={`path ${styles.path}`} aria-label={TOKEN_CONNECT.pathLabel(service)}>
      {path.map((segment, i) => (
        <span key={`${i}:${segment}`} className={styles.pathItem}>
          {i > 0 && (
            <span className={styles.pathSeparator} aria-hidden="true">
              {TOKEN_CONNECT.pathSeparator}
            </span>
          )}
          <span className={styles.pathSegment} data-testid="guide-path-segment">
            {segment}
          </span>
        </span>
      ))}
    </span>
  );
}

function Steps({ steps, service }: { steps: readonly PanelStep[]; service: string }) {
  return (
    <ol className={styles.steps}>
      {steps.map(({ step, panel }) => (
        <li key={`${panel}:${step.do}`} data-alternative-panel={panel < 0 ? undefined : panel}>
          {step.path && step.path.length > 0 && <GuidePath path={step.path} service={service} />}
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
          {step.figure && (
            <figure className={`shot ${styles.shot}`} data-testid="guide-screenshot">
              {/* Served by the gateway from the plugin's folder (`connectFileUrl`). */}
              <img src={step.figure.url} alt={step.figure.alt} loading="lazy" />
              <figcaption>{step.figure.attribution}</figcaption>
            </figure>
          )}
        </li>
      ))}
    </ol>
  );
}

/**
 * The radio between the shapes of the key, bound to the connect form by
 * `formId` (it sits in step 1, the form in the last step).
 */
function AlternativeChoice({
  alternatives,
  chosen,
  formId,
}: {
  alternatives: readonly CredentialAlternative[];
  chosen: string | null;
  formId: string;
}) {
  return (
    <fieldset className={styles.alternatives} data-testid="token-alternatives">
      <legend className={styles.alternativesLegend}>{TOKEN_CONNECT.alternativesLegend}</legend>
      {alternatives.map((alt, i) => (
        <div key={alt.id} className={styles.alternative}>
          <Radio
            name={ALTERNATIVE_FIELD}
            value={alt.id}
            form={formId}
            required
            defaultChecked={alt.id === (chosen ?? alternatives[0]?.id)}
            data-alternative-choice={i}
            data-testid={`token-alternative-${alt.id}`}
          >
            {alt.label}
          </Radio>
          {alt.help && <Hint>{alt.help}</Hint>}
        </div>
      ))}
    </fieldset>
  );
}

/**
 * Steps 1 and 2 of the connect page for a token way. A key with alternatives
 * starts with the radio (`chosen` is checked, the first one otherwise: the
 * plugin lists the narrowest first), bound to the form `formId`.
 */
export function TokenGuide({
  service,
  provider,
  chosen = null,
  formId,
}: {
  service: string;
  provider: ConnectableProvider;
  chosen?: string | null;
  formId: string;
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
        {provider.alternatives.length > 0 && (
          <AlternativeChoice alternatives={provider.alternatives} chosen={chosen} formId={formId} />
        )}
        <Steps steps={panelSteps(provider.alternatives, guide.steps)} service={service} />
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
              />
            ))}
          </Rows>
        </FormStep>
      )}
    </div>
  );
}

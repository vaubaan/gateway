/**
 * `/admin/telemetry` — community telemetry (spec §9, §4.2 Administration):
 * the operator's toggle, the collector URL in use, and the exact payload of
 * a report as this instance would send it. Off at installation. Read-only
 * when the mounted configuration sets `telemetry.enabled` (the file wins).
 */
import { PLUGIN_REPORT_KEYS } from '@vaubaan/telemetry';

import styles from '@/components/auth/auth.module.css';
import {
  Badge,
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Stack,
} from '@/components/ui';
import { requireOperator } from '@/lib/auth/session';
import {
  ENABLED_FIELD,
  PROBLEM_PARAM,
  TELEMETRY_ACTION,
  type TelemetryProblem,
} from '@/server/telemetry';

export const dynamic = 'force-dynamic';

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const PROBLEMS: Readonly<Record<TelemetryProblem, string>> = {
  locked:
    'The mounted configuration sets telemetry.enabled; change it there. The toggle is read-only.',
  invalid: 'The request did not say whether to enable or disable telemetry.',
};

const SOURCE_LABEL = {
  config: 'set by the mounted configuration',
  admin: 'set from this page',
  default: 'default (never enabled)',
} as const;

function isProblem(value: unknown): value is TelemetryProblem {
  return typeof value === 'string' && value in PROBLEMS;
}

export default async function TelemetryPage({ searchParams }: Props) {
  const { root } = await requireOperator();
  const params = await searchParams;
  const problem = isProblem(params[PROBLEM_PARAM]) ? params[PROBLEM_PARAM] : null;
  const overview = await root.telemetry.overview();
  const { state } = overview;

  return (
    <Stack gap="var(--space-6)">
      <div>
        <h1>Telemetry</h1>
        <p className={styles.muted}>
          Plugins cannot be tested against real providers by the project. When you opt in, this
          instance tells the project&apos;s collector whether each call a plugin executed succeeded,
          so that a plugin version can be deemed validated by its users. Nothing is sent until you
          enable it.
        </p>
      </div>

      {problem && (
        <Banner tone="danger" title="Not changed">
          {PROBLEMS[problem]}
        </Banner>
      )}

      {state.enabled && overview.placeholderCollector && (
        <Banner tone="warning" title="Enabled, but nothing is sent">
          The collector URL is still the placeholder default: no collector exists behind it, so this
          instance sends nothing. Set <code>telemetry.collector_url</code> (or{' '}
          <code>VAUBAAN_TELEMETRY_COLLECTOR_URL</code>) to a real collector to contribute.
        </Banner>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Opt-in</CardTitle>
          {state.enabled ? <Badge tone="success">enabled</Badge> : <Badge>disabled</Badge>}
        </CardHeader>
        <CardBody>
          <Stack gap="var(--space-4)">
            <dl className={styles.dl}>
              <dt>State</dt>
              <dd>
                {state.enabled ? 'enabled' : 'disabled'} — {SOURCE_LABEL[state.source]}
              </dd>
              <dt>Collector URL</dt>
              <dd>
                <code>{overview.collectorUrl}</code>
                {overview.placeholderCollector && ' (placeholder default)'}
              </dd>
              <dt>Collector key</dt>
              <dd>
                {overview.collectorKeySet
                  ? 'a public key is configured (sent as a header)'
                  : 'none'}
              </dd>
              <dt>Sending</dt>
              <dd>
                {overview.client === 'sending' && 'yes'}
                {overview.client === 'disabled' && 'no — telemetry is disabled'}
                {overview.client === 'placeholder-collector' && 'no — no collector is configured'}
              </dd>
              <dt>Since start</dt>
              <dd>
                {overview.queue.delivered} sent, {overview.queue.queued} queued,{' '}
                {overview.queue.dropped} dropped
              </dd>
            </dl>
            {overview.locked ? (
              <p className={styles.muted}>
                The mounted configuration sets <code>telemetry.enabled</code>; it takes precedence
                and the toggle is read-only here.
              </p>
            ) : (
              <form method="post" action={TELEMETRY_ACTION}>
                <Button
                  type="submit"
                  name={ENABLED_FIELD}
                  value={state.enabled ? 'false' : 'true'}
                  variant={state.enabled ? 'ghost' : 'primary'}
                >
                  {state.enabled ? 'Disable telemetry' : 'Enable telemetry'}
                </Button>
              </form>
            )}
          </Stack>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>What a report contains</CardTitle>
        </CardHeader>
        <CardBody>
          <Stack gap="var(--space-4)">
            <p>
              One report per call a plugin executed, sent in batches. This is the exact request body
              for one report from this instance — {PLUGIN_REPORT_KEYS.length} fields and nothing
              else:
            </p>
            <pre data-testid="telemetry-sample">
              <code>{overview.samplePayload}</code>
            </pre>
            <p className={styles.muted}>
              <code>outcome</code> is one of success, upstream-error, classification-error,
              execution-error; <code>error_class</code> is a fixed keyword or an HTTP status, never
              a message.
            </p>
            <p>
              Never sent: the arguments of a call or a hash of them, resource references, mission
              identifiers, user identifiers, any identifier of this instance, its address or its
              host name, the text of a provider&apos;s error.
            </p>
          </Stack>
        </CardBody>
      </Card>
    </Stack>
  );
}

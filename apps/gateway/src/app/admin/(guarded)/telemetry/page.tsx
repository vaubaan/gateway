/**
 * `/admin/telemetry` — community telemetry (spec §9, §4.2 "Administration"):
 * the administrator's switch, where reports go, and the exact payload of a
 * report as this gateway would send it. Off at installation. Read-only when
 * the mounted configuration sets `telemetry.enabled` (the file wins).
 */
import { PLUGIN_REPORT_KEYS } from '@vaubaan/telemetry';

import styles from '@/components/settings/settings.module.css';
import {
  Button,
  Callout,
  CodeBlock,
  Hint,
  KeyValue,
  Mono,
  PageHeader,
  Section,
  Tag,
} from '@/components/ui';
import { requireOperator } from '@/lib/auth/session';
import { CONFIG_WORDS, formatNumber, SETTINGS_ACTIONS, SETTINGS_PAGES } from '@/lib/vocabulary';
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
    'The mounted configuration sets telemetry.enabled; change it there. The switch is read-only here.',
  invalid: 'The request did not say whether to turn telemetry on or off.',
};

const SOURCE_WORDS = {
  config: CONFIG_WORDS.file,
  admin: 'set from this page',
  default: 'never turned on',
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
    <>
      <PageHeader
        title={SETTINGS_PAGES.telemetry.title}
        lede={SETTINGS_PAGES.telemetry.lede}
        status={<Tag>{state.enabled ? 'on' : 'off'}</Tag>}
      />

      {(problem || (state.enabled && overview.placeholderCollector)) && (
        <div className={styles.notes}>
          {problem && (
            <Callout tone="bad" title="Not changed">
              {PROBLEMS[problem]}
            </Callout>
          )}
          {state.enabled && overview.placeholderCollector && (
            <Callout tone="warn" title="On, but nothing is sent">
              The collector address is still the placeholder: nothing listens behind it, so this
              gateway sends nothing. Set <Mono>telemetry.collector_url</Mono> (or{' '}
              <Mono>VAUBAAN_TELEMETRY_COLLECTOR_URL</Mono>) to a real collector to contribute.
            </Callout>
          )}
        </div>
      )}

      <Section first>
        <KeyValue
          items={[
            {
              term: 'State',
              value: `${state.enabled ? 'on' : 'off'} · ${SOURCE_WORDS[state.source]}`,
            },
            {
              term: 'Reports go to',
              value: (
                <>
                  <Mono>{overview.collectorUrl}</Mono>
                  {overview.placeholderCollector && ' · the placeholder'}
                  {overview.collectorKeySet && ' · with a public key, sent as a header'}
                </>
              ),
            },
            {
              term: 'Sending',
              value:
                overview.client === 'sending'
                  ? 'yes'
                  : overview.client === 'disabled'
                    ? 'no: telemetry is off'
                    : 'no: no collector is configured',
            },
            {
              term: 'Since start',
              value: `${formatNumber(overview.queue.delivered)} sent, ${formatNumber(overview.queue.queued)} queued, ${formatNumber(overview.queue.dropped)} dropped`,
            },
          ]}
        />
        {overview.locked ? (
          <Hint>{CONFIG_WORDS.fileReadOnly}</Hint>
        ) : (
          <form method="post" action={TELEMETRY_ACTION} className={styles.formActions}>
            <Button
              type="submit"
              name={ENABLED_FIELD}
              value={state.enabled ? 'false' : 'true'}
              variant={state.enabled ? 'secondary' : 'primary'}
            >
              {state.enabled ? SETTINGS_ACTIONS.turnOff : SETTINGS_ACTIONS.turnOn}
            </Button>
          </form>
        )}
        <Hint>
          The project cannot test plugins against real services. When you turn this on, the gateway
          tells the project’s collector whether each call a plugin executed succeeded, so that a
          plugin version can be deemed validated by the people who use it.
        </Hint>
      </Section>

      <Section title="What a report contains">
        <div className={styles.prose}>
          <p>
            One report per call a plugin executed, sent in batches. This is the exact request body
            for one report from this gateway — {PLUGIN_REPORT_KEYS.length} fields and nothing else:
          </p>
        </div>
        <div className={styles.block}>
          <CodeBlock label="One report" testId="telemetry-sample" copy={false}>
            {overview.samplePayload}
          </CodeBlock>
        </div>
        <Hint>
          <Mono>outcome</Mono> is one of success, upstream-error, classification-error,
          execution-error; <Mono>error_class</Mono> is a fixed keyword or an HTTP status, never a
          message. Never sent: the arguments of a call or a hash of them, resource references,
          mission identifiers, user identifiers, any identifier of this gateway, its address or its
          host name, the text of a service’s error.
        </Hint>
      </Section>
    </>
  );
}

/**
 * The published validation thresholds of plugin health (website spec §2.4).
 * They live in one SQL function of the collector's schema,
 * `public.plugin_validation_thresholds()` in `deploy/collector/schema.sql`;
 * the collector's README publishes the same numbers and a gateway test
 * (`telemetry-collector-schema.test.ts`) compares the two. The site reads the
 * SQL, the place the collector computes `validated` from.
 */
export const THRESHOLDS_SOURCE = 'deploy/collector/schema.sql';

export interface ValidationThresholds {
  readonly minReports: number;
  /** 0 to 1. */
  readonly minSuccessRate: number;
  readonly windowDays: number;
}

export function parseThresholds(schemaSql: string): ValidationThresholds {
  const match =
    /plugin_validation_thresholds\(\)[\s\S]*?select (\d+), (0\.\d+)::numeric, (\d+)/.exec(
      schemaSql,
    );
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new Error(`${THRESHOLDS_SOURCE}: plugin_validation_thresholds() not found`);
  }
  return {
    minReports: Number(match[1]),
    minSuccessRate: Number(match[2]),
    windowDays: Number(match[3]),
  };
}

export function percent(rate: number): string {
  return `${Math.round(rate * 100)} %`;
}

/** "at least 200 reports and a success rate of at least 90 %, over the last 90 days" */
export function thresholdsSentence(t: ValidationThresholds): string {
  return `at least ${t.minReports} reports and a success rate of at least ${percent(t.minSuccessRate)}, over the last ${t.windowDays} days`;
}

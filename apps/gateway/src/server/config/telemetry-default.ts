/**
 * The single default URL the code base is allowed to contain (spec §4.3,
 * §9; plan §3.9). Overridable with `telemetry.collector_url`, irrelevant
 * while `telemetry.enabled` is false (the default).
 *
 * PROVISIONAL: the collector does not exist yet. The final host is fixed by
 * the ADR `telemetry-collector-shape` (P2.5); change it there and here only.
 * The structural test `no-hardcoded-config.test.ts` whitelists this file.
 */
export const DEFAULT_TELEMETRY_COLLECTOR_URL = 'https://telemetry.vaubaan.com/v1/reports';

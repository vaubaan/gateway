/**
 * The single default URL the code base is allowed to contain (spec §4.3,
 * §9; plan §3.9). Overridable with `telemetry.collector_url`, irrelevant
 * while `telemetry.enabled` is false (the default).
 *
 * PLACEHOLDER: the project's collector is not published yet, and no collector
 * answers at this host. The telemetry client compares the URL in use with
 * this constant and refuses to send while they are equal, even when telemetry
 * is enabled (ADR `telemetry-collector-shape` D4; handbook telemetry).
 * Publishing the collector is a change of this one line in a release.
 * The structural test `no-hardcoded-config.test.ts` whitelists this file.
 */
export const DEFAULT_TELEMETRY_COLLECTOR_URL = 'https://telemetry.vaubaan.com/v1/reports';

/**
 * The single default URL the code base is allowed to contain (spec §4.3,
 * §9; plan §3.9). Overridable with `telemetry.collector_url`, irrelevant
 * while `telemetry.enabled` is false (the default).
 *
 * The project's published collector (a Vercel function of the website,
 * ADR `telemetry-two-levels-behind-a-vercel-collector`). An instance whose
 * administrator turns telemetry on sends its reports here unless the
 * configuration names another collector (ADR `telemetry-two-levels-behind-a-vercel-collector`,
 * amendment of 2026-10-23; handbook telemetry).
 * The structural test `no-hardcoded-config.test.ts` whitelists this file.
 */
export const DEFAULT_TELEMETRY_COLLECTOR_URL = 'https://telemetry.vaubaan.com/v1/reports';

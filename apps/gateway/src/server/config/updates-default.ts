/**
 * The default of `updates.feed_url` (spec §4.3; ADR
 * plugins-bundled-or-pinned-by-the-operator): the versions feed the project's
 * website publishes — the released gateway version, each plugin's released
 * version and the advisories. The instance reads it with a GET that carries
 * nothing about it (`server/updates`); `updates.check: false` turns it off.
 * The structural test `no-hardcoded-config.test.ts` whitelists this file.
 */
export const DEFAULT_UPDATES_FEED_URL = 'https://vaubaan.com/versions.json';

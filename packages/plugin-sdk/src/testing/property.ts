/**
 * Parameters of the property-based (fuzz) tests of the parsers that read
 * untrusted input — the SQL and shell readers of the plugins, the git and
 * MCP doors' headers, the configuration loader. Pass them to fast-check's
 * `fc.assert(property, propertyRuns())`.
 *
 * Seeded, so CI is deterministic and fast: the same seed every run, a few
 * hundred cases per property. A failure prints its seed and its shrunk
 * counter-example path; replay it, or explore further, with
 *
 *   FC_SEED=<seed> FC_RUNS=<n> npx vitest run <file>
 *
 * This file imports nothing from fast-check, so the test kit adds no
 * dependency to a plugin that does not use it.
 */

/** The seed of every property run unless `FC_SEED` names another one. */
export const PROPERTY_SEED = 20261014;
/** Cases per property unless `FC_RUNS` says otherwise; enough to be useful, small enough for CI. */
export const PROPERTY_RUNS = 300;

function integerFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an integer, got "${raw}"`);
  return value;
}

/** `{ seed, numRuns }` for `fc.assert`, from `FC_SEED` / `FC_RUNS` or the defaults. */
export function propertyRuns(): { readonly seed: number; readonly numRuns: number } {
  return {
    seed: integerFromEnv('FC_SEED', PROPERTY_SEED),
    numRuns: integerFromEnv('FC_RUNS', PROPERTY_RUNS),
  };
}

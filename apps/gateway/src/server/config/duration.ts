/**
 * Durations in configuration are short human strings: `30s`, `10m`, `24h`, `7d`.
 * Returns seconds, or `null` when the string is not a duration.
 */
const DURATION = /^(\d+)(s|m|h|d)$/;
const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3_600, d: 86_400 };

export function parseDuration(value: string): number | null {
  const match = DURATION.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = UNIT_SECONDS[match[2] ?? ''];
  if (!Number.isSafeInteger(amount) || amount <= 0 || unit === undefined) return null;
  // `300000000000d` is digits and a unit, but not a number of seconds this
  // process can count exactly (found by the property tests of the loader).
  const seconds = amount * unit;
  return Number.isSafeInteger(seconds) ? seconds : null;
}

/**
 * Reading a posted form, the same way on every handler that takes one.
 */

/** Splits the textarea/env style input: whitespace, comma or newline separated. */
export function splitList(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

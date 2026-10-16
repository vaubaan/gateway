/**
 * The one reader of untyped JSON in the `notion` plugin : what Notion answers
 * and what an agent forwards are both read through `isObject`.
 */

/** A JSON object, read-only. */
export type Json = Readonly<Record<string, unknown>>;

/** True for a plain JSON object (not `null`, not an array). */
export function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

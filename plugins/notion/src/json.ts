/**
 * The shapes of untyped JSON the `notion` plugin reads : what Notion answers
 * and what an agent forwards, through the SDK's `isRecord` / `isList`.
 */

import { isList, isRecord } from '@vaubaan/plugin-sdk';

/** A JSON object, read-only. */
export type Json = Readonly<Record<string, unknown>>;

/** A list Notion answers (`{ object: 'list', results, has_more, next_cursor }`). */
export interface ResultList extends Json {
  readonly results: readonly unknown[];
}

export function isResultList(value: unknown): value is ResultList {
  return isRecord(value) && isList(value.results);
}

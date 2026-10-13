/**
 * Slice segments a classifier can emit safely.
 *
 * Spec : docs/spec/gateway-risk-model.md §3 (the slice grammar).
 *
 * A classifier builds its slices structurally (`{ kind: 'ident', value }`),
 * so nothing stops it from putting into an identifier a character the slice
 * grammar has no place for : `@` in an e-mail address, `:` in a secret name,
 * `+`, a space. The decision would still be right — catalog patterns match
 * any identifier in those positions — but the slice is also *written* : in
 * the audit entry, in the refusal the agent reads, in the session. Written
 * with such a character it cannot be read back (`parseSlice` refuses it), and
 * a `,` or a `]` would even read back as a different slice.
 *
 * So what is emitted is what the grammar can carry : the identifier itself
 * when it is made of grammar characters, the "any identifier" placeholder
 * otherwise. Only audit precision is lost, and only for those values.
 */

import { BRACKET_IDENT_CHAR_CLASS, parseSlice, serializeSlice } from '@vaubaan/policy-engine';
import type { Slice, SliceSegment } from '@vaubaan/shared';

const SLICE_IDENT = new RegExp(`^${BRACKET_IDENT_CHAR_CLASS}+$`);

/** The "any identifier" placeholder of an executed slice : serialised `[*]`. */
export const ANY_IDENT: SliceSegment = { kind: 'ident', value: '*' };

/** True when the slice grammar can carry `value` as one bracket identifier. */
export function isSliceIdent(value: string): boolean {
  return SLICE_IDENT.test(value);
}

/**
 * The identifier segment of `value` : `[value]` when the grammar can carry
 * it, `[*]` otherwise (an empty value, a character outside the grammar, a
 * glob). Never throws.
 */
export function identSegment(value: string): SliceSegment {
  return isSliceIdent(value) ? { kind: 'ident', value } : ANY_IDENT;
}

/**
 * Why a slice a classifier emitted cannot be written and read back as itself ;
 * empty when it can. Checked by the plugin kit on every sample
 * (`assertCatalogCoverage`).
 */
export function sliceRoundTripIssues(slice: Slice): string[] {
  let text: string;
  try {
    text = serializeSlice(slice);
  } catch (error) {
    return [`cannot be serialised (${error instanceof Error ? error.message : String(error)})`];
  }
  let back: Slice;
  try {
    back = parseSlice(text);
  } catch {
    return [
      `'${text}' cannot be read back: an identifier holds a character outside the slice grammar`,
    ];
  }
  const again = serializeSlice(back);
  return again === text ? [] : [`'${text}' reads back as '${again}'`];
}

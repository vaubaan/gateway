/**
 * The identifier grammars of the `miro` provider : one function per kind,
 * shared by `classify`, `execute` and discovery. Each returns the value or
 * `null` ; a value outside its grammar is refused, never repaired.
 *
 * Handbook : docs/handbook/providers/miro.md §5.1, §5.2, "Identifiers".
 * ADR      : docs/decisions/plugin-identifiers-one-grammar-for-classify-and-execute.md ;
 *            docs/decisions/miro-board-ref-tilde-spelling.md.
 */

/**
 * A Miro board id as Miro writes it (`uXjVOD6LSME=`) : letters, digits, `_`,
 * `-`, then at most two `=` at the end. No `~`, so the ref spelling below is
 * one to one. Lands in a URL path, percent-encoded.
 */
export const MIRO_BOARD_ID = /^[A-Za-z0-9_-]{1,62}={0,2}$/;

/**
 * A board ref : the Miro id with each trailing `=` written `~`
 * (`uXjVOD6LSME~`). Carried as is by a slice identifier, never sent.
 */
export const BOARD_REF = /^[A-Za-z0-9_-]{1,62}~{0,2}$/;

/** An item, frame, connector, tag or team id : a numeric string (path segment, slice identifier). */
export const MIRO_ITEM_ID = /^[0-9]{1,24}$/;

/** A page cursor Miro answered : opaque, query string only. */
export const MIRO_CURSOR = /^[A-Za-z0-9+/=_~.-]{1,512}$/;

/** The Miro id as a ref, or `null` when it is outside the Miro board grammar. */
export function boardRefOf(miroId: unknown): string | null {
  if (typeof miroId !== 'string' || !MIRO_BOARD_ID.test(miroId)) return null;
  return miroId.replace(/=/g, '~');
}

/** The Miro id of a ref, or `null` when it is outside the ref grammar. */
export function miroIdOf(ref: unknown): string | null {
  if (typeof ref !== 'string' || !BOARD_REF.test(ref)) return null;
  return ref.replace(/~/g, '=');
}

/** A board ref, or `null`. */
export function boardRef(value: unknown): string | null {
  return typeof value === 'string' && BOARD_REF.test(value) ? value : null;
}

/** An item-like id (item, frame, connector, tag, team), or `null`. A JSON number is refused. */
export function itemId(value: unknown): string | null {
  return typeof value === 'string' && MIRO_ITEM_ID.test(value) ? value : null;
}

/** A page cursor, or `null`. */
export function cursorOf(value: unknown): string | null {
  return typeof value === 'string' && MIRO_CURSOR.test(value) ? value : null;
}

/**
 * The identifier grammars of the `miro` provider : one function per kind,
 * shared by `classify`, `execute` and discovery. Each returns the value or
 * `null` ; a value outside its grammar is refused, never repaired.
 *
 * Handbook : docs/handbook/providers/miro.md §5.1, "Identifiers".
 * ADR      : docs/decisions/plugin-identifiers-one-grammar-for-classify-and-execute.md ;
 *            docs/decisions/miro-board-ref-tilde-spelling.md.
 */

import { MIRO_BOARD_URL_BASE } from './identity.ts';

/**
 * A Miro board id as Miro writes it (`uXjVOD6LSME=`) : letters, digits, `_`,
 * `-`, then at most two `=` at the end. No `~`, so the ref spelling below is
 * one to one.
 */
export const MIRO_BOARD_ID = /^[A-Za-z0-9_-]{1,62}={0,2}$/;

/**
 * A board ref : the Miro id with each trailing `=` written `~`
 * (`uXjVOD6LSME~`). Carried as is by a slice identifier, never sent.
 */
export const BOARD_REF = /^[A-Za-z0-9_-]{1,62}~{0,2}$/;

/** An item id : a numeric string (`3458764517517819000`). */
export const MIRO_ITEM_ID = /^[0-9]{1,24}$/;

/**
 * A comment id. ⚠ Miro does not document its shape for the MCP tools ; the
 * grammar admits what an id can be without admitting a path, a glob or a
 * space.
 */
export const MIRO_COMMENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The path of a board URL : `/app/board/<id>/`, the trailing slash optional,
 * nothing after it. The query (`moveToWidget`…) and the fragment are not
 * read : an item is named by `item_id`.
 */
const BOARD_URL_PATH = /^\/app\/board\/([A-Za-z0-9_-]{1,62}={0,2})\/?$/;

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

/**
 * The Miro id of a board URL, or `null` : `https://miro.com/app/board/<id>/`
 * exactly — https, the host `miro.com`, no user, no port, the path of a
 * board. The board id passes its grammar.
 */
export function boardIdOfUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 512) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'miro.com') return null;
  if (url.port !== '' || url.username !== '' || url.password !== '') return null;
  const match = BOARD_URL_PATH.exec(url.pathname);
  return match?.[1] ?? null;
}

/**
 * The board a `board` argument names, as a ref : a ref (`uXjVOD6LSME~`) or a
 * board URL (`https://miro.com/app/board/uXjVOD6LSME=/`). `null` otherwise.
 */
export function boardOf(value: unknown): string | null {
  return boardRef(value) ?? boardRefOf(boardIdOfUrl(value));
}

/** An item id, or `null`. A JSON number is refused (it loses digits past 2^53). */
export function itemId(value: unknown): string | null {
  return typeof value === 'string' && MIRO_ITEM_ID.test(value) ? value : null;
}

/** A comment id, or `null`. */
export function commentId(value: unknown): string | null {
  return typeof value === 'string' && MIRO_COMMENT_ID.test(value) ? value : null;
}

/**
 * The URL the gateway sends to Miro for a board ref, and an item when one is
 * named (`?moveToWidget=<id>`, how Miro's tools scope an operation to one
 * item). Built from values that passed their grammar : nothing the agent
 * wrote reaches it as is.
 */
export function boardUrlOf(ref: string, item: string | null): string {
  const id = miroIdOf(ref);
  if (id === null) throw new Error(`miro: '${ref}' is not a board ref`);
  const base = `${MIRO_BOARD_URL_BASE}${id}/`;
  return item === null ? base : `${base}?moveToWidget=${item}`;
}

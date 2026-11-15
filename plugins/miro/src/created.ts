/**
 * The board a successful `miro__board_create` created, read from Miro's answer
 * (ADR created-resources-join-the-mission).
 *
 * Handbook : docs/handbook/services/miro.md.
 *
 * Observed live on 2026-10-24 through the gateway : one text block whose text
 * is JSON, `{"miro_url":"https://miro.com/app/board/uXjVEVgYKSE=/","name":"…"}`.
 * `structuredContent` is read too, when Miro sends it. The answer is untrusted :
 * the board is read from a board URL through the board-id grammar
 * (`boardIdOfUrl`, `boardRefOf`), as discovery reads it, and described as
 * discovery describes it (`boardsIn`) : ref, name, `metadata.url`.
 */

import { jsonObjectsOf, type McpToolResult, type Resource } from '@vaubaan/plugin-sdk';

import { boardIdOfUrl, boardRefOf } from './identifiers.ts';
import { MIRO_BOARD_URL_BASE, SERVICE_ID, TOOL } from './identity.ts';

/** The keys of an answer that may carry the new board's link. */
const LINK_KEYS = ['miro_url', 'viewLink', 'url', 'boardUrl', 'link'] as const;
/** A link to an item of a board, not to the board itself. */
const ITEM_LINK = /[?&#](moveToWidget|focusWidget)=/;
/** Upper bound of a board name kept from the answer (as discovery keeps it). */
const NAME_MAX_LENGTH = 200;

interface CreatedBoard {
  readonly id: string;
  readonly name: string | null;
}

/**
 * `ServicePlugin.createdResources` : the board `miro__board_create` made, or
 * `[]` when the answer names no board, or names several (a creation makes
 * one ; an answer that names two is not read).
 */
export function createdMiroResources(
  tool: string,
  _args: Readonly<Record<string, unknown>>,
  result: McpToolResult,
): readonly Resource[] {
  if (tool !== TOOL.boardCreate) return [];
  const found = new Map<string, CreatedBoard>();
  for (const answer of jsonObjectsOf(result)) {
    const board = createdBoardOf(answer);
    if (!board) continue;
    const known = found.get(board.id);
    if (!known || (known.name === null && board.name !== null)) found.set(board.id, board);
  }
  if (found.size !== 1) return [];
  const [board] = [...found.values()];
  const ref = board ? boardRefOf(board.id) : null;
  if (!board || ref === null) return [];
  return [
    {
      service: SERVICE_ID,
      ref,
      displayName: board.name ?? board.id,
      metadata: { url: `${MIRO_BOARD_URL_BASE}${board.id}/` },
    },
  ];
}

/** The board one answer object names by its link, with its name ; `null` otherwise. */
function createdBoardOf(answer: Record<string, unknown>): CreatedBoard | null {
  const ids = new Set<string>();
  for (const key of LINK_KEYS) {
    const link = answer[key];
    if (typeof link !== 'string' || ITEM_LINK.test(link)) continue;
    const id = boardIdOfUrl(link.split(/[?#]/)[0]);
    if (id !== null) ids.add(id);
  }
  const [id] = [...ids];
  if (ids.size !== 1 || id === undefined) return null;
  const name = [answer.name, answer.title].find(
    (v): v is string => typeof v === 'string' && v.trim() !== '',
  );
  return { id, name: name?.trim().slice(0, NAME_MAX_LENGTH) ?? null };
}

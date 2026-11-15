/**
 * `createdResources` of the Miro plugin (ADR created-resources-join-the-mission):
 * the board `miro__board_create` made, read from Miro's answer through the
 * board-id grammar, described as discovery describes it.
 */
import { describe, expect, test } from 'vitest';

import { boardsIn, createdMiroResources, miroPlugin, TOOL } from '../../src/index.ts';

/** The answer observed live through the gateway on 2026-10-24. */
const LIVE_ANSWER = {
  content: [
    {
      type: 'text' as const,
      text: '{"miro_url":"https://miro.com/app/board/uXjVEVgYKSE=/","name":"Vaubaan test board (delete me)"}',
    },
  ],
};

describe('miro createdResources', () => {
  test('the live answer of board_create gives the board, as discovery describes it', () => {
    const created = createdMiroResources(TOOL.boardCreate, { name: 'x' }, LIVE_ANSWER);
    expect(created).toEqual([
      {
        service: 'miro',
        ref: 'uXjVEVgYKSE~',
        displayName: 'Vaubaan test board (delete me)',
        metadata: { url: 'https://miro.com/app/board/uXjVEVgYKSE=/' },
      },
    ]);
    // Same ref, same metadata shape as `boardsIn` (discovery) would produce for the link.
    const discovered = boardsIn({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            data: [
              {
                url: 'https://miro.com/app/board/uXjVEVgYKSE=/',
                name: 'Vaubaan test board (delete me)',
              },
            ],
          }),
        },
      ],
    });
    expect(created).toEqual(discovered);
    expect(miroPlugin.createdResources).toBe(createdMiroResources);
  });

  test('structuredContent is read too', () => {
    expect(
      createdMiroResources(
        TOOL.boardCreate,
        {},
        {
          content: [],
          structuredContent: { miro_url: 'https://miro.com/app/board/o9J_kzlUDmo=/', name: 'Plan' },
        },
      ),
    ).toEqual([
      {
        service: 'miro',
        ref: 'o9J_kzlUDmo~',
        displayName: 'Plan',
        metadata: { url: 'https://miro.com/app/board/o9J_kzlUDmo=/' },
      },
    ]);
  });

  test('a board without a name is named by its id', () => {
    const [board] = createdMiroResources(
      TOOL.boardCreate,
      {},
      {
        content: [
          { type: 'text', text: '{"miro_url":"https://miro.com/app/board/uXjVEVgYKSE=/"}' },
        ],
      },
    );
    expect(board?.displayName).toBe('uXjVEVgYKSE=');
  });

  test('an answer it cannot read gives nothing (untrusted: grammar, host, item links, ambiguity)', () => {
    const answer = (text: string) => ({ content: [{ type: 'text' as const, text }] });
    const none = (text: string) => createdMiroResources(TOOL.boardCreate, {}, answer(text));
    expect(none('Board created.')).toEqual([]);
    expect(none('{"name":"no link"}')).toEqual([]);
    expect(none('{"miro_url":"https://evil.example/app/board/uXjVEVgYKSE=/"}')).toEqual([]);
    expect(none('{"miro_url":"http://miro.com/app/board/uXjVEVgYKSE=/"}')).toEqual([]);
    expect(none('{"miro_url":"https://miro.com/app/board/uX..%2F/"}')).toEqual([]);
    expect(
      none(
        '{"miro_url":"https://miro.com/app/board/uXjVEVgYKSE=/?moveToWidget=3458764517517819000"}',
      ),
    ).toEqual([]);
    // Two different boards in one answer: not read.
    expect(
      createdMiroResources(
        TOOL.boardCreate,
        {},
        {
          content: [
            { type: 'text', text: '{"miro_url":"https://miro.com/app/board/uXjVEVgYKSE=/"}' },
            { type: 'text', text: '{"miro_url":"https://miro.com/app/board/o9J_kzlUDmo=/"}' },
          ],
        },
      ),
    ).toEqual([]);
  });

  test('another tool creates nothing the account lists', () => {
    expect(createdMiroResources(TOOL.listBoards, {}, LIVE_ANSWER)).toEqual([]);
  });
});

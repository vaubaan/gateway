/**
 * Identifiers of the `caldav` plugin — what is executed is what was
 * classified (ADR plugin-identifiers-one-grammar-for-classify-and-execute).
 *
 * The SDK kit runs every string argument of every sample through `classify`
 * and `execute` with hostile values ; the table below holds each identifier
 * position by hand, both sides : a value the classifier refuses is declined
 * by the executor with nothing sent.
 */
import { describe, expect, test } from 'vitest';

import { assertIdentifiersRefused, refusalText } from '@vaubaan/plugin-sdk/testing';

import { caldavPlugin, classifyCaldav } from '../../src/index.ts';
import { TOOL } from '../../src/identity.ts';
import { plainServer } from './fake-caldav.ts';
import { execCtx, secret, work } from './fixtures.ts';
import { SAMPLES } from './samples.ts';

const HOSTILE = [
  '..',
  '.',
  'a/../b',
  '../work',
  '%2e%2e',
  '..%2f',
  '%2f',
  'x\r\ny',
  'r1?x=1#y',
  '',
];

describe('identifier positions — hostile values, classify and execute agree', () => {
  const positions: [string, string, Record<string, unknown>][] = [
    [TOOL.getEvent, 'event_id', {}],
    [TOOL.updateEvent, 'event_id', { etag: '"e1"', summary: 'x' }],
    [TOOL.deleteEvent, 'event_id', { etag: '"e1"' }],
    [TOOL.listEvents, 'calendar', { start: '2026-10-26', end: '2026-11-02' }],
    [TOOL.getEvent, 'calendar', { event_id: 'evt-1.ics' }],
    [
      TOOL.createEvent,
      'calendar',
      { summary: 's', start: '2026-10-27T09:00:00Z', end: '2026-10-27T10:00:00Z' },
    ],
  ];

  for (const [tool, argument, rest] of positions) {
    test.each(HOSTILE)(
      `${tool} ${argument} = %j : refused by classify, nothing sent by execute`,
      async (value) => {
        const args = { ...rest, [argument]: value };
        expect('denied' in classifyCaldav(tool, args, [work])).toBe(true);
        const server = plainServer();
        await refusalText(caldavPlugin.execute(execCtx(server), tool, args));
        expect(server.requests).toEqual([]);
      },
    );
  }

  test('an etag with a line break is refused on both sides', async () => {
    const args = { event_id: 'evt-1.ics', etag: '"e1"\r\nX-Injected: 1' };
    expect('denied' in classifyCaldav(TOOL.deleteEvent, args, [work])).toBe(true);
    const server = plainServer();
    await refusalText(caldavPlugin.execute(execCtx(server), TOOL.deleteEvent, args));
    expect(server.requests).toEqual([]);
  });

  test('the SDK proof : every sample, every string argument', async () => {
    const report = await assertIdentifiersRefused(caldavPlugin, SAMPLES, {
      resources: [work],
      context: (fetch, resources) => ({ credential: secret(), fetch, resources }),
    });
    expect(report.pathIdentifiers).toContainEqual({ tool: TOOL.getEvent, argument: 'event_id' });
  });
});

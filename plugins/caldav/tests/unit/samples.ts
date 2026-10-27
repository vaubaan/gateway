/** The samples of every tool : the SDK kit's coverage and identifier proofs run on them. */
import type { ToolSamples } from '@vaubaan/plugin-sdk/testing';

import { TOOL } from '../../src/identity.ts';
import { githubRepo, home, work } from './fixtures.ts';

const RANGE = { start: '2026-10-26', end: '2026-11-02' };
const EVENT = { summary: 'Sync', start: '2026-10-27T09:00:00Z', end: '2026-10-27T10:00:00Z' };
const TARGET = { event_id: 'evt-1.ics', etag: '"e1"' };

/** One sample per branch that matters ; every risk of the catalog is reached. */
export const SAMPLES: ToolSamples = {
  [TOOL.listCalendars]: [{ args: {} }, { args: {}, resources: [githubRepo], expectDenied: true }],
  [TOOL.listEvents]: [
    { args: RANGE },
    { args: { calendar: 'work', start: '2026-10-01', end: '2026-12-01', max_results: 200 } },
    { args: RANGE, resources: [work, home], expectDenied: true },
    { args: { start: '2026-10-01', end: '2027-12-01' }, expectDenied: true },
  ],
  [TOOL.getEvent]: [
    { args: { event_id: 'evt-1.ics' } },
    { args: { event_id: 'abc@google.com.ics' } },
    { args: { event_id: '..' }, expectDenied: true },
  ],
  [TOOL.createEvent]: [
    { args: EVENT },
    { args: { ...EVENT, attendees: ['bob@example.com'] } },
    { args: { ...EVENT, attendees: ['carol@partner.org'] } },
    { args: { ...EVENT, attendees: ['mallory@evil.example'] } },
    { args: { ...EVENT, raw: 'BEGIN:VCALENDAR' }, expectDenied: true },
  ],
  [TOOL.updateEvent]: [
    { args: { ...TARGET, summary: 'x' } },
    {
      args: { ...TARGET, attendees: ['bob@example.com'], removed_attendees: ['carol@partner.org'] },
    },
    { args: { ...TARGET }, expectDenied: true },
  ],
  [TOOL.deleteEvent]: [
    { args: TARGET },
    { args: { ...TARGET, attendees: ['mallory@evil.example'] } },
    { args: { event_id: 'evt-1.ics' }, expectDenied: true },
  ],
};

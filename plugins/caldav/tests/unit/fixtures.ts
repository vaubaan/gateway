/** Resources, credentials and contexts shared by the `caldav` tests. */
import type { ApiKeySecret, AccountContext, ExecuteContext, Resource } from '@vaubaan/plugin-sdk';

import { PASSWORD, USER, type FakeCaldavServer } from './fake-caldav.ts';

export const ORIGIN = 'https://cal.example.com';
export const HOME = `${ORIGIN}/dav/calendars/ada/`;

/** A calendar resource as discovery returns it, zoned by its owner. */
export function calendarResource(ref: string, href = `${HOME}${ref}/`): Resource {
  return {
    service: 'caldav',
    ref,
    displayName: ref,
    metadata: {
      href,
      account_addresses: USER,
      internal_domains: ['example.com'],
      allowlist_domains: ['partner.org'],
      allowlist_addresses: ['bob@vendor.io'],
    },
  };
}

export const work = calendarResource('work');
export const home = calendarResource('home');
export const githubRepo: Resource = {
  service: 'github',
  ref: 'acme/app',
  displayName: 'acme/app',
};

export const secret = (fields: Record<string, string> = {}): ApiKeySecret => ({
  kind: 'api-key',
  fields: { server_url: ORIGIN, username: USER, app_password: PASSWORD, ...fields },
  metadata: {},
});

export const connCtx = (
  server: FakeCaldavServer,
  fields: Record<string, string> = {},
): AccountContext => ({
  credential: secret({
    server_url: server.options.origin,
    username: server.options.username,
    ...fields,
  }),
  fetch: server.asFetch(),
});

export const execCtx = (
  server: FakeCaldavServer,
  resources: readonly Resource[] = [work],
): ExecuteContext => ({
  ...connCtx(server),
  resources,
});

const CRLF = '\r\n';

/** A small event, stored as another client would write it. */
export function eventIcs(
  options: {
    uid?: string;
    start?: string;
    end?: string;
    summary?: string;
    organizer?: string;
    attendees?: readonly string[];
  } = {},
): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Example//Client//EN',
    'BEGIN:VEVENT',
    `UID:${options.uid ?? 'evt-1'}`,
    'DTSTAMP:20261020T080000Z',
    `DTSTART:${options.start ?? '20261027T090000Z'}`,
    `DTEND:${options.end ?? '20261027T100000Z'}`,
    `SUMMARY:${options.summary ?? 'Stand-up'}`,
    ...(options.organizer ? [`ORGANIZER:mailto:${options.organizer}`] : []),
    ...(options.attendees ?? []).map((a) => `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${a}`),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.join(CRLF) + CRLF;
}

/**
 * The `caldav` plugin over a real HTTP socket : the fake server's handler
 * behind `node:http` on 127.0.0.1, and Node's own `fetch` as `ctx.fetch`.
 * What the in-memory tests cannot show : that `PROPFIND` and `REPORT` leave
 * as such, that the `Depth`, `If-Match` and `If-None-Match` headers and the
 * Basic credential reach a server, that a `301` is not followed by `fetch`
 * itself, and that bodies are read back across the wire. One whole cycle,
 * from verify to delete.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, expect, test } from 'vitest';

import type { AccountContext, ExecuteContext, McpToolResult, Resource } from '@vaubaan/plugin-sdk';

import { createCaldavPlugin } from '../../src/index.ts';
import { TOOL } from '../../src/identity.ts';
import { PASSWORD, USER, plainServer, type FakeCaldavServer } from './fake-caldav.ts';

let http: Server;
let fake: FakeCaldavServer;
let origin: string;

beforeAll(async () => {
  http = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
      const answer = fake.handle({
        method: req.method ?? 'GET',
        url: `${origin}${req.url ?? '/'}`,
        headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(answer.status, answer.headers);
      res.end(answer.body);
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  fake = plainServer(origin);
});

afterAll(async () => {
  await new Promise<void>((resolve) => http.close(() => resolve()));
});

const plugin = createCaldavPlugin({ uuid: () => 'aaaaaaaa-1111-4222-8333-444444444444' });

const ctx = (): AccountContext => ({
  credential: {
    kind: 'api-key',
    fields: { server_url: origin, username: USER, app_password: PASSWORD },
    metadata: {},
  },
  fetch: (input, init) => fetch(input, init),
});

const zoned = (r: Resource): Resource => ({
  ...r,
  metadata: { ...r.metadata, internal_domains: ['example.com'] },
});

const out = (result: McpToolResult): Record<string, unknown> => {
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return result.structuredContent as Record<string, unknown>;
};

test('verify, discover, create, list, read, change and delete over HTTP', async () => {
  const spec = plugin.credential;
  if (spec.kind !== 'api-key' || !spec.verify) throw new Error('no verify');
  await expect(spec.verify(ctx())).resolves.toEqual({ account: USER, expiresAt: null });
  // The .well-known 301 was answered to the plugin, not followed by fetch.
  expect(fake.requests.slice(0, 2).map((r) => r.url)).toEqual([
    `${origin}/.well-known/caldav`,
    `${origin}/dav/`,
  ]);

  const resources = await plugin.discoverResources(ctx());
  const work = zoned(resources.find((r) => r.ref === 'work')!);
  const exec: ExecuteContext = { ...ctx(), resources: [work] };

  const created = out(
    await plugin.execute(exec, TOOL.createEvent, {
      summary: 'Design review, part 2',
      start: '2026-10-28T10:00:00',
      end: '2026-10-28T11:00:00',
      timezone: 'Europe/Paris',
      description: `Agenda\n${'long line '.repeat(30)}`,
      attendees: ['Bob <bob@example.com>'],
    }),
  );
  expect(created.event_id).toBe('aaaaaaaa-1111-4222-8333-444444444444.ics');
  const put = fake.requests[fake.requests.length - 1]!;
  expect(put).toMatchObject({ method: 'PUT' });
  expect(put.headers['if-none-match']).toBe('*');
  expect(put.body).toMatch(/\r\n /); // folded on the wire

  const listed = out(
    await plugin.execute(exec, TOOL.listEvents, { start: '2026-10-27', end: '2026-11-03' }),
  );
  const report = fake.requests[fake.requests.length - 1]!;
  expect([report.method, report.headers.depth]).toEqual(['REPORT', '1']);
  const [event] = listed.events as Record<string, unknown>[];
  expect(event).toMatchObject({
    event_id: created.event_id,
    summary: 'Design review, part 2',
    start: '2026-10-28T10:00:00',
    timezone: 'Europe/Paris',
    attendees: [{ address: 'bob@example.com', name: 'Bob', status: 'NEEDS-ACTION' }],
  });

  const read = out(await plugin.execute(exec, TOOL.getEvent, { event_id: created.event_id }));
  expect(read.description).toContain('Agenda\nlong line');

  const changed = out(
    await plugin.execute(exec, TOOL.updateEvent, {
      event_id: created.event_id,
      etag: read.etag,
      location: 'Room 4',
      attendees: ['bob@example.com'],
    }),
  );
  expect(fake.requests[fake.requests.length - 1]!.headers['if-match']).toBe(read.etag);

  // The old etag no longer opens the event.
  const stale = await plugin.execute(exec, TOOL.deleteEvent, {
    event_id: created.event_id,
    etag: read.etag,
    attendees: ['bob@example.com'],
  });
  expect(stale.isError).toBe(true);

  out(
    await plugin.execute(exec, TOOL.deleteEvent, {
      event_id: created.event_id,
      etag: changed.etag,
      attendees: ['bob@example.com'],
    }),
  );
  expect(fake.calendar('/dav/calendars/ada/work/')!.objects.size).toBe(0);
  expect(fake.requests.every((r) => r.headers.authorization?.startsWith('Basic '))).toBe(true);
});

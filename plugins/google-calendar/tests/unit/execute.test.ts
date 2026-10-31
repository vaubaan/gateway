/**
 * Execution and discovery of `google-calendar` against a mock of Google's
 * Calendar MCP server: what leaves (the Bearer, the tool, the arguments the
 * reader returned, `calendarId` written as the id), what comes back, the
 * gateway's own `list_calendars`, and the calendars discovery keeps.
 */
import { describe, expect, test } from 'vitest';

import { CredentialRefusal, UpstreamAuthError, UpstreamProtocolError } from '@vaubaan/plugin-sdk';
import { mockFetch } from '@vaubaan/plugin-sdk/testing';

import {
  calendarsIn,
  discoverGoogleCalendarResources,
  executeGoogleCalendar,
  resourcesOf,
} from '../../src/execute.ts';
import { CALENDAR_MCP_URL, PROVIDER_ID, SCOPES, TOOL } from '../../src/identity.ts';
import { EVENT, TEAM, TEAM_ID, TOKEN, context, mcpRoute, rpcOf, textResult } from './fixtures.ts';

describe('execute', () => {
  test('one tools/call with the brokered token, the reader’s arguments and the calendar id', async () => {
    const fetch = mockFetch([mcpRoute(() => textResult('{"items":[]}'))]);
    const result = await executeGoogleCalendar(context(fetch), TOOL.updateEvent, {
      eventId: EVENT,
      calendarId: TEAM,
      addedAttendees: [{ email: 'Bob@Acme.Example' }],
      notificationLevel: 'NONE',
    });
    expect(result).toEqual({ content: [{ type: 'text', text: '{"items":[]}' }] });
    const [call] = fetch.calls;
    expect(call?.url).toBe(CALENDAR_MCP_URL);
    expect(call?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(rpcOf(call!)).toMatchObject({
      method: 'tools/call',
      params: {
        name: 'update_event',
        arguments: {
          eventId: EVENT,
          calendarId: TEAM_ID,
          addedAttendees: [{ email: 'bob@acme.example' }],
          notificationLevel: 'NONE',
        },
      },
    });
  });

  test('list_calendars is answered by the gateway, without a request', async () => {
    const fetch = mockFetch([]);
    const result = await executeGoogleCalendar(context(fetch), TOOL.listCalendars, {});
    expect(fetch.calls).toHaveLength(0);
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(JSON.parse(text)).toEqual({
      calendars: [
        {
          calendar: 'alice~acme.example',
          id: 'alice@acme.example',
          name: 'Alice',
          primary: true,
          accessRole: 'owner',
        },
        { calendar: TEAM, id: TEAM_ID, name: 'Team', primary: false, accessRole: 'writer' },
      ],
    });
  });

  test('a refused call sends nothing; Google’s isError is passed through; 401 is an auth error', async () => {
    const none = mockFetch([]);
    const refused = await executeGoogleCalendar(context(none), TOOL.getEvent, { eventId: '../x' });
    expect(refused.isError).toBe(true);
    expect(none.calls).toHaveLength(0);

    const failing = mockFetch([mcpRoute(() => ({ ...textResult('Not found'), isError: true }))]);
    expect(
      (await executeGoogleCalendar(context(failing), TOOL.getEvent, { eventId: EVENT })).isError,
    ).toBe(true);

    const denied = mockFetch([{ method: 'POST', url: CALENDAR_MCP_URL, status: 401, body: {} }]);
    await expect(
      executeGoogleCalendar(context(denied), TOOL.getEvent, { eventId: EVENT }),
    ).rejects.toBeInstanceOf(UpstreamAuthError);
  });

  test('a JSON-RPC error frame is a protocol failure, with Google’s text for the agent', async () => {
    const frame = mockFetch([
      {
        method: 'POST',
        url: CALENDAR_MCP_URL,
        respond: (call) => ({
          jsonrpc: '2.0',
          id: rpcOf(call).id ?? null,
          error: { code: -32602, message: 'Invalid params: eventId' },
        }),
      },
    ]);
    const failure = executeGoogleCalendar(context(frame), TOOL.getEvent, { eventId: EVENT });
    await expect(failure).rejects.toBeInstanceOf(UpstreamProtocolError);
    await expect(failure).rejects.toThrow(/Invalid params: eventId/);
  });

  test('a server that wants a session: initialize once, then the call again with its session id', async () => {
    const fetch = mockFetch([
      {
        method: 'POST',
        url: CALENDAR_MCP_URL,
        status: 400,
        body: { error: 'no session' },
        times: 1,
      },
      {
        method: 'POST',
        url: CALENDAR_MCP_URL,
        times: 1,
        headers: { 'mcp-session-id': 'session-1' },
        respond: (call) => ({
          jsonrpc: '2.0',
          id: rpcOf(call).id,
          result: { protocolVersion: '2025-06-18' },
        }),
      },
      { method: 'POST', url: CALENDAR_MCP_URL, status: 202, body: '', times: 1 },
      mcpRoute(() => textResult('ok')),
    ]);
    const result = await executeGoogleCalendar(context(fetch), TOOL.getEvent, { eventId: EVENT });
    expect(result).toEqual(textResult('ok'));
    expect(fetch.calls.map((c) => rpcOf(c).method)).toEqual([
      'tools/call',
      'initialize',
      'notifications/initialized',
      'tools/call',
    ]);
    expect(fetch.calls[3]?.headers['mcp-session-id']).toBe('session-1');
  });
});

describe('discovery', () => {
  const page = (items: unknown[], next?: string) =>
    textResult(JSON.stringify({ items, ...(next ? { nextPageToken: next } : {}) }));

  test('reads the calendars page by page, leaves Google’s subscribed calendars out, seeds the zoning', async () => {
    const fetch = mockFetch([
      mcpRoute((call) => {
        const rpc = rpcOf(call);
        if (rpc.method === 'tools/list') return { tools: [] };
        return rpc.params?.arguments?.pageToken
          ? page([{ id: TEAM_ID, summary: 'Team', accessRole: 'writer' }])
          : page(
              [
                { id: 'alice@acme.example', summary: 'Alice', primary: true, accessRole: 'owner' },
                { id: 'en.french#holiday@group.v.calendar.google.com', summary: 'Holidays' },
              ],
              'p2',
            );
      }),
    ]);
    const resources = await discoverGoogleCalendarResources(context(fetch));
    expect(resources).toEqual([
      {
        provider: PROVIDER_ID,
        ref: 'alice~acme.example',
        displayName: 'Alice',
        metadata: {
          primary: true,
          access_role: 'owner',
          account_email: 'alice@acme.example',
          internal_domains: ['acme.example'],
        },
      },
      {
        provider: PROVIDER_ID,
        ref: TEAM,
        displayName: 'Team',
        metadata: {
          primary: false,
          access_role: 'writer',
          account_email: 'alice@acme.example',
          internal_domains: ['acme.example'],
        },
      },
    ]);
  });

  test('a consumer account is not its own company: no internal domain is seeded', () => {
    const [cal] = resourcesOf([
      { id: 'alice@gmail.com', name: 'Alice', primary: true, accessRole: 'owner' },
    ]);
    expect(cal?.metadata?.internal_domains).toEqual([]);
  });

  test('reads nothing but calendar objects of the grammar', () => {
    expect(
      calendarsIn({
        content: [
          { type: 'text', text: 'see https://calendar.google.com alice@acme.example' },
          { type: 'text', text: JSON.stringify({ items: [{ id: 'x' }, { id: 'a@b.example' }] }) },
        ],
      }),
    ).toEqual([]);
  });

  test('Google refusing list_calendars at discovery is its failure, typed: a protocol error', async () => {
    const fetch = mockFetch([
      mcpRoute((call) =>
        rpcOf(call).method === 'tools/list'
          ? { tools: [] }
          : { ...textResult('rate limited'), isError: true },
      ),
    ]);
    const discovery = discoverGoogleCalendarResources(context(fetch));
    await expect(discovery).rejects.toBeInstanceOf(UpstreamProtocolError);
    await expect(discovery).rejects.toThrow(
      'Google Calendar MCP server, tool list_calendars failed',
    );
  });

  test('a 403 of Google at discovery is a refusal the person can read', async () => {
    const fetch = mockFetch([{ method: 'POST', url: CALENDAR_MCP_URL, status: 403, body: {} }]);
    await expect(discoverGoogleCalendarResources(context(fetch))).rejects.toBeInstanceOf(
      CredentialRefusal,
    );
  });

  test('a token Google granted fewer scopes than asked is refused before any request', async () => {
    const fetch = mockFetch([]);
    const granted = [SCOPES.eventsRead, SCOPES.freeBusy, SCOPES.events];
    const refusal = discoverGoogleCalendarResources(context(fetch, [], granted));
    await expect(refusal).rejects.toBeInstanceOf(CredentialRefusal);
    await expect(refusal).rejects.toThrow(/missing: see the list of calendars\)/);
    expect(fetch.calls).toHaveLength(0);
  });
});

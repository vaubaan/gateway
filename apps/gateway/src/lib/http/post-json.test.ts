import { describe, expect, it } from 'vitest';

import { postJson, UNREACHABLE } from './post-json';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('postJson', () => {
  it('posts JSON and hands back the answer', async () => {
    const sent: RequestInit[] = [];
    const answer = await postJson('/api/x', { a: 1 }, async (_url, init) => {
      sent.push(init ?? {});
      return json(201, { id: 'm1' });
    });
    expect(answer).toEqual({ ok: true, status: 201, body: { id: 'm1' } });
    expect(sent[0]).toMatchObject({ method: 'POST', body: '{"a":1}' });
    expect(sent[0]?.headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('sends no body when there is no payload', async () => {
    const sent: RequestInit[] = [];
    await postJson('/api/x', undefined, async (_url, init) => {
      sent.push(init ?? {});
      return new Response(null, { status: 204 });
    });
    expect(sent[0]).toEqual({ method: 'POST' });
  });

  it('a refusal says what the gateway stated, else its status', async () => {
    expect(
      await postJson('/api/x', {}, async () => json(409, { error: 'x', message: 'Already done.' })),
    ).toMatchObject({ ok: false, status: 409, message: 'Already done.' });
    expect(
      await postJson('/api/x', {}, async () => new Response('oops', { status: 502 })),
    ).toMatchObject({ ok: false, status: 502, body: null, message: 'The gateway answered 502.' });
  });

  it('a request that never reached the gateway is status 0, in one wording', async () => {
    const answer = await postJson('/api/x', {}, async () => {
      throw new TypeError('fetch failed');
    });
    expect(answer).toEqual({ ok: false, status: 0, body: null, message: UNREACHABLE });
  });
});

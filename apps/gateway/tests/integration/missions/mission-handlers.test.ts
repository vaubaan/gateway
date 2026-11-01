/**
 * The Missions HTTP surface over the real root: session, origin check,
 * reveal-once response, structured refusals.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SESSION_COOKIE } from '../../../src/server/auth';
import type { GatewayRoot } from '../../../src/server/compose/root';
import type { BootstrapKit, MissionDraft, MissionPreview } from '../../../src/server/missions';
import {
  buildTestRoot,
  PUBLIC_URL,
  seedInstance,
  sessionHeaders,
  type SeededInstance,
} from './support';

interface IssuedBody {
  mission: { id: string; name: string };
  token: { secret: string; prefix: string };
  kit: BootstrapKit;
}

describe('missions: HTTP handlers', () => {
  let root: GatewayRoot;
  let seeded: SeededInstance;

  beforeEach(async () => {
    root = await buildTestRoot();
    seeded = await seedInstance(root);
  });
  afterEach(async () => {
    await root.close();
  });

  function draft(overrides: Partial<MissionDraft> = {}): MissionDraft {
    return {
      name: 'Ship the billing page',
      connections: [
        {
          connection_id: seeded.github.connection.id,
          trust_levels: { read: 'trusting', propose: 'trusting' },
        },
      ],
      period: { kind: 'recurring', length_seconds: 86_400 },
      expires_at: null,
      ...overrides,
    };
  }

  function post(path: string, headers: Headers, body?: unknown): Request {
    return new Request(`${PUBLIC_URL}${path}`, {
      method: 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function issue(): Promise<IssuedBody> {
    const res = await root.missions.handlers.issue(
      post('/api/missions', await sessionHeaders(root, seeded.ada), draft()),
    );
    expect(res.status).toBe(201);
    return (await res.json()) as IssuedBody;
  }

  it('issues: 201 with the secret once, the kit, and no-store', async () => {
    const res = await root.missions.handlers.issue(
      post('/api/missions', await sessionHeaders(root, seeded.ada), draft()),
    );
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as IssuedBody;
    expect(body.token.secret).toMatch(/^vbn_live_/);
    expect(body.kit.env).toContain(body.token.secret);
    expect(body.kit.mcp_json).toContain(`${PUBLIC_URL}/mcp`);
    expect(body.kit.mcp_json).toContain('${VAUBAAN_MISSION_TOKEN}');
    expect((await root.missions.service.verifyToken(body.token.secret)).outcome).toBe('verified');
    // The secret is not recoverable afterwards.
    const detail = await root.missions.service.get(seeded.ada, body.mission.id);
    expect(JSON.stringify(detail)).not.toContain(body.token.secret);
  });

  it('refuses a cross-origin mutation before reading the session', async () => {
    const headers = await sessionHeaders(root, seeded.ada, { origin: 'https://evil.example' });
    for (const res of [
      await root.missions.handlers.issue(post('/api/missions', headers, draft())),
      await root.missions.handlers.preview(post('/api/missions/preview', headers, draft())),
      await root.missions.handlers.rotate(post('/api/missions/x/rotate', headers), 'x'),
      await root.missions.handlers.revoke(post('/api/missions/x/revoke', headers), 'x'),
    ]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: 'origin-mismatch' });
    }
    expect(await root.store.missions.listForCreator(seeded.ada.id)).toEqual([]);
  });

  it('needs a user session: nobody is 401, the bootstrap operator is 403', async () => {
    const anonymous = new Headers({ origin: PUBLIC_URL, 'content-type': 'application/json' });
    const res = await root.missions.handlers.issue(post('/api/missions', anonymous, draft()));
    expect(res.status).toBe(401);

    const bootstrap = await root.auth.sessions.create({ kind: 'bootstrap' });
    const asBootstrap = new Headers({
      origin: PUBLIC_URL,
      cookie: `${SESSION_COOKIE}=${bootstrap.id}`,
      'content-type': 'application/json',
    });
    const refused = await root.missions.handlers.issue(post('/api/missions', asBootstrap, draft()));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: 'forbidden' });
  });

  it('answers 400 to a body that is not a draft, naming the fields', async () => {
    const headers = await sessionHeaders(root, seeded.ada);
    const notJson = await root.missions.handlers.issue(
      new Request(`${PUBLIC_URL}/api/missions`, { method: 'POST', headers, body: '{nope' }),
    );
    expect(notJson.status).toBe(400);
    const malformed = await root.missions.handlers.issue(
      post('/api/missions', headers, { ...draft(), accepted_risks: ['*'] }),
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: 'invalid-draft' });
  });

  it('answers 422 with the preview when the draft exceeds the authority', async () => {
    const res = await root.missions.handlers.issue(
      post('/api/missions', await sessionHeaders(root, seeded.bob), draft()),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; preview: MissionPreview };
    expect(body.error).toBe('refused');
    expect(body.preview.ok).toBe(false);
    expect(body.preview.issues[0]?.code).toBe('connection-unknown');
  });

  it('previews without writing: what passes, the summary, the resolved draft', async () => {
    const res = await root.missions.handlers.preview(
      post(
        '/api/missions/preview',
        await sessionHeaders(root, seeded.ada),
        // An agent's proposal names the provider and the refs, not the ids.
        draft({
          connections: [
            {
              provider: 'github',
              // Trust levels beside a policy decide nothing: they only redraw the form.
              trust_levels: { read: 'trusting', propose: 'trusting' },
              resources: { scope: 'selected', resource_refs: ['acme/app'] },
              policy: [
                {
                  risk_id: 'github.read-code',
                  quota: 100,
                  rate_limit: { max: 10, window_seconds: 60 },
                },
                {
                  risk_id: 'github.merge-protected',
                  quota: 2,
                  rate_limit: { max: 1, window_seconds: 60 },
                  gate: 'approval',
                },
              ],
            },
          ],
        }),
      ),
    );
    expect(res.status).toBe(200);
    const { preview } = (await res.json()) as { preview: MissionPreview };
    expect(preview.ok).toBe(true);
    expect(preview.resolved[0]?.connection_id).toBe(seeded.github.connection.id);
    expect(preview.resolved[0]?.resources).toMatchObject({ scope: 'selected' });
    expect(preview.resolved[0]?.resources).toHaveProperty('resource_ids', [expect.any(String)]);
    expect(preview.resolved[0]?.trust_levels).toEqual({ read: 'trusting', propose: 'trusting' });
    expect(preview.policy.map((e) => [e.risk_id, e.gate])).toEqual([
      ['github.read-code', 'auto'],
      ['github.merge-protected', 'approval'],
    ]);
    expect(preview.summary.can).toContain('GitHub "acme-org": 2 risks on 1 of 3 resources');
    expect(await root.store.missions.listForCreator(seeded.ada.id)).toEqual([]);
  });

  it('rotates: 200 with a new secret, 404 for someone else, 409 once revoked', async () => {
    const issued = await issue();
    const path = `/api/missions/${issued.mission.id}/rotate`;
    const foreign = await root.missions.handlers.rotate(
      post(path, await sessionHeaders(root, seeded.bob)),
      issued.mission.id,
    );
    expect(foreign.status).toBe(404);

    const rotated = await root.missions.handlers.rotate(
      post(path, await sessionHeaders(root, seeded.ada)),
      issued.mission.id,
    );
    expect(rotated.status).toBe(200);
    expect(rotated.headers.get('cache-control')).toBe('no-store');
    const body = (await rotated.json()) as IssuedBody;
    expect(body.token.secret).not.toBe(issued.token.secret);
    expect(body.kit.env).toContain(body.token.secret);
    expect((await root.missions.service.verifyToken(issued.token.secret)).outcome).toBe('retired');

    const revoked = await root.missions.handlers.revoke(
      post(`/api/missions/${issued.mission.id}/revoke`, await sessionHeaders(root, seeded.ada)),
      issued.mission.id,
    );
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ mission: { id: issued.mission.id, status: 'revoked' } });

    const tooLate = await root.missions.handlers.rotate(
      post(path, await sessionHeaders(root, seeded.ada)),
      issued.mission.id,
    );
    expect(tooLate.status).toBe(409);
    expect(await tooLate.json()).toMatchObject({ error: 'mission-inactive' });
  });

  it('revokes: 404 for a mission that is not the caller’s', async () => {
    const issued = await issue();
    const res = await root.missions.handlers.revoke(
      post(`/api/missions/${issued.mission.id}/revoke`, await sessionHeaders(root, seeded.bob)),
      issued.mission.id,
    );
    expect(res.status).toBe(404);
    expect((await root.missions.service.verifyToken(issued.token.secret)).outcome).toBe('verified');
  });
});

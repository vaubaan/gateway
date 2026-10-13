import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { REFUSAL_CODES } from '@vaubaan/shared';
import { describe, expect, it } from 'vitest';

import {
  buildBootstrapKit,
  MISSION_TOKEN_ENV,
  REFUSAL_GUIDANCE,
  type BootstrapKitInput,
} from './bootstrap-kit';

const SECRET = 'vbn_live_AbCd1234_0123456789abcdefghijABCDEFGHIJ01';

const INPUT: BootstrapKitInput = {
  instanceUrl: 'https://gateway.acme.example',
  mission: {
    name: 'Ship the billing page',
    period: { kind: 'recurring', length_seconds: 86_400 },
    expires_at: null,
  },
  connections: [
    {
      provider_label: 'GitHub',
      display_name: 'acme-org',
      resources: [
        { ref: 'acme/app', env: 'prod' },
        { ref: 'acme/web', env: null },
      ],
    },
    { provider_label: 'Gmail', display_name: 'ops mailbox', resources: [] },
  ],
  policy: [
    {
      risk_id: 'github.code-read',
      label: 'Read code',
      quota: 5000,
      rate_limit: { max: 120, window_seconds: 60 },
      gate: 'auto',
    },
    {
      risk_id: 'github.merge-protected',
      label: 'Merge into a protected branch',
      quota: 3,
      rate_limit: { max: 1, window_seconds: 60 },
      gate: 'approval',
    },
  ],
  token: { secret: SECRET },
};

describe('buildBootstrapKit', () => {
  const kit = buildBootstrapKit(INPUT);

  it('1 — puts the secret in the env var snippet, and only there', () => {
    expect(kit.env).toBe(`export ${MISSION_TOKEN_ENV}='${SECRET}'`);
    expect(kit.reveals_secret).toBe(true);
    expect(kit.mcp_json).not.toContain(SECRET);
    expect(kit.agent_instructions).not.toContain(SECRET);
    expect(kit.verify).not.toContain(SECRET);
  });

  it('2 — writes an MCP configuration with the instance URL and the variable by reference', () => {
    expect(JSON.parse(kit.mcp_json)).toEqual({
      mcpServers: {
        vaubaan: {
          type: 'http',
          url: 'https://gateway.acme.example/mcp',
          headers: { Authorization: 'Bearer ${VAUBAAN_MISSION_TOKEN}' },
        },
      },
    });
  });

  it('3 — tells the agent its connections, resource refs, accepted risks and budget', () => {
    const text = kit.agent_instructions;
    expect(text).toContain('## Vaubaan mission "Ship the billing page"');
    expect(text).toContain('- GitHub "acme-org" — `acme/app` (prod), `acme/web`');
    expect(text).toContain('- Gmail "ops mailbox" — no resource (account-level tools only)');
    expect(text).toContain(
      '- `github.code-read` — Read code: 5000 per day, at most 120 per 60s, auto',
    );
    expect(text).toContain(
      '- `github.merge-protected` — Merge into a protected branch: 3 per day, at most 1 per 60s, each action needs approval',
    );
    expect(text).toContain('quotas reload every day; the mission never expires');
    expect(text).toContain('the budget below is shared, it is not multiplied');
    // Both carriers of the agent label the execution door reads.
    expect(text).toContain('`X-Vaubaan-Agent: <label>`');
    expect(text).toContain('`_meta.agent`');
  });

  it('3 — says what to do on each structured refusal, and never to work around one', () => {
    for (const code of REFUSAL_CODES) {
      expect(kit.agent_instructions).toContain(`- \`${code}\` — ${REFUSAL_GUIDANCE[code]}`);
    }
    expect(REFUSAL_GUIDANCE['budget-exhausted']).toContain('hand `claim_url` to the human');
    expect(REFUSAL_GUIDANCE['approval-required']).toContain('Hand `approval_url` to the human');
    expect(kit.agent_instructions).toContain('Never work around a refusal');
    expect(kit.agent_instructions).toContain('give that URL to the human as is');
  });

  it('ends with a curl tools/list check that reads the variable', () => {
    expect(kit.verify).toContain("curl -sS 'https://gateway.acme.example/mcp'");
    expect(kit.verify).toContain('-H "Authorization: Bearer $VAUBAAN_MISSION_TOKEN"');
    expect(kit.verify).toContain('"method":"tools/list"');
  });

  it('shows the masked prefix on a revisited page', () => {
    const revisited = buildBootstrapKit({ ...INPUT, token: { prefix: 'AbCd1234' } });
    expect(revisited.env).toBe(`export ${MISSION_TOKEN_ENV}='vbn_live_AbCd1234_…'`);
    expect(revisited.reveals_secret).toBe(false);
  });

  it('keeps a sub-path of the public URL and drops a trailing slash', () => {
    const kitAtPath = buildBootstrapKit({
      ...INPUT,
      instanceUrl: 'https://tools.acme.example/gw/',
    });
    expect(kitAtPath.endpoint).toBe('https://tools.acme.example/gw/mcp');
  });
});

describe('/agent-bootstrap.md', () => {
  const page = readFileSync(
    fileURLToPath(new URL('../../app/agent-bootstrap.md/content.md', import.meta.url)),
    'utf8',
  );

  it('documents every structured refusal and the rule never to work around one', () => {
    for (const code of REFUSAL_CODES) expect(page).toContain(`\`${code}\``);
    expect(page).toContain('Never work around a refusal');
    expect(page).toContain('`claim_url`');
    expect(page).toContain('`approval_url`');
  });

  it('refers to the token by its variable and names no instance', () => {
    expect(page).toContain(`Bearer \${${MISSION_TOKEN_ENV}}`);
    expect(page).not.toMatch(/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}/);
    expect(page).not.toMatch(/vbn_live_[A-Za-z0-9]{8}_/);
  });
});

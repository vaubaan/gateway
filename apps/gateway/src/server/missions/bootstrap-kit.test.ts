import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { AUTH_FAILURE_REASONS } from '@vaubaan/gateway-core';
import { REFUSAL_CODES } from '@vaubaan/shared';
import { describe, expect, it } from 'vitest';

import {
  AGENT_LABEL_MAX_LENGTH,
  AGENT_LABEL_PUNCTUATION,
  buildBootstrapKit,
  MISSION_TOKEN_ENV,
  REFUSAL_GUIDANCE,
  TOKEN_STOPPED_GUIDANCE,
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
    expect(text).toContain(
      '- Gmail "ops mailbox" — no resource (tools of the account itself only)',
    );
    expect(text).toContain(
      '- `github.code-read` — Read code: 5000 per day, at most 120 per 60s, runs freely',
    );
    expect(text).toContain(
      '- `github.merge-protected` — Merge into a protected branch: 3 per day, at most 1 per 60s, asks the mission creator first, each time',
    );
    expect(text).toContain('limits reset every day; the mission never expires');
    expect(text).toContain('the limits below are shared, they are not multiplied');
  });

  it('3 — tells an orchestrator how to hand the mission to sub-agents and how each labels itself', () => {
    const text = kit.agent_instructions;
    expect(text).toContain('### Sub-agents and agent labels');
    // The same configuration and the same token, never one per agent.
    expect(text).toContain('hands its sub-agents this MCP configuration as is');
    // A token belongs to a holder, not to an agent.
    expect(text).toContain('there is no key per agent');
    expect(text).toContain('A key belongs to its holder');
    // Both carriers of the agent label the execution door reads, and which one wins.
    expect(text).toContain('`X-Vaubaan-Agent: <label>`');
    expect(text).toContain('`_meta.agent` wins');
    // The shape the door enforces, from the same constants.
    expect(text).toContain(`1 to ${AGENT_LABEL_MAX_LENGTH} characters`);
    for (const character of AGENT_LABEL_PUNCTUATION) expect(text).toContain(`\`${character}\``);
    expect(text).toContain('the call is served, unlabelled');
    expect(text).toContain('attribution only');
    expect(text).toContain('not an identity');
  });

  it('3 — says what to do on each structured refusal, and never to work around one', () => {
    for (const code of REFUSAL_CODES) {
      expect(kit.agent_instructions).toContain(`- \`${code}\` — ${REFUSAL_GUIDANCE[code]}`);
    }
    expect(REFUSAL_GUIDANCE['budget-exhausted']).toContain('hand `claim_url` to the human');
    expect(REFUSAL_GUIDANCE['approval-required']).toContain('Hand `approval_url` to the human');
    expect(REFUSAL_GUIDANCE['mission-inactive']).toContain(
      'A request opened before the mission lost its owner can be answered only until it expires; after that, your next refused call opens a new one.',
    );
    expect(kit.agent_instructions).toContain('Never work around a refusal');
    expect(kit.agent_instructions).toContain('give that URL to the human as is');
  });

  it('3 — says whose token it is, that the budget is one for every holder, and who answers requests', () => {
    const text = kit.agent_instructions;
    expect(text).toContain('### Whose key this is');
    expect(text).toContain('This key belongs to one holder');
    expect(text).toContain('`GET https://gateway.acme.example/mcp/catalog`');
    expect(text).toContain('`token.holder`');
    expect(text).toContain('`mission.creator`');
    expect(text).toContain('The limits are one for all of them');
    expect(text).toContain('answered by the mission creator alone');
    // Read before the labels: the identity first, the declared refinement second.
    expect(text.indexOf('### Whose token this is')).toBeLessThan(
      text.indexOf('### Sub-agents and agent labels'),
    );
  });

  it('3 — says what to do when the token itself stops working, for every reason the door states', () => {
    const text = kit.agent_instructions;
    expect(text).toContain('### When the key itself stops working');
    expect(text).toContain('`error.data.reason`');
    for (const reason of AUTH_FAILURE_REASONS) {
      expect(text).toContain(`- \`${reason}\` — ${TOKEN_STOPPED_GUIDANCE[reason]}`);
      // Never a way around: each line ends with a human.
      expect(TOKEN_STOPPED_GUIDANCE[reason]).toMatch(/the human/);
    }
    // These are not refusal codes: the table of refusals is still the closed set.
    for (const reason of AUTH_FAILURE_REASONS) {
      expect((REFUSAL_CODES as readonly string[]).includes(reason)).toBe(false);
    }
  });

  it('3 — names the management door, says the mission token does not open it and that it lifts no refusal', () => {
    const text = kit.agent_instructions;
    expect(text).toContain('### The management door');
    expect(text).toContain(`${INPUT.instanceUrl.replace(/\/+$/, '')}/mcp/manage`);
    expect(text).toContain('never by this mission key');
    expect(text).toContain('`wrong-credential-kind`');
    expect(text).toContain('It does not lift a refusal');
    // The section comes last: the refusal guidance is read first.
    expect(text.indexOf('### The management door')).toBeGreaterThan(
      text.indexOf('### When a call is refused'),
    );
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

describe('the git step of the kit', () => {
  const git = {
    base: 'https://gateway.acme.example/git/',
    insteadOf: 'https://github.com/',
    repositories: ['acme/app', 'acme/web'],
  };

  it('is absent without a repository the instance serves', () => {
    expect(buildBootstrapKit(INPUT).git).toBeNull();
    expect(buildBootstrapKit({ ...INPUT, git: { ...git, repositories: [] } }).git).toBeNull();
    expect(buildBootstrapKit(INPUT).agent_instructions).not.toContain('### Git');
  });

  it('reads the key from the variable through a helper, never a URL or a store', () => {
    const kit = buildBootstrapKit({ ...INPUT, git });
    expect(kit.git).toContain(
      `git config --global 'credential.https://gateway.acme.example.helper'`,
    );
    expect(kit.git).toContain('password=$VAUBAAN_MISSION_TOKEN');
    expect(kit.git).not.toContain(SECRET);
    expect(kit.git).not.toMatch(/helper (store|cache)|@gateway/);
    expect(kit.git).toContain(
      `git config --global 'url.https://gateway.acme.example/git/.insteadOf' 'https://github.com/'`,
    );
    expect(kit.git).toContain(`git clone 'https://gateway.acme.example/git/acme/app.git'`);
    expect(kit.git).toContain(`git clone 'https://gateway.acme.example/git/acme/web.git'`);
  });

  it('offers no rewrite when the plugin names no provider prefix', () => {
    const kit = buildBootstrapKit({ ...INPUT, git: { ...git, insteadOf: null } });
    expect(kit.git).not.toContain('insteadOf');
  });

  it('tells the agent how git is decided and what to do with a refusal', () => {
    const text = buildBootstrapKit({ ...INPUT, git }).agent_instructions;
    expect(text).toContain('### Git');
    expect(text).toContain('`https://gateway.acme.example/git/acme/app.git`');
    expect(text).toContain('every ref of it');
    expect(text).toContain('push exactly the same commits again');
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

  it('describes the management door: OAuth, its tools, what it never does', () => {
    expect(page).toContain('## 7. The management door');
    expect(page).toContain('`<instance URL>/mcp/manage`');
    for (const tool of [
      'list_my_connections',
      'get_catalog',
      'list_my_missions',
      'preview_policy',
      'issue_mission',
      'rotate_mission_token',
      'revoke_mission',
    ]) {
      expect(page).toContain(`\`${tool}\``);
    }
    expect(page).toContain('never by a mission key');
    expect(page).toContain('**never** answer a request');
  });

  it('explains sub-agents and the agent label as the door applies them', () => {
    expect(page).toContain('same endpoint, same\n`VAUBAAN_MISSION_TOKEN`');
    expect(page).toContain('"X-Vaubaan-Agent": "sub-agent-2"');
    expect(page).toContain('`_meta.agent` wins');
    expect(page).toContain(`1 to ${AGENT_LABEL_MAX_LENGTH} characters`);
    for (const character of AGENT_LABEL_PUNCTUATION) expect(page).toContain(`\`${character}\``);
    expect(page).toContain('attribution only');
    expect(page).toContain('reserves no share of the limits');
  });

  it('says that a key has one holder, that the limits are one set, and what a stopped key means', () => {
    expect(page).toContain('exactly one **holder**');
    expect(page).toContain('## 4. One set of limits, however many agents or keys');
    expect(page).toContain('`token.holder`');
    expect(page).toContain('`mission.creator`');
    for (const reason of AUTH_FAILURE_REASONS) expect(page).toContain(`\`${reason}\``);
    expect(page).toContain('Never look for another key to continue.');
  });

  it('documents the git remote: the helper, every ref decided, the replay, what is refused', () => {
    expect(page).toContain('## 8. Git');
    expect(page).toContain('git_remote');
    expect(page).toContain('every ref of it');
    expect(page).toContain('exactly the same commits');
    expect(page).toContain('Git LFS');
  });

  it('refers to the key by its variable and names no instance', () => {
    expect(page).toContain(`Bearer \${${MISSION_TOKEN_ENV}}`);
    expect(page).not.toMatch(/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}/);
    expect(page).not.toMatch(/vbn_live_[A-Za-z0-9]{8}_/);
  });
});

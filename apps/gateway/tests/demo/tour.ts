/**
 * The tour printed when the demo starts: where it is, who can sign in, and a
 * numbered list of things to try. The same list, without the per-run values
 * (port, tokens, request URLs), is the body of handbook demo-mode.
 */
import { DEMO_PEOPLE } from './people';
import { SMALL_QUOTA, type SeedSummary } from './seed';

export const DEMO_BANNER =
  'DEMO — simulated identity provider and providers, no data leaves this machine';

export interface TourInput {
  readonly origin: string;
  readonly port: number;
  /** Name of this machine, for the `ssh -L` line. */
  readonly host: string;
  readonly seeded: SeedSummary;
  readonly directory: string;
  readonly kept: boolean;
}

const MCP_HEADERS = `-H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream'`;

function frame(text: string): string {
  const bar = '='.repeat(text.length + 4);
  return `${bar}\n= ${text} =\n${bar}`;
}

/** The kit's verification command, on the seeded active mission. */
export function toolsListCommand(origin: string): string {
  return [
    `curl -sS ${origin}/mcp \\`,
    `       -H "Authorization: Bearer $VAUBAAN_MISSION_TOKEN" \\`,
    `       ${MCP_HEADERS} \\`,
    `       -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
  ].join('\n');
}

function readCall(seeded: SeedSummary, id: string): string {
  const { owner, repo } = seeded.repository;
  return `{"jsonrpc":"2.0","id":${id},"method":"tools/call","params":{"name":"github__get_file_contents","arguments":{"owner":"${owner}","repo":"${repo}","path":"README.md"}}}`;
}

/** `SMALL_QUOTA` reads pass, the next one is refused `budget-exhausted` with a `claim_url`. */
export function quotaLoopCommand(origin: string, seeded: SeedSummary): string {
  const attempts = Array.from({ length: SMALL_QUOTA + 1 }, (_, i) => i + 1).join(' ');
  return [
    `for i in ${attempts}; do`,
    `       curl -sS ${origin}/mcp -H "Authorization: Bearer $VAUBAAN_QUOTA_TOKEN" \\`,
    `         ${MCP_HEADERS} -H 'X-Vaubaan-Agent: tour' \\`,
    `         -d '${readCall(seeded, "'$i'")}'; echo`,
    `     done`,
  ].join('\n');
}

/** The gated call of the seeded approval request, replayed with exactly the same arguments. */
export function approvalReplayCommand(origin: string, seeded: SeedSummary): string {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: seeded.approval.tool, arguments: seeded.approval.arguments },
  });
  return [
    `curl -sS ${origin}/mcp -H "Authorization: Bearer $VAUBAAN_APPROVAL_TOKEN" \\`,
    `       ${MCP_HEADERS} -H 'X-Vaubaan-Agent: release-bot' \\`,
    `       -d '${body}'`,
  ].join('\n');
}

export function tourText(input: TourInput): string {
  const { origin, port, seeded } = input;
  const accounts = DEMO_PEOPLE.map(
    (person) => `  ${person.name.padEnd(6)} ${person.tagline}\n         sees ${person.sees}`,
  ).join('\n');
  return `
${frame(DEMO_BANNER)}

Open        ${origin}
            Chrome and Firefox accept the session cookie (marked Secure) on
            http://localhost. Safari does not: use Chrome or Firefox.
From another machine, forward the port and open the same URL there:
            ssh -L ${port}:localhost:${port} ${input.host}
The listener is bound to 127.0.0.1: nothing else on the network reaches it.

Accounts (no password: pick one on the sign-in page; "Sign out" to switch)
${accounts}

Tokens of three seeded missions of Alice, for the commands below:
  export VAUBAAN_MISSION_TOKEN='${seeded.activeMission.token}'
  export VAUBAAN_QUOTA_TOKEN='${seeded.quotaMission.token}'
  export VAUBAAN_APPROVAL_TOKEN='${seeded.approval.mission.token}'

Things to try
  1. Sign in as Alice. Missions lists ${seeded.counts.missions} missions in every state: active,
     quota spent, waiting for an approval, expired, revoked, issued by an agent.
  2. Connect a provider: Connections -> Connect a provider.
       Stripe      test key  sk_test_demo        live key  sk_live_demo
       Cloudflare  API token demo-cloudflare-token-0123456789
       Resend      API key   re_demo_key
       Upstash     email     any address         API key   demo-key
       GitHub      opens a simulated installation page: pick an organisation.
     Any value of the right shape is accepted. Vercel has no simulation:
     connecting it fails with a message that says so, and nothing is sent.
  3. Read what a provider is: Providers -> GitHub. What the plugin connects to,
     its data model, each risk with the reason it is a risk and its six badges,
     each preset with everything it contains, the tools.
  4. Issue a mission on one screen: Missions -> New mission. Include a
     connection and pick a preset: the block says what it allows, what waits
     for your approval and what it leaves out. Switch to Custom to accept risks
     one by one, each with its quota, rate limit and gate; then Issue.
  5. Open the bootstrap kit shown right after issuing: the token (shown once),
     the MCP client configuration, the instructions for the agent, a curl.
  6. Call tools/list on /mcp with a mission token (the kit's own command; here
     with the seeded mission "${seeded.activeMission.name}"):
     ${toolsListCommand(origin)}
  7. Exhaust a quota. The mission "${seeded.quotaMission.name}" allows ${SMALL_QUOTA} file reads:
     ${quotaLoopCommand(origin, seeded)}
     The last answer is a refusal "budget-exhausted" carrying a claim_url. Open
     it as Alice (or Requests), grant a reset or an extension, run the loop again.
     An older claim is already waiting: ${seeded.openClaimUrl}
  8. Approve the pending action: Requests shows a merge of pull request #128
     with its arguments (${seeded.openApprovalUrl}).
     Approve it, then replay the call with exactly the same arguments:
     ${approvalReplayCommand(origin, seeded)}
  9. Share to Bob: Connections -> "${seeded.sharedConnection.name}" -> Share. Bob already
     holds a share of it; sign out, sign in as Bob: Shares received, and his mission.
 10. As Alice, revoke that share; as Bob, his mission now reads "orphaned" and
     every call with its token is refused. Share again as Alice: the same
     mission comes back, same token, same counters.
 11. Audit: every call and every administrative act, with filters (mission,
     agent label, decision). On a mission, "Session" shows the calls of the
     current period per agent label ("planner", "coder").
 12. Admin, as Alice (she is the operator): Identity provider, Provider apps
     (the GitHub App), Groups ("GitHub admins", "Contractors"), Connections
     without owner, OAuth clients ("Claude Code (demo)"), Telemetry (off).
 13. Sign in as Carol: she sees the GitHub connection owned by the group
     "GitHub admins", which Alice transferred to it, and her own Stripe account
     (test and live mode as two resources), whose test mode she shares to Alice.

Data        ${input.directory}
            ${input.kept ? 'kept on exit (DEMO_KEEP=1)' : 'deleted on exit (DEMO_KEEP=1 keeps it)'}; gateway.log there is the instance log.
Stop        Ctrl-C
`;
}

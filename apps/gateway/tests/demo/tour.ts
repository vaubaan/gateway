/**
 * The tour printed when the demo starts: where it is, who can sign in, and a
 * numbered list of things to try. The same list, without the per-run values
 * (port, tokens, request URLs), is the body of handbook demo-mode.
 */
import { DEMO_PEOPLE } from './people';
import { SMALL_QUOTA, type SeedSummary } from './seed';

export const DEMO_BANNER =
  'DEMO — simulated identity provider and services, no data leaves this machine';

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

/** `GET /mcp/catalog` with a token: the answer says whose token it is. */
export function whoseTokenCommand(origin: string, variable: string): string {
  return `curl -sS ${origin}/mcp/catalog -H "Authorization: Bearer $${variable}"`;
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

People (no password: pick one on the sign-in page; to switch, open the
side navigation: your name at its foot, then "Sign out")
${accounts}

Keys of three seeded missions of Alice, for the commands below:
  export VAUBAAN_MISSION_TOKEN='${seeded.activeMission.token}'
  export VAUBAAN_QUOTA_TOKEN='${seeded.quotaMission.token}'
  export VAUBAAN_APPROVAL_TOKEN='${seeded.approval.mission.token}'
The machine key "${seeded.team.named.name}" of "${seeded.team.mission.name}" (step 11):
  export VAUBAAN_CI_TOKEN='${seeded.team.named.token}'

Things to try
  1. Sign in as Alice. Missions lists ${seeded.counts.missions} missions in every state: running,
     waiting for you (a limit reached, a yes to give), expired, stopped,
     prepared by an agent.
  2. Connect an account: Accounts -> Connect an account, then pick a service.
       Stripe      test key  sk_test_demo        live key  sk_live_demo
       Cloudflare  API token demo-cloudflare-token-0123456789
       Resend      API key   re_demo_key
       Upstash     email     any address         API key   demo-key
       Vercel      token     demo-vercel-token   team id   team_demo
       GitHub      token     github_pat_11DEMO0000000000000_aaaa… (acme-org)
                             or …_bbbb… (acme-platform); the page lists the
                             permissions a real token would need
     Any value of the right shape is accepted; each field says its shape.
     Gmail needs an OAuth client the demo does not declare: the picker says so.
  3. Read what a service allows: Reference -> GitHub. Its permissions compared
     across its presets ("why?" unfolds the reason and the six words behind a
     severity), its tools, how it is modelled. Supabase adds a filter by part
     (db, storage, auth, functions).
  4. Create a mission on one screen: Missions -> New mission. Include an
     account and pick a preset: it says what it yields here, and the rail says
     what the mission will be able to do. "Edit the permissions one by one"
     opens every permission with its limits and "ask me first". "Create
     mission" lists every permission with its limit before anything exists.
  5. Read what follows the creation: the key (shown once), then the kit — the
     MCP client configuration, the instructions for the agent, a curl.
  6. Call tools/list on /mcp with the key of a mission (the kit's own command; here
     with the seeded mission "${seeded.activeMission.name}"):
     ${toolsListCommand(origin)}
  7. Reach a limit. The mission "${seeded.quotaMission.name}" allows ${SMALL_QUOTA} file reads:
     ${quotaLoopCommand(origin, seeded)}
     The last answer is a refusal "budget-exhausted" carrying a claim_url. Open
     it as Alice (or "Waiting for you"), reset the count or give back some calls, run the loop
     again; or follow "change the limit" to raise it on the mission for good. An older request of the same kind is already waiting: ${seeded.openClaimUrl}
  8. Approve the pending action: "Waiting for you" shows a merge of pull request #128
     with its arguments (${seeded.openApprovalUrl}).
     Approve it, then replay the call with exactly the same arguments:
     ${approvalReplayCommand(origin, seeded)}
  9. Give access to Bob: Accounts -> "${seeded.sharedConnection.name}" -> Give access. Bob
     already holds one ("Who has access"); sign out, sign in as Bob: Accounts ->
     "Shared with you", and his mission.
 10. As Alice, remove that access ("Who has access" -> Remove); as Bob, his
     mission is stopped and every call with its key is refused. Give access
     again as Alice: the dialog names the mission it brings back — same key,
     same limits.
 11. Work on a mission as a team. Alice added Bob as a teammate on
     "${seeded.team.mission.name}" and created the machine key "${seeded.team.named.name}".
     Sign in as Bob: Missions -> "Shared with you" -> that mission. He reads it and
     cannot change it. Behind "···", "Replace my key": the dialog says his current
     key stops at once; his new key is shown once, to him, with the kit; Alice
     never sees it. Copy the export line of the dialog, then ask the gateway
     whose key it is:
     ${whoseTokenCommand(origin, 'VAUBAAN_MISSION_TOKEN')}
     The answer reads "token": { "kind": "member", "holder": "${seeded.team.member.email}" }.
     The machine key answers with its name:
     ${whoseTokenCommand(origin, 'VAUBAAN_CI_TOKEN')}
     Sign in as Alice: "People and keys" lists Bob and "${seeded.team.named.name}" with what
     each key did today; "Everything this mission did" has "Who called", and each
     call of the timeline names its holder. Remove Bob (you type his address):
     his key is refused at once (401, reason "holder-removed"), the others keep
     working.
 12. Activity: every call and every change a person made, with filters (period,
     mission, account, decision, key holder, agent). "detail" on a line shows the
     key, the permissions touched and what is left. On a mission, "Everything this
     mission did" shows the calls of the current period per key holder and per
     agent label ("planner", "coder").
 13. Settings, as Alice (she administers the gateway): Connected apps ("Claude
     Code (demo)"); under Administration, Setup (a checklist of what is left),
     Sign-in, People, Teams ("GitHub admins",
     "Contractors"), Accounts without owner, Telemetry (off), Registered apps.
     Settings also holds the theme (System, Light, Dark) and the interface
     reference (/design).
 14. Sign in as Carol: she sees the GitHub account owned by the team
     "GitHub admins", which Alice transferred to it, and her own Stripe account
     (test and live mode as two resources), on which she gave Alice access to
     the test mode.

Data        ${input.directory}
            ${input.kept ? 'kept on exit (DEMO_KEEP=1)' : 'deleted on exit (DEMO_KEEP=1 keeps it)'}; gateway.log there is the instance log.
Stop        Ctrl-C
`;
}

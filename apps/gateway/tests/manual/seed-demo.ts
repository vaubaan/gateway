/**
 * Manual check of the execution door on a local instance (handbook
 * execution-door, Procedures, "Manual smoke"). Not part of the automated suite.
 *
 * Builds the composition root from the SAME environment the server will start
 * with (`VAUBAAN_*`, including `VAUBAAN_STORE_PATH`), then seeds what an
 * operator and a user would create through the interface:
 *
 *   - a user, as the IdP would announce them;
 *   - a GitHub account owned by that user, with two repositories. Its
 *     credential is a placeholder token: enough to issue a mission and list
 *     tools, not to call GitHub;
 *   - a mission on one repository with the plugin's Read macro-action at
 *     Careful, issued through `MissionService.issue` like the Missions page does.
 *
 * Prints the bootstrap kit (with the token, once) on stdout. Run it before
 * starting the server, from `apps/gateway`:
 *
 *   npx tsx tests/manual/seed-demo.ts
 */
import { buildRoot } from '../../src/server/compose/root';
import { serializeSecret } from '../../src/server/accounts';
import { REPOSITORY_PLUGINS } from '../support/plugins/repository';

async function main(): Promise<void> {
  // The repository's plugins: GitHub included, whatever the image compiles.
  const root = await buildRoot({ logWrite: () => undefined, bundled: REPOSITORY_PLUGINS });
  try {
    const { store } = root;
    const user = await store.users.upsertFromIdp({
      issuer: 'http://idp.test',
      subject: 'idp|demo',
      email: 'demo@example.com',
      displayName: 'Demo user',
    });
    const account = await store.accounts.create({
      service: 'github',
      owner: { kind: 'user', id: user.id },
      displayName: 'acme-org',
      credential: serializeSecret({
        kind: 'api-key',
        fields: { token: `github_pat_11DEMO0000000000000_${'0'.repeat(40)}` },
        metadata: {},
      }),
    });
    await store.accounts.syncDiscoveredResources(account.id, [
      { ref: 'acme/app', displayName: 'acme/app', env: null },
      { ref: 'acme/infra', displayName: 'acme/infra', env: null },
    ]);
    const issued = await root.missions.service.issue(user, {
      name: 'Read the app repository',
      accounts: [
        {
          account_id: account.id,
          resources: { scope: 'selected', resource_refs: ['acme/app'] },
          trust_levels: { read: 'careful' },
        },
      ],
      period: { kind: 'recurring', length_seconds: 86_400 },
      expires_at: null,
    });
    if (!issued.ok) throw new Error(`the mission was refused: ${JSON.stringify(issued)}`);
    const { kit } = issued;
    process.stdout.write(
      [
        `mission ${issued.mission.id} issued for ${user.email}`,
        '',
        '# 1. environment',
        kit.env,
        '',
        '# 2. MCP client configuration',
        kit.mcp_json,
        '',
        '# verify',
        kit.verify,
        '',
      ].join('\n'),
    );
  } finally {
    await root.close();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});

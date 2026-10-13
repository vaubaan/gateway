/**
 * Manual check of the execution door on a local instance (handbook
 * execution-door, "Manual check"). Not part of the automated suite.
 *
 * Builds the composition root from the SAME environment the server will start
 * with (`VAUBAAN_*`, including `VAUBAAN_STORE_PATH`), then seeds what an
 * operator and a user would create through the interface:
 *
 *   - a user, as the IdP would announce them;
 *   - a GitHub connection owned by that user, with two repositories. Its
 *     credential is a placeholder installation id: enough to issue a mission
 *     and list tools, not to call GitHub;
 *   - a mission on one repository with the plugin's `read-only` preset, issued
 *     through `MissionService.issue` like the Missions page does.
 *
 * Prints the bootstrap kit (with the token, once) on stdout. Run it before
 * starting the server, from `apps/gateway`:
 *
 *   npx tsx tests/manual/seed-demo.ts
 */
import { buildRoot } from '../../src/server/compose/root';
import { serializeSecret } from '../../src/server/connections';

async function main(): Promise<void> {
  const root = await buildRoot({ logWrite: () => undefined });
  try {
    const { store } = root;
    const user = await store.users.upsertFromIdp({
      subject: 'idp|demo',
      email: 'demo@example.com',
      displayName: 'Demo user',
    });
    const connection = await store.connections.create({
      provider: 'github',
      owner: { kind: 'user', id: user.id },
      displayName: 'acme-org',
      credential: serializeSecret({ kind: 'app-install', installationId: '1', metadata: {} }),
    });
    await store.connections.replaceResources(connection.id, [
      { ref: 'acme/app', displayName: 'acme/app', env: null },
      { ref: 'acme/infra', displayName: 'acme/infra', env: null },
    ]);
    const issued = await root.missions.service.issue(user, {
      name: 'Read the app repository',
      connections: [
        {
          connection_id: connection.id,
          resources: { scope: 'selected', resource_refs: ['acme/app'] },
          preset: 'read-only',
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

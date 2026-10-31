import { githubPlugin } from '@vaubaan/plugin-github';
import { PluginRegistry } from '@vaubaan/plugin-sdk';
import { describe, expect, it } from 'vitest';

import { missionGitView } from './git-view';

const registry = new PluginRegistry([githubPlugin]);
const publicUrl = new URL('https://gateway.acme.example');
const connections = [{ provider: 'github', resources: [{ ref: 'acme/app' }, { ref: 'acme/app' }] }];

describe('missionGitView', () => {
  it('is absent without a repository of the provider the instance serves', () => {
    expect(
      missionGitView({
        registry,
        publicUrl,
        connections: [{ provider: 'github', resources: [] }],
        policy: [],
      }),
    ).toBeNull();
    expect(
      missionGitView({ registry: new PluginRegistry([]), publicUrl, connections, policy: [] }),
    ).toBeNull();
  });

  it('gives each repository its remote and sorts the abilities by the policy', () => {
    const view = missionGitView({
      registry,
      publicUrl,
      connections,
      policy: [
        { risk_id: 'github.read-code', gate: 'auto' },
        { risk_id: 'github.git-push', gate: 'auto' },
        { risk_id: 'github.feature-branch-write', gate: 'auto' },
        { risk_id: 'github.force-push', gate: 'approval' },
        { risk_id: 'github.workflow-write-via-file', gate: 'approval' },
      ],
    });
    expect(view?.remotes).toEqual(['https://gateway.acme.example/git/acme/app.git']);
    expect(view?.can).toContain('clone and fetch');
    expect(view?.asks).toEqual([
      'force-push (rewrite a branch)',
      'change CI workflows (.github/workflows/)',
    ]);
    expect(view?.cannot).toContain('push and delete tags');
    expect(view?.cannot.some((w) => w.startsWith('push to main'))).toBe(true);
    expect(view?.provider).toBe('GitHub');
  });
});

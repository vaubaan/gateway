import { githubPlugin } from '@vaubaan/plugin-github';
import { PluginRegistry } from '@vaubaan/plugin-sdk';
import { describe, expect, it } from 'vitest';

import { missionGitViews } from './git-view';

const registry = new PluginRegistry([githubPlugin]);
const publicUrl = new URL('https://gateway.acme.example');
const accounts = [{ service: 'github', resources: [{ ref: 'acme/app' }, { ref: 'acme/app' }] }];

describe('missionGitViews', () => {
  it('is empty without a repository on a service the instance serves as a git remote', () => {
    expect(
      missionGitViews({
        registry,
        publicUrl,
        accounts: [{ service: 'github', resources: [] }],
        policy: [],
      }),
    ).toEqual([]);
    expect(
      missionGitViews({ registry: new PluginRegistry([]), publicUrl, accounts, policy: [] }),
    ).toEqual([]);
  });

  it('gives each repository its remote and sorts the abilities by the policy', () => {
    const [view, ...others] = missionGitViews({
      registry,
      publicUrl,
      accounts,
      policy: [
        { risk_id: 'github.read-code', gate: 'auto' },
        { risk_id: 'github.git-push', gate: 'auto' },
        { risk_id: 'github.feature-branch-write', gate: 'auto' },
        { risk_id: 'github.force-push', gate: 'approval' },
        { risk_id: 'github.workflow-write-via-file', gate: 'approval' },
      ],
    });
    expect(others).toEqual([]);
    expect(view?.remotes).toEqual(['https://gateway.acme.example/git/github/acme/app.git']);
    expect(view?.can).toContain('clone and fetch');
    expect(view?.asks).toEqual([
      'force-push (rewrite a branch)',
      'change CI workflows (.github/workflows/)',
    ]);
    expect(view?.cannot).toContain('push and delete tags');
    expect(view?.cannot.some((w) => w.startsWith('push to main'))).toBe(true);
    expect(view?.service).toBe('GitHub');
  });
});

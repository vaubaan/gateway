import { describe, expect, it } from 'vitest';

import { gitRemoteBase, gitRemoteUrl, parseGitPath } from './paths';

const at = (path: string) => parseGitPath(new URL(`https://gateway.acme.example${path}`));

describe('parseGitPath', () => {
  it('cuts the provider segment first, then the repository and the endpoint', () => {
    expect(at('/git/github/acme/app.git/info/refs?service=git-receive-pack')).toEqual({
      provider: 'github',
      repositoryPath: 'acme/app',
      endpoint: { kind: 'info-refs', service: 'git-receive-pack' },
    });
    expect(at('/git/github/acme/app/git-upload-pack')).toEqual({
      provider: 'github',
      repositoryPath: 'acme/app',
      endpoint: { kind: 'upload-pack' },
    });
    expect(at('/git/github/acme/app.git/info/lfs/objects/batch')).toMatchObject({
      provider: 'github',
      repositoryPath: 'acme/app',
      endpoint: { kind: 'lfs' },
    });
  });

  it('reads a path without a provider segment as naming the provider by its first segment', () => {
    // A kit issued before the provider segment: `acme` is not a provider, the door answers 404.
    expect(at('/git/acme/app.git/info/refs?service=git-upload-pack')).toMatchObject({
      provider: 'acme',
      repositoryPath: 'app',
    });
    expect(at('/git/')).toMatchObject({ provider: '', repositoryPath: '' });
    expect(at('/git/github')).toMatchObject({ provider: 'github', repositoryPath: '' });
    expect(at('/mcp')).toBeNull();
  });
});

describe('the remote URLs', () => {
  it('name the provider under the door, with or without a sub-path of the public URL', () => {
    expect(gitRemoteBase(new URL('https://gateway.acme.example/'), 'github')).toBe(
      'https://gateway.acme.example/git/github/',
    );
    expect(gitRemoteUrl(new URL('https://tools.acme.example/gw/'), 'github', 'acme/app')).toBe(
      'https://tools.acme.example/gw/git/github/acme/app.git',
    );
  });
});

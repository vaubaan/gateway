/**
 * GitHub's REST API as the git remote reads it (`git-rest.ts`) : each read
 * through the SDK's transport, an absent object as `null`, a field of
 * another type as "not said", every other failure typed. No test reaches
 * GitHub.
 */
import { describe, expect, test } from 'vitest';

import { UpstreamAuthError, UpstreamHttpError, UpstreamProtocolError } from '@vaubaan/plugin-sdk';
import { mockFetch, type MockRoute } from '@vaubaan/plugin-sdk/testing';

import { GithubRest } from '../../src/git-rest.ts';
import { executeCtx } from './fixtures.ts';

const API = 'https://api.github.com/repos/acme/app';
const SHA = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const target = { owner: 'acme', repo: 'app', ref: 'acme/app' };

const restOver = (...routes: MockRoute[]) => new GithubRest(executeCtx(mockFetch(routes)), target);

describe('GithubRest — absent objects', () => {
  test.each([404, 409])('a ref GitHub answers %i for does not exist', async (status) => {
    const rest = restOver({ method: 'GET', url: `${API}/git/ref/heads/main`, status, body: {} });
    expect(await rest.refValue('refs/heads/main')).toBeNull();
  });

  test('an object GitHub holds neither as a commit nor as a tag is null', async () => {
    const rest = restOver(
      { method: 'GET', url: `${API}/git/commits/${SHA}`, status: 404, body: {} },
      { method: 'GET', url: `${API}/git/tags/${SHA}`, status: 422, body: {} },
    );
    expect(await rest.gitObject(SHA)).toBeNull();
  });

  test('a comparison without common history is a refusal, not a failure', async () => {
    const rest = restOver({ method: 'GET', url: `${API}/compare/main...${SHA}`, status: 404 });
    expect(await rest.compare('main', SHA, 'the push')).toMatchObject({ ok: false });
  });
});

describe('GithubRest — answers read field by field', () => {
  test('a commit, its tree and parents', async () => {
    const rest = restOver({
      method: 'GET',
      url: `${API}/git/commits/${SHA}`,
      body: { sha: SHA, tree: { sha: TREE }, parents: [{ sha: TREE }, { sha: 7 }, 'x'] },
    });
    expect(await rest.gitObject(SHA)).toEqual({ kind: 'commit', tree: TREE, parents: [TREE] });
  });

  test('a ref whose value is not a string is not said', async () => {
    const rest = restOver({
      method: 'GET',
      url: `${API}/git/ref/heads/main`,
      body: { ref: 'refs/heads/main', object: { sha: 42 } },
    });
    expect(await rest.refValue('refs/heads/main')).toBeNull();
  });

  test('a tree with an entry of another shape is not read', async () => {
    const rest = restOver({
      method: 'GET',
      url: `${API}/git/trees/${TREE}`,
      body: { sha: TREE, tree: [{ path: 'a', mode: '100644', sha: SHA }, { path: 'b' }] },
    });
    expect(await rest.gitTree(TREE)).toBeNull();
  });
});

describe('GithubRest — failures', () => {
  test.each([401, 403])('%i on a read is UpstreamAuthError', async (status) => {
    const rest = restOver({ method: 'GET', url: API, status, body: { message: 'no' } });
    await expect(rest.defaultBranch()).rejects.toBeInstanceOf(UpstreamAuthError);
  });

  test('another failed status is UpstreamHttpError with that status', async () => {
    const rest = restOver({ method: 'GET', url: API, status: 503, body: 'down' });
    await expect(rest.defaultBranch()).rejects.toMatchObject({
      name: 'UpstreamHttpError',
      status: 503,
    });
    await expect(
      restOver({ method: 'GET', url: API, status: 500 }).defaultBranch(),
    ).rejects.toBeInstanceOf(UpstreamHttpError);
  });

  test('an answer that is not JSON, or not of the expected kind, is UpstreamProtocolError', async () => {
    await expect(
      restOver({ method: 'GET', url: API, body: '<html>' }).defaultBranch(),
    ).rejects.toBeInstanceOf(UpstreamProtocolError);
    await expect(
      restOver({ method: 'GET', url: /\/commits\?sha=/, body: { sha: SHA } }).ancestors(SHA, 1),
    ).rejects.toBeInstanceOf(UpstreamProtocolError);
  });
});

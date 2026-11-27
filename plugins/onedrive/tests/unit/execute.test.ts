/**
 * What `onedrive` sends to Microsoft Graph and what it answers, against
 * `mockFetch`. No network.
 */
import { describe, expect, test } from 'vitest';

import { mockFetch } from '@vaubaan/plugin-sdk/testing';

import { GRAPH_API_BASE, SERVICE_ID, TOOL } from '../../src/identity.ts';
import { discoverOneDriveResources, executeOneDrive } from '../../src/index.ts';
import { DOWNLOAD, FILE_ID, TOKEN, alice, context, requestOf } from './fixtures.ts';

const text = (result: { content: readonly unknown[] }): string =>
  (result.content[0] as { text: string }).text;

describe('list and search', () => {
  test("the top folder lists its children, with the bearer; the next page is Graph's own link", async () => {
    const next = `${GRAPH_API_BASE}/me/drive/root/children?$skiptoken=abc`;
    const fetch = mockFetch([
      {
        method: 'GET',
        url: /\/me\/drive\/root\/children\?/,
        body: { value: [{ id: 'a' }], '@odata.nextLink': next },
        times: 2,
      },
    ]);
    const result = await executeOneDrive(context(fetch), TOOL.listFolder, {});
    expect(JSON.parse(text(result))).toEqual({ items: [{ id: 'a' }], nextPageToken: next });
    const { path, query } = requestOf(fetch.calls[0]!);
    expect(path).toBe('/v1.0/me/drive/root/children');
    expect(query.$top).toBe('50');
    expect(fetch.calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    await executeOneDrive(context(fetch), TOOL.listFolder, { pageToken: next });
    expect(fetch.calls[1]!.url).toBe(next);
  });

  test('a folder by its id; a search is an OData literal in the path', async () => {
    const fetch = mockFetch([
      { method: 'GET', url: /graph\.microsoft\.com/, body: { value: [] }, times: 2 },
    ]);
    await executeOneDrive(context(fetch), TOOL.listFolder, { folderId: FILE_ID, pageSize: 10 });
    expect(requestOf(fetch.calls[0]!).path).toBe(`/v1.0/me/drive/items/${FILE_ID}/children`);
    await executeOneDrive(context(fetch), TOOL.searchFiles, { query: "l'été" });
    expect(requestOf(fetch.calls[1]!).path).toBe("/v1.0/me/drive/root/search(q='l''été')");
  });
});

describe('read a file', () => {
  test('a text file is read from its download address, without the access token', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: `${GRAPH_API_BASE}/me/drive/items/${FILE_ID}`,
        body: {
          id: FILE_ID,
          name: 'notes.txt',
          size: 5,
          file: { mimeType: 'text/plain' },
          '@microsoft.graph.downloadUrl': DOWNLOAD,
        },
      },
      { method: 'GET', url: DOWNLOAD, body: 'hello' },
    ]);
    const result = await executeOneDrive(context(fetch), TOOL.readFile, { fileId: FILE_ID });
    expect(JSON.parse(text(result))).toMatchObject({ name: 'notes.txt', content: 'hello' });
    expect(fetch.calls[1]!.headers.authorization).toBeUndefined();
  });

  test('an Office file, a folder, a file too large and a download elsewhere are refused', async () => {
    for (const meta of [
      {
        file: {
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        },
      },
      { folder: { childCount: 2 } },
      { file: { mimeType: 'text/plain' }, size: 2_000_000 },
    ]) {
      const fetch = mockFetch([
        { method: 'GET', url: /\/items\//, body: { id: FILE_ID, name: 'x', ...meta } },
      ]);
      const result = await executeOneDrive(context(fetch), TOOL.readFile, { fileId: FILE_ID });
      expect(result.isError).toBe(true);
      expect(fetch.calls).toHaveLength(1);
    }
    const elsewhere = mockFetch([
      {
        method: 'GET',
        url: /\/items\//,
        body: {
          id: FILE_ID,
          name: 'x',
          file: { mimeType: 'text/plain' },
          '@microsoft.graph.downloadUrl': 'https://evil.example/x',
        },
      },
    ]);
    await expect(
      executeOneDrive(context(elsewhere), TOOL.readFile, { fileId: FILE_ID }),
    ).rejects.toMatchObject({ name: 'UpstreamProtocolError' });
    expect(elsewhere.calls).toHaveLength(1);
  });
});

describe('write', () => {
  test('an upload is one PUT of the text under its name in its folder; a same name is renamed', async () => {
    const fetch = mockFetch([
      { method: 'PUT', url: /:\/content\?/, body: { id: 'new' }, times: 2 },
    ]);
    await executeOneDrive(context(fetch), TOOL.uploadFile, {
      name: 'Rapport Q3.md',
      content: '# Q3\n',
      mimeType: 'text/markdown',
    });
    const call = fetch.calls[0]!;
    expect(requestOf(call).path).toBe('/v1.0/me/drive/root:/Rapport Q3.md:/content');
    expect(requestOf(call).query['@microsoft.graph.conflictBehavior']).toBe('rename');
    expect(call.headers['content-type']).toBe('text/markdown; charset=utf-8');
    expect(call.body).toBe('# Q3\n');
    await executeOneDrive(context(fetch), TOOL.uploadFile, {
      name: 'a.txt',
      content: 'x',
      folderId: FILE_ID,
    });
    expect(requestOf(fetch.calls[1]!).path).toBe(`/v1.0/me/drive/items/${FILE_ID}:/a.txt:/content`);
  });

  test('a folder is created in its parent, renamed on a conflict', async () => {
    const fetch = mockFetch([{ method: 'POST', url: /\/children$/, body: { id: 'f' } }]);
    await executeOneDrive(context(fetch), TOOL.createFolder, { name: 'Reports' });
    expect(requestOf(fetch.calls[0]!).path).toBe('/v1.0/me/drive/root/children');
    expect(fetch.calls[0]!.json).toEqual({
      name: 'Reports',
      folder: {},
      '@microsoft.graph.conflictBehavior': 'rename',
    });
  });
});

describe('credential and failures', () => {
  test('a token without Files.ReadWrite is refused before any request', async () => {
    const fetch = mockFetch([]);
    await expect(
      executeOneDrive(context(fetch, [alice], ['openid', 'User.Read']), TOOL.listFolder, {}),
    ).rejects.toMatchObject({ name: 'CredentialRefusal' });
    expect(fetch.calls).toHaveLength(0);
  });

  test('a rejected token is an UpstreamAuthError', async () => {
    const fetch = mockFetch([{ url: /children/, status: 401 }]);
    await expect(executeOneDrive(context(fetch), TOOL.listFolder, {})).rejects.toMatchObject({
      name: 'UpstreamAuthError',
    });
  });

  test('discovery names the drive by the account address', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: /\/me\?/,
        body: { displayName: 'Alice', mail: null, userPrincipalName: 'Alice@Contoso.example' },
      },
    ]);
    expect(await discoverOneDriveResources(context(fetch))).toEqual([
      {
        service: SERVICE_ID,
        ref: 'alice~contoso.example',
        displayName: 'Alice <alice@contoso.example>',
        metadata: { account_email: 'alice@contoso.example' },
      },
    ]);
  });
});

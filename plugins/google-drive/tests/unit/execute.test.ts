/**
 * What `google-drive` sends to Drive and what it answers, against
 * `mockFetch`. No network.
 */
import { describe, expect, test } from 'vitest';

import { mockFetch } from '@vaubaan/plugin-sdk/testing';

import { DRIVE_API_BASE, DRIVE_UPLOAD_BASE, SERVICE_ID, TOOL } from '../../src/identity.ts';
import { discoverGoogleDriveResources, executeGoogleDrive, queryLiteral } from '../../src/index.ts';
import { DOC_ID, TOKEN, alice, context, requestOf } from './fixtures.ts';

const text = (result: { content: readonly unknown[] }): string =>
  (result.content[0] as { text: string }).text;

describe('list and search', () => {
  test('a folder lists its children not in the trash, folders first, with the bearer', async () => {
    const fetch = mockFetch([{ method: 'GET', url: /\/files\?/, body: { files: [{ id: 'a' }] } }]);
    const result = await executeGoogleDrive(context(fetch), TOOL.listFolder, {});
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(text(result))).toEqual({ files: [{ id: 'a' }] });
    const { path, query } = requestOf(fetch.calls[0]!);
    expect(path).toBe('/drive/v3/files');
    expect(query.q).toBe("'root' in parents and trashed = false");
    expect(query.orderBy).toBe('folder,name');
    expect(query.pageSize).toBe('50');
    expect(fetch.calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  test('a search looks in names and contents; quotes and backslashes are escaped', async () => {
    const fetch = mockFetch([{ method: 'GET', url: /\/files\?/, body: { files: [] } }]);
    await executeGoogleDrive(context(fetch), TOOL.searchFiles, {
      query: "l'été \\ x",
      pageSize: 10,
      pageToken: 'tok',
    });
    const { query } = requestOf(fetch.calls[0]!);
    const literal = "'l\\'été \\\\ x'";
    expect(queryLiteral("l'été \\ x")).toBe(literal);
    expect(query.q).toBe(
      `(name contains ${literal} or fullText contains ${literal}) and trashed = false`,
    );
    expect(query.pageSize).toBe('10');
    expect(query.pageToken).toBe('tok');
  });
});

describe('read a file', () => {
  test('a Google Doc is exported as Markdown', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: `${DRIVE_API_BASE}/files/${DOC_ID}?fields=id%2Cname%2CmimeType%2Csize%2CmodifiedTime%2CwebViewLink&supportsAllDrives=true`,
        body: { id: DOC_ID, name: 'Plan', mimeType: 'application/vnd.google-apps.document' },
      },
      { method: 'GET', url: /\/export\?mimeType=text%2Fmarkdown$/, body: '# Plan\n' },
    ]);
    const result = await executeGoogleDrive(context(fetch), TOOL.readFile, { fileId: DOC_ID });
    expect(JSON.parse(text(result))).toMatchObject({
      name: 'Plan',
      exportedAs: 'text/markdown',
      content: '# Plan\n',
    });
  });

  test('a text file is downloaded as it is', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: /fields=/,
        body: { id: DOC_ID, name: 'a.csv', mimeType: 'text/csv', size: '4' },
      },
      { method: 'GET', url: /alt=media/, body: 'a,b\n' },
    ]);
    const result = await executeGoogleDrive(context(fetch), TOOL.readFile, { fileId: DOC_ID });
    expect(JSON.parse(text(result))).toMatchObject({ content: 'a,b\n' });
  });

  test('a binary file, a folder and a file too large are refused, their bytes never fetched', async () => {
    for (const meta of [
      { mimeType: 'application/pdf', size: '10' },
      { mimeType: 'application/vnd.google-apps.folder' },
      { mimeType: 'text/plain', size: '2000000' },
    ]) {
      const fetch = mockFetch([
        { method: 'GET', url: /fields=/, body: { id: DOC_ID, name: 'x', ...meta } },
      ]);
      const result = await executeGoogleDrive(context(fetch), TOOL.readFile, { fileId: DOC_ID });
      expect(result.isError, meta.mimeType).toBe(true);
      expect(fetch.calls).toHaveLength(1);
    }
  });
});

describe('write', () => {
  test('an upload is one multipart request: the metadata with its folder, then the text', async () => {
    const fetch = mockFetch([
      { method: 'POST', url: /\/upload\/drive\/v3\/files\?/, body: { id: 'new' } },
    ]);
    const result = await executeGoogleDrive(context(fetch), TOOL.uploadFile, {
      name: 'notes.md',
      content: '# Notes\n',
      mimeType: 'text/markdown',
      folderId: 'F_1',
    });
    expect(JSON.parse(text(result))).toEqual({ id: 'new' });
    const call = fetch.calls[0]!;
    expect(call.url.startsWith(`${DRIVE_UPLOAD_BASE}/files?uploadType=multipart`)).toBe(true);
    const boundary = /boundary=(\S+)/.exec(call.headers['content-type'] ?? '')?.[1];
    expect(call.headers['content-type']).toMatch(/^multipart\/related; boundary=vaubaan-/);
    expect(call.body).toContain(
      JSON.stringify({ name: 'notes.md', mimeType: 'text/markdown', parents: ['F_1'] }),
    );
    expect(call.body).toContain('Content-Type: text/markdown; charset=UTF-8\r\n\r\n# Notes\n');
    expect(call.body?.endsWith(`--${boundary}--\r\n`)).toBe(true);
  });

  test('a folder is created in its parent', async () => {
    const fetch = mockFetch([{ method: 'POST', url: /\/drive\/v3\/files\?/, body: { id: 'f' } }]);
    await executeGoogleDrive(context(fetch), TOOL.createFolder, { name: 'Reports' });
    expect(fetch.calls[0]!.json).toEqual({
      name: 'Reports',
      mimeType: 'application/vnd.google-apps.folder',
      parents: ['root'],
    });
  });

  test('content over the bound and a binary type are refused before any request', async () => {
    for (const args of [
      { name: 'big.txt', content: 'x'.repeat(1_000_001) },
      { name: 'a.pdf', content: 'x', mimeType: 'application/pdf' },
    ]) {
      const fetch = mockFetch([]);
      expect((await executeGoogleDrive(context(fetch), TOOL.uploadFile, args)).isError).toBe(true);
      expect(fetch.calls).toHaveLength(0);
    }
  });
});

describe('credential and failures', () => {
  test('a token without the drive scope is refused before any request', async () => {
    const fetch = mockFetch([]);
    await expect(
      executeGoogleDrive(context(fetch, [alice], ['openid', 'email']), TOOL.listFolder, {}),
    ).rejects.toMatchObject({ name: 'CredentialRefusal' });
    expect(fetch.calls).toHaveLength(0);
  });

  test('a rejected token is an UpstreamAuthError; another failure an UpstreamHttpError', async () => {
    const fetch = mockFetch([{ url: /\/files\?/, status: 401 }]);
    await expect(executeGoogleDrive(context(fetch), TOOL.listFolder, {})).rejects.toMatchObject({
      name: 'UpstreamAuthError',
    });
    const down = mockFetch([{ url: /\/files\?/, status: 503 }]);
    await expect(executeGoogleDrive(context(down), TOOL.listFolder, {})).rejects.toMatchObject({
      name: 'UpstreamHttpError',
      status: 503,
    });
  });

  test('discovery names the drive by the account address', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: /\/about\?fields=/,
        body: { user: { displayName: 'Alice', emailAddress: 'Alice@Acme.example' } },
      },
    ]);
    expect(await discoverGoogleDriveResources(context(fetch))).toEqual([
      {
        service: SERVICE_ID,
        ref: 'alice~acme.example',
        displayName: 'Alice <alice@acme.example>',
        metadata: { account_email: 'alice@acme.example' },
      },
    ]);
  });
});

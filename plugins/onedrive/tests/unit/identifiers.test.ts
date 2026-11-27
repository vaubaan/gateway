/**
 * The identifier grammars of `onedrive`, and the proof that a hostile
 * identifier is refused by `classify` and by `execute` alike, before any
 * request (ADR plugin-identifiers-one-grammar-for-classify-and-execute).
 */
import { describe, expect, test } from 'vitest';

import { mockFetch } from '@vaubaan/plugin-sdk/testing';

import { classifyOneDrive } from '../../src/classify.ts';
import { executeOneDrive } from '../../src/execute.ts';
import {
  downloadUrl,
  driveRefFromArgument,
  itemId,
  itemName,
  odataString,
  pathSegment,
} from '../../src/identifiers.ts';
import { TOOL } from '../../src/identity.ts';
import { alice, context } from './fixtures.ts';

const HOSTILE = ['..', '../x', '%2e%2e', 'a/..', '%2fetc', 'a b', '*', ''];

describe('grammars', () => {
  test('an item id is letters, digits, !, _ and -; root is one', () => {
    expect(itemId('D4648F06C91D9D3D!54927')).toBe('D4648F06C91D9D3D!54927');
    expect(itemId('01BYE5RZ6QN3ZWBTUFOFD3GSPGOHDJD36K')).toBe('01BYE5RZ6QN3ZWBTUFOFD3GSPGOHDJD36K');
    expect(itemId('root')).toBe('root');
    for (const bad of HOSTILE) expect(itemId(bad), bad).toBeNull();
  });

  test('a path segment is percent-encoded, never repaired', () => {
    expect(pathSegment('D4648F06C91D9D3D!54927')).toBe('D4648F06C91D9D3D!54927');
    expect(pathSegment('Rapport Q3.md')).toBe('Rapport%20Q3.md');
    for (const bad of ['', '.', '..', 'a/b', 'a?b', 'a#b', '%2e%2e', 'a\\b', 'a\nb']) {
      expect(pathSegment(bad), bad).toBeNull();
    }
  });

  test('a name OneDrive accepts, never a separator', () => {
    expect(itemName('Rapport Q3.md')).toBe('Rapport Q3.md');
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a:b', 'a*b', 'a%2fb', 'a#b', ' a', 'a ']) {
      expect(itemName(bad), bad).toBeNull();
    }
  });

  test('a drive is named by its ref or by its address', () => {
    expect(driveRefFromArgument('alice~contoso.example')).toBe('alice~contoso.example');
    expect(driveRefFromArgument('Alice@Contoso.example')).toBe('alice~contoso.example');
    for (const bad of ['alice', '../x', '']) expect(driveRefFromArgument(bad), bad).toBeNull();
  });

  test('a download address is https on a OneDrive or SharePoint host', () => {
    expect(
      downloadUrl('https://contoso.sharepoint.com/_layouts/15/download.aspx?x=1'),
    ).not.toBeNull();
    expect(downloadUrl('https://public.ch.files.1drv.com/y4m/x')).not.toBeNull();
    for (const bad of [
      'http://contoso.sharepoint.com/x',
      'https://evil.example/x',
      'https://sharepoint.com.evil.example/x',
      'https://user:pw@contoso.sharepoint.com/x',
      'not a url',
    ]) {
      expect(downloadUrl(bad), bad).toBeNull();
    }
  });

  test('a search is an OData literal, each quote doubled', () => {
    expect(odataString("l'été")).toBe("'l''été'");
  });
});

describe('hostile identifiers are refused by classify and by execute', () => {
  test.each(HOSTILE)('fileId %j', async (value) => {
    const args = { fileId: value };
    expect('denied' in classifyOneDrive(TOOL.readFile, args, [alice])).toBe(true);
    const fetch = mockFetch([]);
    const result = await executeOneDrive(context(fetch), TOOL.readFile, args);
    expect(result.isError).toBe(true);
    expect(fetch.calls).toHaveLength(0);
  });

  test.each(['..', '%2e%2e', '%2f', '../'])('folderId and name %j', async (value) => {
    for (const [tool, args] of [
      [TOOL.listFolder, { folderId: value }],
      [TOOL.uploadFile, { folderId: value, name: 'n.txt', content: 'c' }],
      [TOOL.uploadFile, { name: value, content: 'c' }],
      [TOOL.createFolder, { parentId: value, name: 'n' }],
      [TOOL.createFolder, { name: value }],
    ] as const) {
      expect('denied' in classifyOneDrive(tool, args, [alice]), tool).toBe(true);
      const fetch = mockFetch([]);
      expect((await executeOneDrive(context(fetch), tool, args)).isError, tool).toBe(true);
      expect(fetch.calls).toHaveLength(0);
    }
  });

  test('a page token that is not a next page of the same listing is refused before any request', async () => {
    for (const pageToken of [
      'https://evil.example/v1.0/me/drive/root/children?$skiptoken=x',
      'https://graph.microsoft.com/v1.0/users/bob/drive/root/children?$skiptoken=x',
      'not a url',
    ]) {
      const fetch = mockFetch([]);
      const result = await executeOneDrive(context(fetch), TOOL.listFolder, { pageToken });
      expect(result.isError, pageToken).toBe(true);
      expect(fetch.calls).toHaveLength(0);
    }
  });
});

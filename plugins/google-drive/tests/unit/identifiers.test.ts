/**
 * The identifier grammars of `google-drive`, and the proof that a hostile
 * identifier is refused by `classify` and by `execute` alike, before any
 * request (ADR plugin-identifiers-one-grammar-for-classify-and-execute).
 */
import { describe, expect, test } from 'vitest';

import { mockFetch } from '@vaubaan/plugin-sdk/testing';

import { classifyGoogleDrive } from '../../src/classify.ts';
import { executeGoogleDrive } from '../../src/execute.ts';
import {
  accountAddress,
  driveRefFromArgument,
  fileId,
  itemName,
  pathSegment,
  textMimeType,
} from '../../src/identifiers.ts';
import { TOOL } from '../../src/identity.ts';
import { alice, context } from './fixtures.ts';

const HOSTILE = ['..', '../x', '%2e%2e', 'a/..', '%2fetc', 'a b', '*', ''];

describe('grammars', () => {
  test('a Drive id is letters, digits, _ and -; root is one', () => {
    expect(fileId('1AbCdEfGh_ijk-LmN')).toBe('1AbCdEfGh_ijk-LmN');
    expect(fileId('root')).toBe('root');
    for (const bad of HOSTILE) expect(fileId(bad), bad).toBeNull();
  });

  test('a path segment is percent-encoded, never repaired', () => {
    expect(pathSegment('1AbC_d-E')).toBe('1AbC_d-E');
    for (const bad of ['', '.', '..', 'a/b', 'a?b', 'a#b', '%2e%2e', 'a\\b', 'a\nb']) {
      expect(pathSegment(bad), bad).toBeNull();
    }
  });

  test('a drive is named by its ref or by its address', () => {
    expect(driveRefFromArgument('alice~acme.example')).toBe('alice~acme.example');
    expect(driveRefFromArgument('Alice@Acme.example')).toBe('alice~acme.example');
    for (const bad of ['alice', 'a~b', 'a..b~c.example', '../x', '']) {
      expect(driveRefFromArgument(bad), bad).toBeNull();
    }
    expect(accountAddress(' Bob@Acme.Example ')).toBe('bob@acme.example');
  });

  test('names and types', () => {
    expect(itemName('Rapport Q3.md')).toBe('Rapport Q3.md');
    for (const bad of ['', '.', '..', 'a\nb', 'x'.repeat(256)]) expect(itemName(bad)).toBeNull();
    expect(textMimeType('text/markdown')).toBe('text/markdown');
    expect(textMimeType('application/json')).toBe('application/json');
    for (const bad of ['application/pdf', 'image/png', 'text', 'text/x;evil']) {
      expect(textMimeType(bad), bad).toBeNull();
    }
  });
});

describe('hostile identifiers are refused by classify and by execute', () => {
  test.each(HOSTILE)('fileId %j', async (value) => {
    const args = { fileId: value };
    expect('denied' in classifyGoogleDrive(TOOL.readFile, args, [alice])).toBe(true);
    const fetch = mockFetch([]);
    const result = await executeGoogleDrive(context(fetch), TOOL.readFile, args);
    expect(result.isError).toBe(true);
    expect(fetch.calls).toHaveLength(0);
  });

  test.each(['..', '%2e%2e', '%2f', '../'])('folderId %j', async (value) => {
    for (const [tool, arg] of [
      [TOOL.listFolder, 'folderId'],
      [TOOL.uploadFile, 'folderId'],
      [TOOL.createFolder, 'parentId'],
    ] as const) {
      const args = { [arg]: value, name: 'n', content: 'c' };
      const own =
        tool === TOOL.listFolder
          ? { [arg]: value }
          : tool === TOOL.createFolder
            ? { [arg]: value, name: 'n' }
            : args;
      expect('denied' in classifyGoogleDrive(tool, own, [alice]), tool).toBe(true);
      const fetch = mockFetch([]);
      const result = await executeGoogleDrive(context(fetch), tool, own);
      expect(result.isError, tool).toBe(true);
      expect(fetch.calls).toHaveLength(0);
    }
  });

  test('a drive outside the mission and an undeclared argument are refused', async () => {
    for (const args of [{ drive: 'carol~acme.example' }, { recursive: true }]) {
      expect('denied' in classifyGoogleDrive(TOOL.listFolder, args, [alice])).toBe(true);
      const fetch = mockFetch([]);
      expect((await executeGoogleDrive(context(fetch), TOOL.listFolder, args)).isError).toBe(true);
      expect(fetch.calls).toHaveLength(0);
    }
  });
});

/**
 * The classifier of the `context7` plugin, branch by branch (handbook §2, §5).
 */
import { describe, expect, test } from 'vitest';

// Test-only : which risks a slice touches. A plugin's sources import the SDK alone.
import { risksTouchedBy } from '@vaubaan/policy-engine';

import { serializeSlice, type Resource } from '@vaubaan/plugin-sdk';

import {
  MALFORMED_LIBRARY_ID,
  NOT_A_CONTEXT7_INDEX,
  NO_CONTEXT7_INDEX,
  PROVIDER_ID,
  TOOL,
  TOOL_PREFIX,
  classifyContext7,
  context7Catalog,
  libraryId,
  malformedText,
} from '../../src/index.ts';
import { index } from './support.ts';

function slices(
  tool: string,
  args: Record<string, unknown>,
  resources: readonly Resource[] = [index],
): string[] {
  const out = classifyContext7(tool, args, resources);
  if ('denied' in out) throw new Error(out.denied);
  return out.slices.map(serializeSlice);
}

function denial(
  tool: string,
  args: Record<string, unknown>,
  resources: readonly Resource[] = [index],
): string {
  const out = classifyContext7(tool, args, resources);
  if (!('denied' in out))
    throw new Error(`classified: ${out.slices.map(serializeSlice).join(', ')}`);
  return out.denied;
}

const QUERY = 'middleware matcher';

describe('classifyContext7 — the two tools', () => {
  test('resolve-library-id reads every library of the index, whatever libraryName says', () => {
    expect(slices(TOOL.resolveLibraryId, { libraryName: 'Next.js', query: QUERY })).toEqual([
      `${PROVIDER_ID}.index[docs].library[*].R`,
    ]);
    // A product name that looks like an id is still free text, never put in a slice.
    expect(slices(TOOL.resolveLibraryId, { libraryName: '/vercel/next.js', query: QUERY })).toEqual(
      [`${PROVIDER_ID}.index[docs].library[*].R`],
    );
  });

  test('query-docs reads the library it names', () => {
    expect(slices(TOOL.queryDocs, { libraryId: '/vercel/next.js', query: QUERY })).toEqual([
      `${PROVIDER_ID}.index[docs].library[/vercel/next.js].R`,
    ]);
    expect(
      slices(TOOL.queryDocs, {
        libraryId: '/vercel/next.js/v14.3.0',
        query: QUERY,
        language: 'Go',
      }),
    ).toEqual([`${PROVIDER_ID}.index[docs].library[/vercel/next.js/v14.3.0].R`]);
  });

  test('a library id the slice grammar cannot carry is classified as any library', () => {
    // `@` of a version form is not a slice character : `[*]`, the value sent unchanged.
    expect(slices(TOOL.queryDocs, { libraryId: '/vercel/next.js@v14.3.0', query: QUERY })).toEqual([
      `${PROVIDER_ID}.index[docs].library[*].R`,
    ]);
    expect(slices(TOOL.queryDocs, { libraryId: '/org/c++', query: QUERY })).toEqual([
      `${PROVIDER_ID}.index[docs].library[*].R`,
    ]);
  });

  test('both tools touch context7.query-docs only', () => {
    for (const outcome of [
      classifyContext7(TOOL.resolveLibraryId, { libraryName: 'Next.js', query: QUERY }, [index]),
      classifyContext7(TOOL.queryDocs, { libraryId: '/vercel/next.js', query: QUERY }, [index]),
    ]) {
      if ('denied' in outcome) throw new Error(outcome.denied);
      for (const slice of outcome.slices) {
        expect(risksTouchedBy(slice, context7Catalog.indexed)).toEqual([
          `${PROVIDER_ID}.query-docs`,
        ]);
      }
    }
  });
});

describe('classifyContext7 — refusals', () => {
  test('an unknown tool', () => {
    const unknown = `${TOOL_PREFIX}add-library`;
    expect(denial(unknown, {})).toBe(`unknown tool '${unknown}'`);
    expect(denial('railway__whoami', {})).toBe("unknown tool 'railway__whoami'");
  });

  test('a mission without a Context7 resource, or with a foreign one', () => {
    const foreign: Resource = { provider: 'railway', ref: 'docs', displayName: 'Foreign' };
    expect(denial(TOOL.queryDocs, { libraryId: '/vercel/next.js', query: QUERY }, [])).toBe(
      NO_CONTEXT7_INDEX,
    );
    expect(denial(TOOL.queryDocs, { libraryId: '/vercel/next.js', query: QUERY }, [foreign])).toBe(
      NO_CONTEXT7_INDEX,
    );
  });

  test('a resource that is not the index, or several resources', () => {
    const odd: Resource = { provider: PROVIDER_ID, ref: 'other', displayName: 'Odd' };
    expect(denial(TOOL.resolveLibraryId, { libraryName: 'x', query: QUERY }, [odd])).toBe(
      NOT_A_CONTEXT7_INDEX,
    );
    expect(denial(TOOL.resolveLibraryId, { libraryName: 'x', query: QUERY }, [index, index])).toBe(
      'the mission holds 2 Context7 resources — one is expected',
    );
  });

  test('every upstream alias and an invented argument are refused as undeclared', () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      [TOOL.queryDocs, { libraryName: '/evil/lib', query: QUERY }, 'libraryName'],
      [TOOL.queryDocs, { libraryId: '/vercel/next.js', userQuery: QUERY }, 'userQuery'],
      [TOOL.queryDocs, { libraryId: '/vercel/next.js', question: QUERY }, 'question'],
      [
        TOOL.queryDocs,
        { context7CompatibleLibraryID: '/evil/lib', query: QUERY },
        'context7CompatibleLibraryID',
      ],
      [TOOL.queryDocs, { libraryID: '/evil/lib', query: QUERY }, 'libraryID'],
      [TOOL.queryDocs, { libraryId: '/vercel/next.js', query: QUERY, tokens: 10000 }, 'tokens'],
      [TOOL.resolveLibraryId, { libraryName: 'Next.js', userQuery: QUERY }, 'userQuery'],
      [
        TOOL.resolveLibraryId,
        { libraryName: 'Next.js', query: QUERY, libraryId: '/x/y' },
        'libraryId',
      ],
    ];
    for (const [tool, args, name] of cases) {
      expect(denial(tool, args)).toBe(
        `${name}: not an argument of '${tool}' — nothing classifies it, so it is not sent.`,
      );
    }
    // An argument given as `undefined` is absent.
    expect(
      slices(TOOL.queryDocs, { libraryId: '/vercel/next.js', query: QUERY, extra: undefined }),
    ).toHaveLength(1);
  });

  test('a malformed library id', () => {
    const hostile: unknown[] = [
      '..',
      '.',
      '/a/../b',
      '/a/./b',
      '/..',
      '/a/..',
      '%2e%2e',
      '/a/%2e%2e',
      '..%2f',
      '/a%2fb',
      '/a/*',
      '/a/b?x=1#y',
      '/a\\b',
      '/a/b\n',
      '/a/ b',
      '',
      '/',
      '//a',
      '/a/',
      'vercel/next.js',
      '/a/b/c/d/e',
      `/${'x'.repeat(500)}`,
      42,
      null,
      ['/vercel/next.js'],
    ];
    for (const value of hostile) {
      expect(
        denial(TOOL.queryDocs, { libraryId: value, query: QUERY }),
        JSON.stringify(value),
      ).toBe(MALFORMED_LIBRARY_ID);
    }
    expect(denial(TOOL.queryDocs, { query: QUERY })).toBe(MALFORMED_LIBRARY_ID);
    // 500 characters is the limit, not beyond.
    expect(slices(TOOL.queryDocs, { libraryId: `/${'x'.repeat(499)}`, query: QUERY })).toHaveLength(
      1,
    );
  });

  test('a free text that is missing, empty, too long or not a string', () => {
    const long = 'x'.repeat(501);
    expect(denial(TOOL.queryDocs, { libraryId: '/vercel/next.js' })).toBe(malformedText('query'));
    expect(denial(TOOL.queryDocs, { libraryId: '/vercel/next.js', query: '' })).toBe(
      malformedText('query'),
    );
    expect(denial(TOOL.queryDocs, { libraryId: '/vercel/next.js', query: long })).toBe(
      malformedText('query'),
    );
    expect(denial(TOOL.queryDocs, { libraryId: '/vercel/next.js', query: 7 })).toBe(
      malformedText('query'),
    );
    expect(
      denial(TOOL.queryDocs, { libraryId: '/vercel/next.js', query: QUERY, language: '' }),
    ).toBe(malformedText('language'));
    expect(
      denial(TOOL.queryDocs, { libraryId: '/vercel/next.js', query: QUERY, language: 3 }),
    ).toBe(malformedText('language'));
    expect(denial(TOOL.resolveLibraryId, { query: QUERY })).toBe(malformedText('libraryName'));
    expect(denial(TOOL.resolveLibraryId, { libraryName: long, query: QUERY })).toBe(
      malformedText('libraryName'),
    );
    expect(denial(TOOL.resolveLibraryId, { libraryName: 'Next.js' })).toBe(malformedText('query'));
    // 500 characters is accepted.
    expect(
      slices(TOOL.resolveLibraryId, { libraryName: 'Next.js', query: 'x'.repeat(500) }),
    ).toHaveLength(1);
  });
});

describe('libraryId — linear on hostile input (the detect-redos suppression)', () => {
  // Each repetition of the pattern starts with '/', which its segment class does
  // not hold, so a string splits one way only; the length is capped at 500 first.
  const hostile = [
    `/${'a'.repeat(498)}!`,
    `${'/a'.repeat(249)}/!`,
    `${'/.'.repeat(250)}`,
    `/${'a'.repeat(50_000)}`,
  ];

  test.each(hostile.map((value, index) => [index, value] as const))(
    'refuses hostile id %i at once',
    (_index, value) => {
      const started = performance.now();
      expect(libraryId(value)).toBeNull();
      expect(performance.now() - started).toBeLessThan(250);
    },
  );
});

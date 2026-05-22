import { describe, expect, test } from 'vitest';
import { evaluateConstraint, readPath } from '../../src/operators.ts';

describe('evaluateConstraint — equals', () => {
  test('string equal', () => {
    expect(evaluateConstraint({ equals: 'main' }, 'main')).toBe(true);
    expect(evaluateConstraint({ equals: 'main' }, 'feature')).toBe(false);
  });
  test('string-coerce', () => {
    expect(evaluateConstraint({ equals: '42' }, 42)).toBe(true);
    expect(evaluateConstraint({ equals: 42 }, '42')).toBe(true);
  });
  test('undefined fails', () => {
    expect(evaluateConstraint({ equals: 'main' }, undefined)).toBe(false);
  });
  test('boolean', () => {
    expect(evaluateConstraint({ equals: true }, true)).toBe(true);
    expect(evaluateConstraint({ equals: true }, 'true')).toBe(true);
    expect(evaluateConstraint({ equals: false }, true)).toBe(false);
  });
});

describe('evaluateConstraint — in / not_in', () => {
  test('in matches one of list', () => {
    expect(evaluateConstraint({ in: ['a', 'b', 'c'] }, 'b')).toBe(true);
    expect(evaluateConstraint({ in: ['a', 'b'] }, 'c')).toBe(false);
  });
  test('not_in undefined matches true', () => {
    expect(evaluateConstraint({ not_in: ['a'] }, undefined)).toBe(true);
  });
  test('not_in defined matches list inversed', () => {
    expect(evaluateConstraint({ not_in: ['a', 'b'] }, 'a')).toBe(false);
    expect(evaluateConstraint({ not_in: ['a', 'b'] }, 'z')).toBe(true);
  });
});

describe('evaluateConstraint — match', () => {
  test('glob match', () => {
    expect(evaluateConstraint({ match: ['feature/*'] }, 'feature/x')).toBe(true);
    expect(evaluateConstraint({ match: ['feature/*'] }, 'main')).toBe(false);
  });
  test('OR over patterns', () => {
    const c = { match: ['feature/*', 'fix/*', 'claude/*'] };
    expect(evaluateConstraint(c, 'feature/foo')).toBe(true);
    expect(evaluateConstraint(c, 'fix/bar')).toBe(true);
    expect(evaluateConstraint(c, 'claude/baz')).toBe(true);
    expect(evaluateConstraint(c, 'main')).toBe(false);
  });
  test('undefined fails', () => {
    expect(evaluateConstraint({ match: ['*'] }, undefined)).toBe(false);
  });
});

describe('evaluateConstraint — regex', () => {
  test('regex match', () => {
    expect(evaluateConstraint({ regex: '^feature/' }, 'feature/x')).toBe(true);
    expect(evaluateConstraint({ regex: '^feature/' }, 'main')).toBe(false);
  });
  test('invalid regex fails gracefully', () => {
    expect(evaluateConstraint({ regex: '[invalid' }, 'anything')).toBe(false);
  });
});

describe('evaluateConstraint — starts_with / not_starts_with', () => {
  test('starts_with single', () => {
    expect(evaluateConstraint({ starts_with: 'feat' }, 'feature/x')).toBe(true);
    expect(evaluateConstraint({ starts_with: 'feat' }, 'main')).toBe(false);
  });
  test('starts_with array OR', () => {
    expect(evaluateConstraint({ starts_with: ['fix', 'feat'] }, 'feature/x')).toBe(true);
    expect(evaluateConstraint({ starts_with: ['fix', 'feat'] }, 'main')).toBe(false);
  });
  test('not_starts_with undefined matches true', () => {
    expect(evaluateConstraint({ not_starts_with: 'main' }, undefined)).toBe(true);
  });
  test('not_starts_with single', () => {
    expect(evaluateConstraint({ not_starts_with: 'main' }, 'main-feature')).toBe(false);
    expect(evaluateConstraint({ not_starts_with: 'main' }, 'feature/x')).toBe(true);
  });
});

describe('readPath', () => {
  test('basic dot-path', () => {
    expect(readPath({ a: { b: { c: 42 } } }, 'a.b.c')).toBe(42);
  });
  test('missing returns undefined', () => {
    expect(readPath({ a: {} }, 'a.b.c')).toBe(undefined);
    expect(readPath({}, 'arguments.branch')).toBe(undefined);
  });
  test('arguments root convention', () => {
    expect(readPath({ arguments: { branch: 'main' } }, 'arguments.branch')).toBe('main');
  });
  test('null in middle', () => {
    expect(readPath({ a: null }, 'a.b')).toBe(undefined);
  });
});

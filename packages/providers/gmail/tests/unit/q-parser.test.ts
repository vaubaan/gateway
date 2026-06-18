/**
 * Unit tests for `parseQ` — the minimal Gmail `q` query parser.
 *
 * Research : .vaubaan/research/providers/gmail.md §6.ter Q8.
 */
import { describe, expect, test } from 'vitest';

import { parseQ } from '../../src/q-parser.ts';

describe('parseQ — cardinal operators', () => {
  test('extracts `from:` address', () => {
    const r = parseQ('from:alice@x.com');
    expect(r.fromAddresses).toEqual(['alice@x.com']);
    expect(r.hasUnknownOps).toBe(false);
  });

  test('extracts `to:` address', () => {
    const r = parseQ('to:bob@y.com');
    expect(r.toAddresses).toEqual(['bob@y.com']);
  });

  test('extracts `label:` label', () => {
    const r = parseQ('label:Important');
    expect(r.labels).toEqual(['Important']);
  });

  test('extracts `newer_than:Nd` in days', () => {
    expect(parseQ('newer_than:30d').newerThanDays).toBe(30);
  });

  test('extracts `newer_than:Nm` as N*30 days', () => {
    expect(parseQ('newer_than:2m').newerThanDays).toBe(60);
  });

  test('extracts `newer_than:Ny` as N*365 days', () => {
    expect(parseQ('newer_than:1y').newerThanDays).toBe(365);
  });
});

describe('parseQ — combinators', () => {
  test('AND-implicit : two froms keeps both addresses', () => {
    const r = parseQ('from:alice@x.com from:bob@y.com');
    expect([...r.fromAddresses].sort()).toEqual(['alice@x.com', 'bob@y.com']);
  });

  test('OR-explicit : OR is silently consumed', () => {
    const r = parseQ('from:alice@x.com OR from:bob@y.com');
    expect([...r.fromAddresses].sort()).toEqual(['alice@x.com', 'bob@y.com']);
    expect(r.hasUnknownOps).toBe(false);
  });

  test('AND-explicit : AND is silently consumed', () => {
    const r = parseQ('from:alice@x.com AND label:Inbox');
    expect(r.fromAddresses).toEqual(['alice@x.com']);
    expect(r.labels).toEqual(['Inbox']);
  });

  test('negation `-` is treated as a from match (we extract regardless of sign)', () => {
    const r = parseQ('-from:spam@bad.com');
    expect(r.fromAddresses).toEqual(['spam@bad.com']);
  });

  test('multiple newer_than keeps the smallest window (most restrictive)', () => {
    const r = parseQ('newer_than:30d newer_than:7d');
    expect(r.newerThanDays).toBe(7);
  });
});

describe('parseQ — unknown operators fall through silently', () => {
  test('`has:attachment` is unknown → hasUnknownOps true', () => {
    const r = parseQ('has:attachment');
    expect(r.hasUnknownOps).toBe(true);
    expect(r.fromAddresses).toEqual([]);
  });

  test('`is:unread` is unknown', () => {
    const r = parseQ('is:unread');
    expect(r.hasUnknownOps).toBe(true);
  });

  test('bare keyword is unknown', () => {
    const r = parseQ('invoice');
    expect(r.hasUnknownOps).toBe(true);
  });

  test('mix of known + unknown : extracts known, flags unknown', () => {
    const r = parseQ('from:alice@x.com is:starred');
    expect(r.fromAddresses).toEqual(['alice@x.com']);
    expect(r.hasUnknownOps).toBe(true);
  });
});

describe('parseQ — edge cases', () => {
  test('empty q → all empty, no unknown', () => {
    const r = parseQ('');
    expect(r.fromAddresses).toEqual([]);
    expect(r.toAddresses).toEqual([]);
    expect(r.labels).toEqual([]);
    expect(r.newerThanDays).toBeUndefined();
    expect(r.hasUnknownOps).toBe(false);
  });

  test('whitespace-only q → empty', () => {
    expect(parseQ('   \t\n  ').hasUnknownOps).toBe(false);
  });

  test('case-insensitive operators (`FROM:`)', () => {
    expect(parseQ('FROM:alice@x.com').fromAddresses).toEqual(['alice@x.com']);
  });

  test('duplicate `from:` deduped', () => {
    const r = parseQ('from:alice@x.com from:alice@x.com');
    expect(r.fromAddresses).toEqual(['alice@x.com']);
  });
});

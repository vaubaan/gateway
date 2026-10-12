import { describe, expect, test } from 'vitest';
import { validateDataModel } from '@vaubaan/shared';

import { stripeDataModel } from '../../src/index.ts';

describe('stripeDataModel — referential integrity', () => {
  test('every entity.parent references an existing entity in the same plane', () => {
    expect(validateDataModel(stripeDataModel)).toEqual([]);
  });

  test('declares exactly one plane (billing)', () => {
    expect(stripeDataModel.planes).toHaveLength(1);
    expect(stripeDataModel.planes[0]!.slug).toBe('billing');
  });

  test('mode is the envScopable entity (test/live calque)', () => {
    const mode = stripeDataModel.planes[0]!.entities.find((e) => e.name === 'mode');
    expect(mode).toBeDefined();
    expect(mode!.envScopable).toBe(true);
    expect(mode!.parent).toBe('account');
    expect(mode!.cardinalities).toContain('bounded');
  });

  test('account is the plane root (parent === null)', () => {
    const account = stripeDataModel.planes[0]!.entities.find((e) => e.name === 'account');
    expect(account).toBeDefined();
    expect(account!.parent).toBeNull();
    expect(account!.cardinalities).toContain('one');
  });

  test('refund hierarchy is preserved (refund < charge < payment-intent < mode)', () => {
    const entities = stripeDataModel.planes[0]!.entities;
    const refund = entities.find((e) => e.name === 'refund');
    const charge = entities.find((e) => e.name === 'charge');
    const pi = entities.find((e) => e.name === 'payment-intent');
    expect(refund!.parent).toBe('charge');
    expect(charge!.parent).toBe('payment-intent');
    expect(pi!.parent).toBe('mode');
  });

  test('webhook-endpoint.secret synthetic overlay is declared', () => {
    const secret = stripeDataModel.planes[0]!.entities.find((e) => e.name === 'secret');
    expect(secret).toBeDefined();
    expect(secret!.parent).toBe('webhook-endpoint');
    expect(secret!.cardinalities).toEqual(['one']);
  });

  test('customer.pii synthetic overlay is declared', () => {
    const pii = stripeDataModel.planes[0]!.entities.find((e) => e.name === 'pii');
    expect(pii).toBeDefined();
    expect(pii!.parent).toBe('customer');
    expect(pii!.cardinalities).toEqual(['one']);
  });

  test('cardinal high-volume entities are unbounded (customer, invoice, PI, events)', () => {
    const entities = stripeDataModel.planes[0]!.entities;
    for (const slug of [
      'customer',
      'invoice',
      'payment-intent',
      'balance-transaction',
      'event',
      'product',
    ]) {
      const e = entities.find((x) => x.name === slug);
      expect(e, `entity '${slug}' must be declared`).toBeDefined();
      expect(e!.cardinalities).toContain('unbounded');
    }
  });
});

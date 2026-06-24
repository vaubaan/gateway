import { describe, expect, test } from 'vitest';
import { validateDataModel } from '@vaubaan/shared';

import { resendDataModel } from '../../src/index.ts';

describe('resendDataModel — referential integrity', () => {
  test('every entity.parent references an existing entity in the same plane', () => {
    expect(validateDataModel(resendDataModel)).toEqual([]);
  });

  test('declares exactly one plane (email)', () => {
    expect(resendDataModel.planes).toHaveLength(1);
    expect(resendDataModel.planes[0]!.slug).toBe('email');
  });

  test('account is the envScopable entity', () => {
    const account = resendDataModel.planes[0]!.entities.find((e) => e.name === 'account');
    expect(account).toBeDefined();
    expect(account!.envScopable).toBe(true);
    expect(account!.parent).toBeNull();
    expect(account!.cardinalities).toContain('one');
  });

  test('account is the plane root (parent === null)', () => {
    const account = resendDataModel.planes[0]!.entities.find((e) => e.name === 'account');
    expect(account).toBeDefined();
    expect(account!.parent).toBeNull();
    expect(account!.cardinalities).toContain('one');
  });

  test('domain hierarchy is preserved (dns-record < domain < account)', () => {
    const entities = resendDataModel.planes[0]!.entities;
    const dnsRecord = entities.find((e) => e.name === 'dns-record');
    const domain = entities.find((e) => e.name === 'domain');
    expect(dnsRecord!.parent).toBe('domain');
    expect(domain!.parent).toBe('account');
  });

  test('audience/contact/broadcast hierarchy is preserved', () => {
    const entities = resendDataModel.planes[0]!.entities;
    const contact = entities.find((e) => e.name === 'contact');
    const broadcast = entities.find((e) => e.name === 'broadcast');
    const audience = entities.find((e) => e.name === 'audience');
    expect(contact!.parent).toBe('audience');
    expect(broadcast!.parent).toBe('audience');
    expect(audience!.parent).toBe('account');
  });

  test('synthetic markers (to-zone, recipient-count) are children of account', () => {
    const entities = resendDataModel.planes[0]!.entities;
    const toZone = entities.find((e) => e.name === 'to-zone');
    const recipientCount = entities.find((e) => e.name === 'recipient-count');
    expect(toZone).toBeDefined();
    expect(toZone!.parent).toBe('account');
    expect(toZone!.cardinalities).toContain('bounded');
    expect(recipientCount).toBeDefined();
    expect(recipientCount!.parent).toBe('account');
    expect(recipientCount!.cardinalities).toContain('bounded');
  });

  test('unbounded entities are declared correctly (email, batch, contact, broadcast)', () => {
    const entities = resendDataModel.planes[0]!.entities;
    for (const slug of ['email', 'batch', 'contact', 'broadcast']) {
      const e = entities.find((x) => x.name === slug);
      expect(e, `entity '${slug}' must be declared`).toBeDefined();
      expect(e!.cardinalities).toContain('unbounded');
    }
  });

  test('declares exactly 10 entities', () => {
    expect(resendDataModel.planes[0]!.entities).toHaveLength(10);
  });
});

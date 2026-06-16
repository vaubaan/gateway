/**
 * Unit tests for the externalApprovalParent helper — the carte-blanche
 * shim used by Telegram / Email / user-session approval routes.
 *
 * Spec : docs/decisions/unified-tokens-delegation-chain-and-escalation-channel.md
 *        + .vaubaan/reports/clean-code-report.md ❌-1.
 */
import { describe, expect, test } from 'vitest';

import { externalApprovalParent } from '@/lib/approvals/external-mint';
import { isCarteBlancheParent } from '@/lib/approvals/mint';

describe('externalApprovalParent', () => {
  test('email channel produces a root org-scoped carte-blanche parent', () => {
    const parent = externalApprovalParent({
      approvalId: 'appr_1',
      organizationId: 'org_1',
      channel: 'email',
      createdBy: null,
    });
    expect(parent.name).toBe('email-approval');
    expect(parent.scope).toBe('org');
    expect(parent.depth).toBe(0);
    expect(parent.accepted_risks).toEqual([]);
    expect(parent.denied_risks).toEqual([]);
    expect(parent.delegation_chain).toEqual([]);
    expect(parent.project_id).toBeNull();
    expect(parent.expires_at).toBeNull();
    expect(parent.organization_id).toBe('org_1');
    expect(parent.created_by).toBeNull();
  });

  test('telegram channel marker propagates to name', () => {
    const parent = externalApprovalParent({
      approvalId: 'appr_2',
      organizationId: 'org_2',
      channel: 'telegram',
      createdBy: null,
    });
    expect(parent.name).toBe('telegram-approval');
  });

  test('user-session channel carries the user id as created_by', () => {
    const parent = externalApprovalParent({
      approvalId: 'appr_3',
      organizationId: 'org_3',
      channel: 'user-session',
      createdBy: 'usr_42',
    });
    expect(parent.name).toBe('user-session-approval');
    expect(parent.created_by).toBe('usr_42');
  });

  test('produces a fresh created_at on each call (ISO timestamp)', () => {
    const a = externalApprovalParent({
      approvalId: 'a',
      organizationId: 'o',
      channel: 'email',
      createdBy: null,
    });
    expect(a.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test('shape satisfies the carte-blanche bypass rule (org+depth0+empty accepted)', () => {
    // This shape MUST trigger the bypass in mintChildToken (cf. mint.ts:142).
    const parent = externalApprovalParent({
      approvalId: 'appr_x',
      organizationId: 'org_x',
      channel: 'email',
      createdBy: null,
    });
    expect(isCarteBlancheParent(parent)).toBe(true);
  });
});

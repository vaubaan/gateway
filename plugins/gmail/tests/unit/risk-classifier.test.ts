/**
 * Unit tests for `classifyGmailV4` — the Gmail v4 risk-based classifier.
 *
 * Spec     : docs/spec/gateway-risk-model.md §3, §7.
 * Research : .vaubaan/research/providers/gmail.md §2 + §5.
 *
 * Each test pins down :
 *   - the slice(s) emitted for a given (tool, args) call,
 *   - the worst-case rule for `get_thread` (research Q2),
 *   - the bulk-marker rule for non-discriminating `search_threads`,
 *   - the from-zone / to-zone classification against binding metadata,
 *   - the synthetic tool `gmail__describe_zones` (research Q7).
 */
import { describe, expect, test } from 'vitest';
import type { ProviderBinding } from '@vaubaan/shared';
import { serializeSlice } from '@vaubaan/policy-engine';

import { classifyGmailV4 } from '../../src/risk-classifier.ts';

const binding: ProviderBinding = {
  id: 'b1',
  project_id: 'p1',
  provider: 'gmail',
  resource_ref: 'me@myorg.com',
  display_name: null,
  environment: null,
  metadata: {
    internal_domains: ['myorg.com'],
    allowlist_addresses: ['partner@vendor.com'],
    allowlist_domains: ['vendor.com'],
    sensitive_labels: ['LEGAL', 'HR'],
    account_email: 'me@myorg.com',
  },
  created_at: '2026-01-01',
};

function classify(tool: string, args: Record<string, unknown> = {}) {
  const result = classifyGmailV4(tool, args, [binding]);
  if ('denied' in result) {
    throw new Error(`unexpected denial: ${result.denied}`);
  }
  return result.slices.map((s) => serializeSlice(s));
}

describe('classifyGmailV4 — describe_zones (synthetic Vaubaan tool)', () => {
  test('emits a single label-read slice (matches read-mailbox)', () => {
    expect(classify('gmail__describe_zones')).toEqual(['gmail.mailbox.label[*].R']);
  });
});

describe('classifyGmailV4 — search_threads (q parsing → zones)', () => {
  test('from:no-reply@github.com → from-zone[automated]', () => {
    const sl = classify('gmail__search_threads', { q: 'from:no-reply@github.com' });
    expect(sl).toContain('gmail.mailbox.label[*].R');
    expect(sl).toContain('gmail.mailbox.from-zone[automated].R');
    expect(sl).not.toContain('gmail.mailbox.bulk-marker.R');
  });

  test('from:colleague@myorg.com → from-zone[internal]', () => {
    const sl = classify('gmail__search_threads', { q: 'from:colleague@myorg.com' });
    expect(sl).toContain('gmail.mailbox.from-zone[internal].R');
  });

  test('from:partner@vendor.com → from-zone[known-external] (allowlist_addresses)', () => {
    const sl = classify('gmail__search_threads', { q: 'from:partner@vendor.com' });
    expect(sl).toContain('gmail.mailbox.from-zone[known-external].R');
  });

  test('from:someone@vendor.com → from-zone[known-external] (allowlist_domains)', () => {
    const sl = classify('gmail__search_threads', { q: 'from:other@vendor.com' });
    expect(sl).toContain('gmail.mailbox.from-zone[known-external].R');
  });

  test('from:random@randomdomain.io → from-zone[unknown]', () => {
    const sl = classify('gmail__search_threads', { q: 'from:random@randomdomain.io' });
    expect(sl).toContain('gmail.mailbox.from-zone[unknown].R');
  });

  test('non-discriminating q (is:unread) → bulk-marker + from-zone[unknown]', () => {
    const sl = classify('gmail__search_threads', { q: 'is:unread' });
    expect(sl).toContain('gmail.mailbox.bulk-marker.R');
    expect(sl).toContain('gmail.mailbox.from-zone[unknown].R');
  });

  test('q with unknown opérator AND from:internal → both zones (worst-case appended)', () => {
    const sl = classify('gmail__search_threads', { q: 'from:colleague@myorg.com has:attachment' });
    expect(sl).toContain('gmail.mailbox.from-zone[internal].R');
    expect(sl).toContain('gmail.mailbox.from-zone[unknown].R');
  });

  test('label:LEGAL (sensitive) → sensitive-label[LEGAL].R is emitted', () => {
    const sl = classify('gmail__search_threads', { q: 'label:LEGAL' });
    expect(sl).toContain('gmail.mailbox.sensitive-label[LEGAL].R');
  });

  test('label:Important (NOT in sensitive_labels) → no sensitive-label slice', () => {
    const sl = classify('gmail__search_threads', { q: 'label:Important' });
    expect(sl.some((s) => s.includes('sensitive-label'))).toBe(false);
  });
});

describe('classifyGmailV4 — get_thread (worst-case unknown, research Q2)', () => {
  test('always emits from-zone[unknown].R regardless of thread id', () => {
    const sl = classify('gmail__get_thread', { id: 't_xyz' });
    expect(sl).toContain('gmail.mailbox.from-zone[unknown].R');
    expect(sl).toContain('gmail.mailbox.thread[t_xyz].message[*].R');
  });

  test('missing id → wildcard ident, still worst-case', () => {
    const sl = classify('gmail__get_thread');
    expect(sl).toContain('gmail.mailbox.from-zone[unknown].R');
  });
});

describe('classifyGmailV4 — list_drafts / list_labels', () => {
  test('list_drafts → draft[*].R', () => {
    expect(classify('gmail__list_drafts')).toEqual(['gmail.mailbox.draft[*].R']);
  });

  test('list_labels → label[*].R (matches read-mailbox)', () => {
    expect(classify('gmail__list_labels')).toEqual(['gmail.mailbox.label[*].R']);
  });
});

describe('classifyGmailV4 — create_draft (to-zone derived from recipients)', () => {
  test('to=[me@myorg.com] (account self) → to-zone[self]', () => {
    const sl = classify('gmail__create_draft', { to: ['me@myorg.com'] });
    expect(sl).toContain('gmail.mailbox.draft.W');
    expect(sl).toContain('gmail.mailbox.to-zone[self].W');
  });

  test('to=[colleague@myorg.com] → to-zone[internal]', () => {
    const sl = classify('gmail__create_draft', { to: ['colleague@myorg.com'] });
    expect(sl).toContain('gmail.mailbox.to-zone[internal].W');
  });

  test('to=[partner@vendor.com] (allowlist address) → to-zone[allowlist]', () => {
    const sl = classify('gmail__create_draft', { to: ['partner@vendor.com'] });
    expect(sl).toContain('gmail.mailbox.to-zone[allowlist].W');
  });

  test('to=[stranger@evil.ru] → to-zone[external-unbounded]', () => {
    const sl = classify('gmail__create_draft', { to: ['stranger@evil.ru'] });
    expect(sl).toContain('gmail.mailbox.to-zone[external-unbounded].W');
  });

  test('mixed recipients: one external + rest internal → worst (external-unbounded)', () => {
    const sl = classify('gmail__create_draft', {
      to: ['colleague@myorg.com', 'stranger@evil.ru'],
    });
    expect(sl).toContain('gmail.mailbox.to-zone[external-unbounded].W');
  });

  test('cc / bcc are folded into the recipient set', () => {
    const sl = classify('gmail__create_draft', {
      to: ['colleague@myorg.com'],
      bcc: 'stranger@evil.ru',
    });
    expect(sl).toContain('gmail.mailbox.to-zone[external-unbounded].W');
  });

  test('comma-separated string `to` is parsed', () => {
    const sl = classify('gmail__create_draft', {
      to: 'colleague@myorg.com, partner@vendor.com',
    });
    // partner is allowlist, colleague is internal → worst is allowlist
    expect(sl).toContain('gmail.mailbox.to-zone[allowlist].W');
  });

  test('no recipients → to-zone[self] (draft has no destination yet)', () => {
    const sl = classify('gmail__create_draft', { subject: 'memo' });
    expect(sl).toContain('gmail.mailbox.to-zone[self].W');
  });

  test('display-name form `"Name <addr>"` is parsed', () => {
    const sl = classify('gmail__create_draft', { to: ['Colleague <colleague@myorg.com>'] });
    expect(sl).toContain('gmail.mailbox.to-zone[internal].W');
  });
});

describe('classifyGmailV4 — label_message / unlabel_message', () => {
  test('label_message → thread[T].message[M].label.W', () => {
    const sl = classify('gmail__label_message', {
      thread_id: 't1',
      message_id: 'm1',
      label: 'Important',
    });
    expect(sl).toEqual(['gmail.mailbox.thread[t1].message[m1].label.W']);
  });

  test('unlabel_message → same shape', () => {
    const sl = classify('gmail__unlabel_message', {
      thread_id: 't1',
      message_id: 'm1',
      label: 'Important',
    });
    expect(sl).toEqual(['gmail.mailbox.thread[t1].message[m1].label.W']);
  });
});

describe('classifyGmailV4 — label_thread / unlabel_thread', () => {
  test('label_thread → thread[T].label.W (whole-thread)', () => {
    const sl = classify('gmail__label_thread', { thread_id: 't1', label: 'Archive' });
    expect(sl).toEqual(['gmail.mailbox.thread[t1].label.W']);
  });

  test('unlabel_thread → same shape', () => {
    const sl = classify('gmail__unlabel_thread', { thread_id: 't1', label: 'Archive' });
    expect(sl).toEqual(['gmail.mailbox.thread[t1].label.W']);
  });
});

describe('classifyGmailV4 — denials', () => {
  test('unknown tool → denied', () => {
    const result = classifyGmailV4('gmail__bogus', {}, [binding]);
    expect(result).toEqual({ denied: "unknown gmail tool 'gmail__bogus'." });
  });

  test('no gmail binding on the token → denied', () => {
    const result = classifyGmailV4('gmail__search_threads', { q: 'is:unread' }, []);
    expect(result).toEqual({ denied: 'no gmail binding is attached to this token.' });
  });
});

describe('classifyGmailV4 — automated heuristic (research §1.3)', () => {
  test('from:notifications@myorg.com → automated (trumps internal)', () => {
    const sl = classify('gmail__search_threads', { q: 'from:notifications@myorg.com' });
    expect(sl).toContain('gmail.mailbox.from-zone[automated].R');
    // The automated rule trumps internal — we should NOT also emit internal.
    expect(sl).not.toContain('gmail.mailbox.from-zone[internal].R');
  });

  test('from:alerts@unknown.io → automated', () => {
    const sl = classify('gmail__search_threads', { q: 'from:alerts@somewhere.io' });
    expect(sl).toContain('gmail.mailbox.from-zone[automated].R');
  });
});

describe('classifyGmailV4 — binding without metadata defaults safely', () => {
  test('classification falls back to from-zone[unknown] when no metadata is set', () => {
    const noMd: ProviderBinding = {
      id: 'b2',
      project_id: 'p1',
      provider: 'gmail',
      resource_ref: 'me@myorg.com',
      display_name: null,
      environment: null,
      created_at: '2026-01-01',
    };
    const result = classifyGmailV4('gmail__search_threads', { q: 'from:colleague@myorg.com' }, [
      noMd,
    ]);
    expect('slices' in result).toBe(true);
    if ('slices' in result) {
      const serialised = result.slices.map((s) => serializeSlice(s));
      // Without internal_domains, colleague@myorg.com is just unknown.
      expect(serialised).toContain('gmail.mailbox.from-zone[unknown].R');
    }
  });
});

/**
 * Unit tests for `classifyGmail` — the Gmail risk classifier
 * (`(tool, args, resources) → slices`).
 *
 * Spec     : docs/spec/gateway-risk-model.md §3, §7.
 * Handbook : docs/handbook/services/gmail.md.
 *
 * Each test pins down :
 *   - the slice(s) emitted for a given (tool, args) call,
 *   - the worst-case rule for `get_thread`,
 *   - the "bounded by a positive `from:`" rule of `search_threads`,
 *   - the from-zone / to-zone classification against the mailbox resource metadata,
 *   - the fail-closed rules : sensitive labels, recipients, label writes,
 *   - the synthetic tool `gmail__describe_zones`.
 */
import { describe, expect, test } from 'vitest';
import { serializeSlice, type Resource } from '@vaubaan/plugin-sdk';

import { classifyFromAddress, classifyGmail, readMailboxMetadata } from '../../src/classify.ts';

const mailbox: Resource = {
  service: 'gmail',
  ref: 'me@myorg.com',
  displayName: 'me@myorg.com',
  env: null,
  metadata: {
    internal_domains: ['myorg.com'],
    allowlist_addresses: ['partner@vendor.com'],
    allowlist_domains: ['vendor.com'],
    sensitive_labels: ['LEGAL', 'HR'],
    account_email: 'me@myorg.com',
  },
};

/** Same mailbox, no sensitive label declared : isolates the sender-zone rules. */
const plainMailbox: Resource = {
  ...mailbox,
  metadata: { ...mailbox.metadata, sensitive_labels: [] },
};

const LABEL_R = 'gmail.mailbox.label[*].R';
const BULK_R = 'gmail.mailbox.bulk-marker.R';
const fromZone = (z: string): string => `gmail.mailbox.from-zone[${z}].R`;
const toZone = (z: string): string => `gmail.mailbox.to-zone[${z}].W`;
const sensitiveR = (l: string): string => `gmail.mailbox.sensitive-label[${l}].R`;
const sensitiveW = (l: string): string => `gmail.mailbox.sensitive-label[${l}].W`;

function classify(tool: string, args: Record<string, unknown> = {}, resource: Resource = mailbox) {
  const result = classifyGmail(tool, args, [resource]);
  if ('denied' in result) {
    throw new Error(`unexpected denial: ${result.denied}`);
  }
  return result.slices.map((s) => serializeSlice(s));
}

function denial(tool: string, args: Record<string, unknown> = {}, resource: Resource = mailbox) {
  const result = classifyGmail(tool, args, [resource]);
  if (!('denied' in result)) {
    throw new Error(`expected a denial, got ${result.slices.map(serializeSlice).join(', ')}`);
  }
  return result.denied;
}

const search = (q: unknown, resource: Resource = plainMailbox) =>
  classify('gmail__search_threads', { q }, resource);

describe('classifyGmail — describe_zones (synthetic Vaubaan tool)', () => {
  test('emits a single label-read slice (matches read-mailbox)', () => {
    expect(classify('gmail__describe_zones')).toEqual([LABEL_R]);
  });
});

describe('classifyGmail — search_threads bounded by a positive from:', () => {
  test('from:no-reply@vendor.com → from-zone[automated] only', () => {
    expect(search('from:no-reply@vendor.com')).toEqual([LABEL_R, fromZone('automated')]);
  });

  test('from:colleague@myorg.com → from-zone[internal] only', () => {
    expect(search('from:colleague@myorg.com')).toEqual([LABEL_R, fromZone('internal')]);
  });

  test('from:partner@vendor.com → from-zone[known-external] (allowlist_addresses)', () => {
    expect(search('from:partner@vendor.com')).toEqual([LABEL_R, fromZone('known-external')]);
  });

  test('from:other@vendor.com → from-zone[known-external] (allowlist_domains)', () => {
    expect(search('from:other@vendor.com')).toEqual([LABEL_R, fromZone('known-external')]);
  });

  test('from:random@randomdomain.io → from-zone[unknown], no bulk marker', () => {
    expect(search('from:random@randomdomain.io')).toEqual([LABEL_R, fromZone('unknown')]);
  });

  test('a conjunction narrowed by to: / label: / newer_than: stays bounded', () => {
    expect(search('from:colleague@myorg.com to:me@myorg.com label:inbox newer_than:7d')).toEqual([
      LABEL_R,
      fromZone('internal'),
    ]);
  });

  test('an unknown operator next to from:internal adds the unknown zone, not the bulk marker', () => {
    const sl = search('from:colleague@myorg.com has:attachment');
    expect(sl).toEqual([LABEL_R, fromZone('internal'), fromZone('unknown')]);
  });

  test('a negated clause next to from:internal adds the unknown zone, not the bulk marker', () => {
    const sl = search('from:colleague@myorg.com -from:boss@myorg.com');
    expect(sl).toEqual([LABEL_R, fromZone('internal'), fromZone('unknown')]);
  });
});

describe('classifyGmail — search_threads the parser cannot bound (unknown zone + bulk marker)', () => {
  test.each([
    ['no clause at all', ''],
    ['non-discriminating operator', 'is:unread'],
    ['union with a time window', 'from:no-reply@vendor.com OR newer_than:3650d'],
    ['union with to:', 'from:no-reply@vendor.com OR to:me@myorg.com'],
    ['union of two senders', 'from:no-reply@vendor.com OR from:colleague@myorg.com'],
    ['lower-case or', 'from:no-reply@vendor.com or newer_than:3650d'],
    ['grouping in parentheses', 'from:(no-reply@vendor.com colleague@myorg.com)'],
    ['grouping in braces', '{from:no-reply@vendor.com from:colleague@myorg.com}'],
    ['a from: inside a quoted phrase', 'subject:"x from:colleague@myorg.com y"'],
    ['negated sender only', '-from:boss@myorg.com'],
    ['to: only', 'to:me@myorg.com'],
    ['label: only', 'label:inbox'],
    ['negated label only', '-label:nope'],
    ['from: that is not a full address', 'from:support'],
    ['from: a bare domain', 'from:myorg.com'],
    ['from: with a display-name form', 'from:Boss<boss@myorg.com>'],
    ['from: with two addresses', 'from:boss@myorg.com,evil@evil.ru'],
  ])('%s → from-zone[unknown] + bulk-marker', (_name, q) => {
    const sl = search(q);
    expect(sl).toContain(LABEL_R);
    expect(sl).toContain(fromZone('unknown'));
    expect(sl).toContain(BULK_R);
  });

  test('a union never yields less than the zones it names', () => {
    const sl = search('from:no-reply@vendor.com OR from:colleague@myorg.com');
    expect(sl).toEqual([
      LABEL_R,
      fromZone('automated'),
      fromZone('internal'),
      fromZone('unknown'),
      BULK_R,
    ]);
  });

  test('a `q` that is not a string is the unbounded query', () => {
    const sl = search(['from:colleague@myorg.com']);
    expect(sl).toEqual([LABEL_R, fromZone('unknown'), BULK_R]);
  });
});

describe('classifyGmail — sensitive labels fail closed on reads', () => {
  test('a search emits every declared sensitive label, whatever the query says', () => {
    for (const q of ['from:boss@myorg.com', 'label:Important', 'label:legal/contracts', '']) {
      const sl = search(q, mailbox);
      expect(sl, q).toContain(sensitiveR('LEGAL'));
      expect(sl, q).toContain(sensitiveR('HR'));
    }
  });

  test('label:LEGAL names a sensitive label → sensitive-label[LEGAL].R', () => {
    expect(search('label:LEGAL', mailbox)).toContain(sensitiveR('LEGAL'));
  });

  test('an explicit -label: for each sensitive label in a conjunction lifts the marker', () => {
    const sl = search('from:boss@myorg.com -label:legal -label:HR', mailbox);
    expect(sl).toEqual([LABEL_R, fromZone('internal')]);
  });

  test('excluding one label keeps the marker of the other', () => {
    const sl = search('from:boss@myorg.com -label:LEGAL', mailbox);
    expect(sl).not.toContain(sensitiveR('LEGAL'));
    expect(sl).toContain(sensitiveR('HR'));
  });

  test('an exclusion inside a union proves nothing', () => {
    const sl = search('from:boss@myorg.com -label:LEGAL -label:HR OR is:unread', mailbox);
    expect(sl).toContain(sensitiveR('LEGAL'));
    expect(sl).toContain(sensitiveR('HR'));
  });

  test('a positive clause on a sensitive label, or one nested under it, overrides the exclusion', () => {
    for (const q of ['label:legal/contracts', 'label:legal-contracts', 'label:LEGAL']) {
      const sl = search(`from:boss@myorg.com ${q} -label:legal -label:hr`, mailbox);
      expect(sl, q).toContain(sensitiveR('LEGAL'));
      expect(sl, q).not.toContain(sensitiveR('HR'));
    }
  });

  test('a label name that is not a legal slice identifier is emitted as `*`', () => {
    const spaced: Resource = {
      ...mailbox,
      metadata: { ...mailbox.metadata, sensitive_labels: ['Top Secret'] },
    };
    expect(search('from:boss@myorg.com', spaced)).toContain(sensitiveR('*'));
    expect(search('from:boss@myorg.com -label:top-secret', spaced)).toEqual([
      LABEL_R,
      fromZone('internal'),
    ]);
  });

  test('no sensitive label declared → no marker', () => {
    expect(search('label:LEGAL').some((s) => s.includes('sensitive-label'))).toBe(false);
  });

  test('get_thread always carries the marker when the mailbox declares sensitive labels', () => {
    expect(classify('gmail__get_thread', { id: '1a2b3c' })).toEqual([
      'gmail.mailbox.thread[1a2b3c].message[*].R',
      fromZone('unknown'),
      sensitiveR('*'),
    ]);
  });
});

describe('classifyGmail — get_thread (worst case : the sender is unknown before the fetch)', () => {
  test('emits the containment slice and from-zone[unknown].R', () => {
    expect(classify('gmail__get_thread', { id: '1a2b3c' }, plainMailbox)).toEqual([
      'gmail.mailbox.thread[1a2b3c].message[*].R',
      fromZone('unknown'),
    ]);
  });

  test.each([
    ['missing', undefined],
    ['empty', ''],
    ['not a string', 42],
    ['slice syntax', 'x].label.W'],
    ['wildcard', '*'],
  ])('id %s → denied', (_name, id) => {
    expect(denial('gmail__get_thread', { id })).toMatch(/^id: /);
  });
});

describe('classifyGmail — list_drafts / list_labels', () => {
  test('list_drafts → draft[*].R', () => {
    expect(classify('gmail__list_drafts')).toEqual(['gmail.mailbox.draft[*].R']);
  });

  test('list_labels → label[*].R (matches read-mailbox)', () => {
    expect(classify('gmail__list_labels')).toEqual([LABEL_R]);
  });
});

describe('classifyGmail — create_draft (to-zone derived from recipients)', () => {
  const draft = (args: Record<string, unknown>) => classify('gmail__create_draft', args);

  test('to=[me@myorg.com] (account self) → to-zone[self]', () => {
    expect(draft({ to: ['me@myorg.com'] })).toEqual(['gmail.mailbox.draft.W', toZone('self')]);
  });

  test('to=[colleague@myorg.com] → to-zone[internal]', () => {
    expect(draft({ to: ['colleague@myorg.com'] })).toContain(toZone('internal'));
  });

  test('to=[partner@vendor.com] (allowlist address) → to-zone[allowlist]', () => {
    expect(draft({ to: ['partner@vendor.com'] })).toContain(toZone('allowlist'));
  });

  test('mixed recipients : the worst zone wins', () => {
    expect(draft({ to: ['me@myorg.com', 'colleague@myorg.com'] })).toContain(toZone('internal'));
    expect(draft({ to: ['colleague@myorg.com'], cc: ['partner@vendor.com'] })).toContain(
      toZone('allowlist'),
    );
  });

  test('a single address may be given as a string ; cc / bcc are folded in', () => {
    expect(draft({ to: 'me@myorg.com', bcc: 'Colleague@MyOrg.com' })).toContain(toZone('internal'));
  });

  test('no recipients → to-zone[self] (the draft has no destination yet)', () => {
    expect(draft({ subject: 'memo' })).toContain(toZone('self'));
    expect(draft({ to: [], cc: null })).toContain(toZone('self'));
  });

  test('display-name form `Name <addr>` is parsed, bare or quoted', () => {
    expect(draft({ to: ['Colleague <colleague@myorg.com>'] })).toContain(toZone('internal'));
    expect(draft({ to: ['"Col League" <colleague@myorg.com>'] })).toContain(toZone('internal'));
  });
});

describe('classifyGmail — create_draft refuses an external recipient', () => {
  const refused = /outside the internal domains and the allowlist/;

  test('to=[stranger@evil.ru] → denied, never a to-zone[external-unbounded] slice', () => {
    expect(denial('gmail__create_draft', { to: ['stranger@evil.ru'] })).toMatch(refused);
  });

  test('one external recipient among internal ones refuses the draft', () => {
    expect(
      denial('gmail__create_draft', { to: ['colleague@myorg.com', 'stranger@evil.ru'] }),
    ).toMatch(refused);
    expect(
      denial('gmail__create_draft', { to: ['colleague@myorg.com'], bcc: 'stranger@evil.ru' }),
    ).toMatch(refused);
  });

  test('a mailbox without zoning metadata refuses every draft but one to itself', () => {
    const bare: Resource = { service: 'gmail', ref: 'me@myorg.com', displayName: 'me@myorg.com' };
    expect(denial('gmail__create_draft', { to: ['colleague@myorg.com'] }, bare)).toMatch(refused);
    expect(classify('gmail__create_draft', { to: ['me@myorg.com'] }, bare)).toContain(
      toZone('self'),
    );
  });
});

describe('classifyGmail — create_draft refuses a recipient it cannot parse', () => {
  test.each([
    ['two addresses in one array element', { to: ['evil@evil.ru, colleague@myorg.com'] }],
    ['an address after a display-name form', { to: ['Bob <colleague@myorg.com>, evil@evil.ru'] }],
    ['an address in the display name', { to: ['evil@evil.ru, Bob <colleague@myorg.com>'] }],
    ['two bracket pairs', { to: ['"<colleague@myorg.com>" <evil@evil.ru>'] }],
    ['an address in a quoted display name', { to: ['"evil@evil.ru," <colleague@myorg.com>'] }],
    ['a semicolon-separated string', { to: 'evil@evil.ru; colleague@myorg.com' }],
    ['a comma-separated string', { to: 'colleague@myorg.com, partner@vendor.com' }],
    ['an object element', { to: [{ email: 'evil@evil.ru' }] }],
    ['a word that is not an address', { to: ['evil'] }],
    ['an empty string', { to: [''] }],
    ['a field that is neither a string nor a list', { to: ['me@myorg.com'], cc: 42 }],
    ['an object field', { bcc: { email: 'evil@evil.ru' } }],
    ['a comma in the local part', { to: ['x,colleague@myorg.com'] }],
    ['a domain without a dot', { to: ['colleague@myorg'] }],
  ])('%s → denied', (_name, args) => {
    expect(denial('gmail__create_draft', args)).toMatch(/^(to|cc|bcc): /);
  });
});

describe('classifyGmail — label_message / unlabel_message', () => {
  const args = { thread_id: 'aa01', message_id: 'bb02', label: 'IMPORTANT' };
  const SLICE = 'gmail.mailbox.thread[aa01].message[bb02].label.W';

  test('label_message → thread[T].message[M].label.W', () => {
    expect(classify('gmail__label_message', args)).toEqual([SLICE]);
  });

  test('unlabel_message → same shape', () => {
    expect(classify('gmail__unlabel_message', args)).toEqual([SLICE]);
  });

  test.each(['gmail__label_message', 'gmail__unlabel_message'])(
    '%s requires well-formed thread_id, message_id and label',
    (tool) => {
      expect(denial(tool, { ...args, thread_id: undefined })).toMatch(/^thread_id: /);
      expect(denial(tool, { ...args, thread_id: '*' })).toMatch(/^thread_id: /);
      expect(denial(tool, { ...args, message_id: undefined })).toMatch(/^message_id: /);
      expect(denial(tool, { ...args, message_id: 'm1].label.W' })).toMatch(/^message_id: /);
      expect(denial(tool, { ...args, label: undefined })).toMatch(/^label: /);
      expect(denial(tool, { ...args, label: ' x y' })).toMatch(/^label: /);
      expect(denial(tool, { ...args, label: 'x\ny' })).toMatch(/^label: /);
    },
  );
});

describe('classifyGmail — label_thread / unlabel_thread', () => {
  const TOOLS = ['gmail__label_thread', 'gmail__unlabel_thread'] as const;
  const SLICE = 'gmail.mailbox.thread[aa01].label.W';

  test.each(TOOLS)('%s on a system label → thread[T].label.W', (tool) => {
    expect(classify(tool, { thread_id: 'aa01', label: 'STARRED' })).toEqual([SLICE]);
    expect(classify(tool, { thread_id: 'aa01', label: 'INBOX' })).toEqual([SLICE]);
  });

  test.each(TOOLS)('%s without a thread id → denied, never thread[*]', (tool) => {
    expect(denial(tool, { label: 'STARRED' })).toMatch(/^thread_id: /);
    expect(denial(tool, { thread_id: '', label: 'STARRED' })).toMatch(/^thread_id: /);
    expect(denial(tool, { thread_id: 'x].label.W', label: 'STARRED' })).toMatch(/^thread_id: /);
  });

  test.each(TOOLS)('%s without a label → denied', (tool) => {
    expect(denial(tool, { thread_id: 'aa01' })).toMatch(/^label: /);
    expect(denial(tool, { thread_id: 'aa01', label: 7 })).toMatch(/^label: /);
  });

  test.each([
    ['gmail__label_thread', 'TRASH'],
    ['gmail__label_thread', 'SPAM'],
    ['gmail__label_thread', 'trash'],
    ['gmail__unlabel_thread', 'TRASH'],
    ['gmail__label_message', 'Spam'],
  ])('%s with %s → denied (a deletion is not a label write)', (tool, label) => {
    expect(denial(tool, { thread_id: 'aa01', message_id: 'bb02', label })).toMatch(/^label: /);
  });

  test.each(TOOLS)('%s on a sensitive label adds sensitive-label[L].W', (tool) => {
    expect(classify(tool, { thread_id: 'aa01', label: 'LEGAL' })).toEqual([
      SLICE,
      sensitiveW('LEGAL'),
    ]);
    expect(classify(tool, { thread_id: 'aa01', label: 'hr' })).toEqual([SLICE, sensitiveW('HR')]);
    expect(classify(tool, { thread_id: 'aa01', label: 'legal/contracts' })).toEqual([
      SLICE,
      sensitiveW('LEGAL'),
    ]);
  });

  test.each(TOOLS)(
    '%s on a user label id the classifier cannot resolve is treated as sensitive',
    (tool) => {
      expect(classify(tool, { thread_id: 'aa01', label: 'Label_42' })).toEqual([
        SLICE,
        sensitiveW('*'),
      ]);
      // A system label spelled in another case is not a system label id.
      expect(classify(tool, { thread_id: 'aa01', label: 'Important' })).toEqual([
        SLICE,
        sensitiveW('*'),
      ]);
    },
  );

  test.each(TOOLS)(
    '%s on a user label when no sensitive label is declared → label.W only',
    (tool) => {
      expect(classify(tool, { thread_id: 'aa01', label: 'Label_42' }, plainMailbox)).toEqual([
        SLICE,
      ]);
    },
  );
});

describe('classifyGmail — denials', () => {
  test('unknown tool → denied', () => {
    const result = classifyGmail('gmail__bogus', {}, [mailbox]);
    expect(result).toEqual({ denied: "unknown gmail tool 'gmail__bogus'." });
  });

  test('no gmail mailbox in the mission → denied', () => {
    const result = classifyGmail('gmail__search_threads', { q: 'is:unread' }, []);
    expect(result).toEqual({ denied: 'no gmail mailbox is a resource of this mission.' });
  });
});

describe('classifyGmail — automated senders (exact local part of a full address)', () => {
  test('from:notifications@myorg.com → automated (trumps internal)', () => {
    expect(search('from:notifications@myorg.com')).toEqual([LABEL_R, fromZone('automated')]);
  });

  test('from:alerts@vendor.com → automated on an allowlisted domain', () => {
    expect(search('from:alerts@vendor.com')).toEqual([LABEL_R, fromZone('automated')]);
  });

  test.each(['alerts@somewhere.io', 'support@attacker.example', 'no-reply@github.com'])(
    'from:%s — an automated local part on a domain nobody listed is chosen by the sender → unknown',
    (address) => {
      expect(search(`from:${address}`)).toEqual([LABEL_R, fromZone('unknown')]);
    },
  );

  test.each([
    'supportive.ceo@myorg.com',
    'alerts.boss@myorg.com',
    'ceo-support@myorg.com',
    'no-reply+ceo@myorg.com',
  ])('from:%s contains an automated word but is a person → internal', (address) => {
    expect(search(`from:${address}`)).toEqual([LABEL_R, fromZone('internal')]);
  });

  test('a local part that only contains an automated word, on an unknown domain → unknown', () => {
    expect(search('from:supportive@somewhere.io')).toEqual([LABEL_R, fromZone('unknown')]);
  });

  test.each(['support', 'alerts', 'notifications', 'no-reply'])(
    'bare from:%s matches any sender containing the word → unknown + bulk-marker',
    (word) => {
      expect(search(`from:${word}`)).toEqual([LABEL_R, fromZone('unknown'), BULK_R]);
    },
  );

  test('classifyFromAddress : a value that is not one full address is unknown', () => {
    const md = readMailboxMetadata(mailbox);
    expect(classifyFromAddress('support', md)).toBe('unknown');
    expect(classifyFromAddress('support@', md)).toBe('unknown');
    expect(classifyFromAddress('evil@evil.ru,boss@myorg.com', md)).toBe('unknown');
    expect(classifyFromAddress('Support@Vendor.com', md)).toBe('automated');
    expect(classifyFromAddress('Support@GitHub.com', md)).toBe('unknown');
    expect(classifyFromAddress('Boss@MyOrg.com', md)).toBe('internal');
  });
});

describe('classifyGmail — mailbox without metadata defaults safely', () => {
  test('classification falls back to from-zone[unknown] when no metadata is set', () => {
    const noMd: Resource = {
      service: 'gmail',
      ref: 'me@myorg.com',
      displayName: 'me@myorg.com',
      env: null,
    };
    // Without internal_domains, colleague@myorg.com is just unknown.
    expect(search('from:colleague@myorg.com', noMd)).toEqual([LABEL_R, fromZone('unknown')]);
  });
});

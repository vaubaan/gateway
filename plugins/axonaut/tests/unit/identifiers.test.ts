/**
 * Hostile identifiers in every id position of `classify` and of `execute`
 * (ADR plugin-identifiers-one-grammar-for-classify-and-execute): the account,
 * every record id of a path, every id of a body or a query, and the product
 * ids nested in quotation and invoice lines. A refused value sends nothing;
 * an accepted one is named exactly, in the slice and in the request.
 */
import { describe, expect, test } from 'vitest';

import { serializeSlice } from '@vaubaan/plugin-sdk';
import { declaredOnly, mockFetch } from '@vaubaan/plugin-sdk/testing';

import { classifyAxonaut } from '../../src/classify.ts';
import { executeAxonaut, AXONAUT_API_BASE } from '../../src/execute.ts';
import { TOOL } from '../../src/identity.ts';
import { axonautPlugin } from '../../src/index.ts';
import { ACCOUNT, account, ctx } from './fixtures.ts';

const HOSTILE = [
  '..',
  '.',
  'a/../b',
  '%2e%2e',
  '..%2f',
  '%2f',
  '33/..',
  '33/../34',
  '33\n',
  '33?x=1#y',
  ' 33',
  '033',
  '-33',
  '3.3',
  '1e3',
  '*',
  '',
  '9'.repeat(16),
];

const line = { name: 'Audit day', price: 900, quantity: 2, tax_rate: 20 };

/** Every id argument, with a call that is otherwise valid. */
const POSITIONS: readonly (readonly [string, string, Record<string, unknown>])[] = [
  [TOOL.getCompany, 'company_id', {}],
  [TOOL.listContacts, 'company_id', {}],
  [TOOL.listEvents, 'company_id', {}],
  [TOOL.listOpportunities, 'company_id', {}],
  [TOOL.listQuotations, 'company_id', {}],
  [TOOL.listInvoices, 'company_id', {}],
  [TOOL.listTickets, 'company_id', {}],
  [TOOL.listPayments, 'invoice_id', {}],
  [TOOL.getContact, 'contact_id', {}],
  [TOOL.getOpportunity, 'opportunity_id', {}],
  [TOOL.getQuotation, 'quotation_id', {}],
  [TOOL.getInvoice, 'invoice_id', {}],
  [TOOL.getProject, 'project_id', {}],
  [TOOL.getTask, 'task_id', {}],
  [TOOL.getTicket, 'ticket_id', {}],
  [TOOL.getProduct, 'product_id', {}],
  [TOOL.updateCompany, 'company_id', { name: 'n' }],
  [TOOL.createContact, 'company_id', { lastname: 'R' }],
  [TOOL.updateContact, 'contact_id', { lastname: 'R' }],
  [TOOL.createEvent, 'company_id', { title: 't', nature: 6 }],
  [TOOL.createEvent, 'opportunity_id', { company_id: '33', title: 't', nature: 6 }],
  [TOOL.createOpportunity, 'company_id', { name: 'n' }],
  [TOOL.updateOpportunity, 'opportunity_id', { name: 'n' }],
  [TOOL.setOpportunityOutcome, 'opportunity_id', { outcome: 'won' }],
  [TOOL.createTask, 'project_id', { title: 't' }],
  [TOOL.createTask, 'company_id', { title: 't' }],
  [TOOL.updateTask, 'task_id', { title: 't' }],
  [TOOL.updateTask, 'task_status_id', { task_id: '61' }],
  [TOOL.createTicket, 'company_id', { title: 't' }],
  [TOOL.updateTicket, 'ticket_id', { title: 't' }],
  [TOOL.updateTicket, 'project_id', { ticket_id: '19' }],
  [TOOL.addTicketComment, 'ticket_id', { text: 't' }],
  [TOOL.createQuotation, 'company_id', { products: [line] }],
  [TOOL.createQuotation, 'opportunity_id', { company_id: '33', products: [line] }],
  [TOOL.setQuotationOutcome, 'quotation_id', { outcome: 'accepted' }],
  [TOOL.createInvoice, 'company_id', { products: [line] }],
  [TOOL.createInvoice, 'project_id', { company_id: '33', products: [line] }],
  [TOOL.recordPayment, 'invoice_id', { amount: 1, nature: 2, date: '2026-11-05' }],
  [TOOL.deleteCompany, 'company_id', {}],
  [TOOL.deleteContact, 'contact_id', {}],
  [TOOL.deleteOpportunity, 'opportunity_id', {}],
  [TOOL.deleteTask, 'task_id', {}],
];

describe('record ids', () => {
  test.each(POSITIONS)(
    '%s — %s : refused by classify and by execute, nothing sent',
    async (tool, argument, rest) => {
      for (const hostile of HOSTILE) {
        const args = declaredOnly(axonautPlugin, tool, { ...rest, [argument]: hostile });
        const outcome = classifyAxonaut(tool, args, [account]);
        expect(
          'denied' in outcome ? outcome.denied : '',
          `${tool} ${argument}=${JSON.stringify(hostile)}`,
        ).toBe(`${argument}: malformed Axonaut id`);
        const fetch = mockFetch([]);
        const result = await executeAxonaut(ctx(fetch), tool, args);
        expect(result.isError).toBe(true);
        expect(fetch.calls).toEqual([]);
      }
    },
  );

  test('an accepted id is the one the slice and the request name', async () => {
    const outcome = classifyAxonaut(TOOL.deleteTask, { task_id: 61 }, [account]);
    expect('slices' in outcome ? outcome.slices.map(serializeSlice) : []).toEqual([
      `axonaut.account[${ACCOUNT}].task[61].W`,
      `axonaut.account[${ACCOUNT}].task[61].delete.W`,
    ]);
    const fetch = mockFetch([
      { method: 'DELETE', url: `${AXONAUT_API_BASE}/tasks/61`, status: 200 },
    ]);
    await executeAxonaut(ctx(fetch), TOOL.deleteTask, { task_id: 61 });
    expect(fetch.calls.map((c) => c.url)).toEqual([`${AXONAUT_API_BASE}/tasks/61`]);
  });
});

describe('the account and nested ids', () => {
  test('the account : refused when malformed, whatever the mission holds', async () => {
    for (const hostile of HOSTILE) {
      expect(classifyAxonaut(TOOL.getTask, { account: hostile, task_id: '61' }, [account])).toEqual(
        { denied: 'account: malformed Axonaut id' },
      );
      const fetch = mockFetch([]);
      const result = await executeAxonaut(ctx(fetch), TOOL.getTask, {
        account: hostile,
        task_id: '61',
      });
      expect(result.isError).toBe(true);
      expect(fetch.calls).toEqual([]);
    }
  });

  test('a product id inside a line : refused on both sides, nothing sent', async () => {
    for (const hostile of HOSTILE) {
      for (const tool of [TOOL.createQuotation, TOOL.createInvoice]) {
        const args = { company_id: '33', products: [{ ...line, product_id: hostile }] };
        expect(classifyAxonaut(tool, args, [account])).toEqual({
          denied: 'products[0].product_id: malformed Axonaut id',
        });
        const fetch = mockFetch([]);
        expect((await executeAxonaut(ctx(fetch), tool, args)).isError).toBe(true);
        expect(fetch.calls).toEqual([]);
      }
    }
  });

  test('free text never reaches the path: a hostile search is a query value, encoded', async () => {
    const fetch = mockFetch([{ method: 'GET', url: /\/companies\?/, body: [] }]);
    await executeAxonaut(ctx(fetch), TOOL.listCompanies, { search: '../%2e%2e?x=1#y' });
    const url = new URL(fetch.calls[0]!.url);
    expect(url.pathname).toBe('/api/v2/companies');
    expect(url.searchParams.get('search')).toBe('../%2e%2e?x=1#y');
  });
});

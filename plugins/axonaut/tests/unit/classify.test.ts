/**
 * The classifier, branch by branch: the slices of every tool, the refusals
 * (unknown tool, account outside the mission, ambiguous or malformed account,
 * missing or malformed arguments, an update that changes nothing), and which
 * risks the layered slices touch. Cases written from Axonaut's OpenAPI file
 * (doc.json, read 2026-11-05).
 */
import { describe, expect, test } from 'vitest';

import { parseSlice, serializeSlice, toolPrefixFor, type Resource } from '@vaubaan/plugin-sdk';
import { risksTouchedBy } from '@vaubaan/plugin-sdk/testing';

import { classifyAxonaut } from '../../src/classify.ts';
import { SERVICE_ID, TOOL } from '../../src/identity.ts';
import { axonautCatalog } from '../../src/index.ts';
import { ACCOUNT, account, otherAccount } from './fixtures.ts';

const A = `${SERVICE_ID}.account[${ACCOUNT}]`;

function slices(
  tool: string,
  args: Record<string, unknown>,
  resources: readonly Resource[] = [account],
): string[] {
  const out = classifyAxonaut(tool, args, resources);
  if ('denied' in out) throw new Error(out.denied);
  return out.slices.map(serializeSlice);
}

function denied(
  tool: string,
  args: Record<string, unknown>,
  resources: readonly Resource[] = [account],
): string {
  const out = classifyAxonaut(tool, args, resources);
  return 'denied' in out ? out.denied : `classified: ${JSON.stringify(out.slices)}`;
}

function risks(slice: string): string[] {
  return [...risksTouchedBy(parseSlice(slice), axonautCatalog.indexed)].sort();
}

describe('reads', () => {
  test.each([
    [TOOL.listCompanies, {}, [`${A}.company[*].R`]],
    [TOOL.getCompany, { company_id: '33' }, [`${A}.company[33].R`]],
    [TOOL.listContacts, { company_id: '33' }, [`${A}.company[33].R`, `${A}.contact[*].R`]],
    [TOOL.getContact, { contact_id: '81' }, [`${A}.contact[81].R`]],
    [TOOL.listEvents, { company_id: '33' }, [`${A}.company[33].R`, `${A}.event[*].R`]],
    [TOOL.listOpportunities, {}, [`${A}.opportunity[*].R`]],
    [TOOL.listOpportunities, { company_id: '33' }, [`${A}.company[33].R`, `${A}.opportunity[*].R`]],
    [TOOL.getOpportunity, { opportunity_id: '12' }, [`${A}.opportunity[12].R`]],
    [TOOL.listQuotations, {}, [`${A}.quotation[*].R`]],
    [TOOL.listQuotations, { company_id: '33' }, [`${A}.company[33].R`, `${A}.quotation[*].R`]],
    [TOOL.getQuotation, { quotation_id: '55' }, [`${A}.quotation[55].R`]],
    [TOOL.listInvoices, {}, [`${A}.invoice[*].R`]],
    [TOOL.listInvoices, { company_id: '33' }, [`${A}.company[33].R`, `${A}.invoice[*].R`]],
    [TOOL.getInvoice, { invoice_id: '90' }, [`${A}.invoice[90].R`]],
    [TOOL.listPayments, {}, [`${A}.payment[*].R`]],
    [TOOL.listPayments, { invoice_id: '90' }, [`${A}.invoice[90].R`, `${A}.payment[*].R`]],
    [TOOL.listProjects, {}, [`${A}.project[*].R`]],
    [TOOL.getProject, { project_id: '7' }, [`${A}.project[7].R`]],
    [TOOL.listTasks, {}, [`${A}.task[*].R`]],
    [TOOL.getTask, { task_id: '61' }, [`${A}.task[61].R`]],
    [TOOL.listTickets, {}, [`${A}.ticket[*].R`]],
    [TOOL.listTickets, { company_id: '33' }, [`${A}.company[33].R`, `${A}.ticket[*].R`]],
    [TOOL.getTicket, { ticket_id: '19' }, [`${A}.ticket[19].R`]],
    [TOOL.listProducts, {}, [`${A}.product[*].R`]],
    [TOOL.getProduct, { product_id: '73' }, [`${A}.product[73].R`]],
  ] as const)('%s %j', (tool, args, expected) => {
    expect(slices(tool, { ...args })).toEqual(expected);
  });

  test('each read family touches its own risk, and only it', () => {
    expect(risks(`${A}.contact[*].R`)).toEqual(['axonaut.read-crm']);
    expect(risks(`${A}.event[*].R`)).toEqual(['axonaut.read-crm']);
    expect(risks(`${A}.invoice[90].R`)).toEqual(['axonaut.read-sales']);
    expect(risks(`${A}.payment[*].R`)).toEqual(['axonaut.read-sales']);
    expect(risks(`${A}.ticket[*].R`)).toEqual(['axonaut.read-work']);
    expect(risks(`${A}.product[*].R`)).toEqual(['axonaut.read-catalog']);
    // A list of one company's invoices reads that company too: the CRM read is needed.
    const [company] = slices(TOOL.listInvoices, { company_id: '33' });
    expect(risks(company!)).toEqual(['axonaut.read-crm']);
  });
});

describe('writes', () => {
  test.each([
    [TOOL.createCompany, { name: 'Globex' }, [`${A}.company.W`]],
    [TOOL.updateCompany, { company_id: '33', name: 'Globex' }, [`${A}.company[33].W`]],
    [TOOL.createContact, { company_id: '33', lastname: 'Rousseau' }, [`${A}.contact.W`]],
    [TOOL.updateContact, { contact_id: '81', email: 'c@globex.fr' }, [`${A}.contact[81].W`]],
    [TOOL.createEvent, { company_id: '33', title: 'Call', nature: 3 }, [`${A}.event.W`]],
    [TOOL.createOpportunity, { company_id: '33', name: 'Deal' }, [`${A}.opportunity.W`]],
    [TOOL.updateOpportunity, { opportunity_id: '12', amount: 10 }, [`${A}.opportunity[12].W`]],
    [
      TOOL.setOpportunityOutcome,
      { opportunity_id: '12', outcome: 'lost' },
      [`${A}.opportunity[12].outcome.W`],
    ],
    [TOOL.createTask, { title: 'Do' }, [`${A}.task.W`]],
    [TOOL.updateTask, { task_id: '61', task_status_id: '3' }, [`${A}.task[61].W`]],
    [TOOL.createTicket, { title: 'Bug' }, [`${A}.ticket.W`]],
    [TOOL.updateTicket, { ticket_id: '19', priority: 'urgente' }, [`${A}.ticket[19].W`]],
    [TOOL.addTicketComment, { ticket_id: '19', text: 'x' }, [`${A}.ticket[19].comment.W`]],
    [TOOL.createQuotation, { company_id: '33', products: [line()] }, [`${A}.quotation.W`]],
    [
      TOOL.setQuotationOutcome,
      { quotation_id: '55', outcome: 'refused' },
      [`${A}.quotation[55].outcome.W`],
    ],
    [TOOL.createInvoice, { company_id: '33', products: [line()] }, [`${A}.invoice.W`]],
    [
      TOOL.recordPayment,
      { invoice_id: '90', amount: 5, nature: 5, date: '2026-11-05' },
      [`${A}.payment.W`],
    ],
    [TOOL.deleteCompany, { company_id: '33' }, [`${A}.company[33].W`, `${A}.company[33].delete.W`]],
    [TOOL.deleteContact, { contact_id: '81' }, [`${A}.contact[81].W`, `${A}.contact[81].delete.W`]],
    [
      TOOL.deleteOpportunity,
      { opportunity_id: '12' },
      [`${A}.opportunity[12].W`, `${A}.opportunity[12].delete.W`],
    ],
    [TOOL.deleteTask, { task_id: '61' }, [`${A}.task[61].W`, `${A}.task[61].delete.W`]],
  ] as const)('%s', (tool, args, expected) => {
    expect(slices(tool, { ...args })).toEqual(expected);
  });

  test('a deletion needs the write of the record and the deletion; an ordinary write never the deletion', () => {
    const [write, deletion] = slices(TOOL.deleteContact, { contact_id: '81' });
    expect(risks(write!)).toEqual(['axonaut.crm-write']);
    expect(risks(deletion!)).toEqual(['axonaut.delete-record']);
    const [taskWrite, taskDeletion] = slices(TOOL.deleteTask, { task_id: '61' });
    expect(risks(taskWrite!)).toEqual(['axonaut.work-write']);
    expect(risks(taskDeletion!)).toEqual(['axonaut.delete-record']);
    expect(risks(slices(TOOL.updateTask, { task_id: '61', title: 't' })[0]!)).toEqual([
      'axonaut.work-write',
    ]);
  });

  test('an outcome touches its own risk alone, not the ordinary write', () => {
    const [won] = slices(TOOL.setOpportunityOutcome, { opportunity_id: '12', outcome: 'won' });
    expect(risks(won!)).toEqual(['axonaut.opportunity-outcome']);
    const [accepted] = slices(TOOL.setQuotationOutcome, {
      quotation_id: '55',
      outcome: 'accepted',
    });
    expect(risks(accepted!)).toEqual(['axonaut.quotation-outcome']);
  });

  test('sales writes touch their own risk: an invoice is never a quotation', () => {
    expect(risks(`${A}.invoice.W`)).toEqual(['axonaut.invoice-create']);
    expect(risks(`${A}.quotation.W`)).toEqual(['axonaut.quotation-create']);
    expect(risks(`${A}.payment.W`)).toEqual(['axonaut.payment-record']);
    expect(risks(`${A}.ticket[19].comment.W`)).toEqual(['axonaut.work-write']);
    expect(risks(`${A}.event.W`)).toEqual(['axonaut.crm-write']);
  });
});

describe('the account', () => {
  test('a named account must be one of the mission resources; absent, the single one', () => {
    expect(slices(TOOL.getTask, { account: '777', task_id: '1' }, [account, otherAccount])).toEqual(
      [`${SERVICE_ID}.account[777].task[1].R`],
    );
    expect(slices(TOOL.getTask, { task_id: '1' })).toEqual([`${A}.task[1].R`]);
    expect(denied(TOOL.getTask, { account: '777', task_id: '1' })).toBe(
      "account '777' is not selected in this mission",
    );
    // A resource of another service carrying the same ref does not count.
    const foreign: Resource = { service: 'other', ref: '777', displayName: 'Foreign' };
    expect(denied(TOOL.getTask, { account: '777', task_id: '1' }, [account, foreign])).toBe(
      "account '777' is not selected in this mission",
    );
  });

  test('refuses an ambiguous, absent or malformed account', () => {
    expect(denied(TOOL.listTasks, {}, [account, otherAccount])).toBe(
      'account: argument missing and the mission holds 2 Axonaut accounts — name one',
    );
    expect(denied(TOOL.listTasks, {}, [])).toMatch(/holds no Axonaut account/);
    for (const hostile of ['..', '%2e%2e', '4242/..', '04242', '-1', '', 4.2, null, true]) {
      expect(denied(TOOL.listTasks, { account: hostile })).toBe('account: malformed Axonaut id');
    }
    const dotted: Resource = { service: SERVICE_ID, ref: '..', displayName: 'Dots' };
    expect(denied(TOOL.listTasks, {}, [dotted])).toBe(
      'account: the mission resource is not an Axonaut account id',
    );
  });

  test('an id given as a JSON number is the same id', () => {
    expect(slices(TOOL.getCompany, { account: 4242, company_id: 33 })).toEqual([
      `${A}.company[33].R`,
    ]);
  });
});

describe('refusals', () => {
  test('an unknown tool', () => {
    const unknown = `${toolPrefixFor(SERVICE_ID)}send_event`;
    expect(denied(unknown, { company_id: '1' })).toBe(`unknown ${SERVICE_ID} tool '${unknown}'`);
  });

  test('a missing or malformed identifier, never escaped', () => {
    expect(denied(TOOL.getCompany, {})).toBe('company_id: missing');
    for (const hostile of ['..', '.', 'a/b', '%2f', '1 ', '', '01', 'x'.repeat(16), 1.5, -3]) {
      expect(denied(TOOL.getCompany, { company_id: hostile })).toBe(
        'company_id: malformed Axonaut id',
      );
      expect(denied(TOOL.deleteCompany, { company_id: hostile })).toBe(
        'company_id: malformed Axonaut id',
      );
    }
    expect(denied(TOOL.createTask, { title: 't', project_id: '7/..' })).toBe(
      'project_id: malformed Axonaut id',
    );
  });

  test('an outcome outside its values', () => {
    expect(denied(TOOL.setOpportunityOutcome, { opportunity_id: '1', outcome: 'won/..' })).toBe(
      'outcome: expected one of won, lost',
    );
    expect(denied(TOOL.setQuotationOutcome, { quotation_id: '1', outcome: 'won' })).toBe(
      'outcome: expected one of accepted, refused',
    );
  });

  test('an update that changes nothing', () => {
    for (const [tool, args] of [
      [TOOL.updateCompany, { company_id: '1' }],
      [TOOL.updateContact, { contact_id: '1' }],
      [TOOL.updateOpportunity, { opportunity_id: '1' }],
      [TOOL.updateTask, { task_id: '1' }],
      [TOOL.updateTicket, { ticket_id: '1' }],
    ] as const) {
      expect(denied(tool, { ...args })).toMatch(/^nothing to update/);
    }
  });

  test('values outside their kind', () => {
    expect(denied(TOOL.createCompany, { name: 'a\u0000b' })).toBe(
      'name: control characters are not accepted',
    );
    expect(denied(TOOL.createCompany, { name: 'x'.repeat(256) })).toMatch(/^name: expected/);
    expect(denied(TOOL.createContact, { company_id: '1', lastname: 'R', email: 'a@b, c@d' })).toBe(
      'email: expected one e-mail address',
    );
    expect(denied(TOOL.createEvent, { company_id: '1', title: 't', nature: 7 })).toBe(
      'nature: expected one of 1, 2, 3, 4, 5, 6',
    );
    expect(denied(TOOL.updateOpportunity, { opportunity_id: '1', probability: 101 })).toMatch(
      /^probability: expected a number from 0 to 100/,
    );
    expect(denied(TOOL.updateOpportunity, { opportunity_id: '1', amount: Infinity })).toMatch(
      /^amount: expected a number/,
    );
    expect(denied(TOOL.updateTask, { task_id: '1', end_date: '2026-11-25' })).toBe(
      'end_date: expected a date written DD/MM/YYYY',
    );
    expect(
      denied(TOOL.recordPayment, { invoice_id: '1', amount: 1, nature: 2, date: '05/11/2026' }),
    ).toMatch(/^date: expected an ISO 8601 date/);
    expect(denied(TOOL.listCompanies, { page: 0 })).toMatch(/^page: expected an integer/);
    expect(denied(TOOL.listCompanies, { is_customer: 'true' })).toBe(
      'is_customer: expected true or false',
    );
  });

  test('product lines: at least one, each complete, ids by the grammar', () => {
    expect(denied(TOOL.createInvoice, { company_id: '1', products: [] })).toMatch(
      /^products: expected 1 to 200 product lines/,
    );
    expect(
      denied(TOOL.createInvoice, { company_id: '1', products: [{ name: 'x', price: 1 }] }),
    ).toMatch(/^products\[0\]\.quantity/);
    expect(
      denied(TOOL.createQuotation, {
        company_id: '1',
        products: [{ ...line(), product_id: '..' }],
      }),
    ).toBe('products[0].product_id: malformed Axonaut id');
    expect(denied(TOOL.createQuotation, { company_id: '1', products: ['x'] })).toBe(
      'products[0]: expected an object',
    );
  });

  test('an argument the tool does not declare is ignored, never classified or sent', () => {
    expect(slices(TOOL.getCompany, { company_id: '33', iban: 'FR76…' })).toEqual([
      `${A}.company[33].R`,
    ]);
  });

  test('emitted slices parse back (round-trip)', () => {
    for (const s of slices(TOOL.deleteOpportunity, { opportunity_id: '12' })) {
      expect(serializeSlice(parseSlice(s))).toBe(s);
    }
  });
});

function line() {
  return { name: 'Audit day', price: 900, quantity: 2, tax_rate: 20 };
}

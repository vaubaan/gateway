/**
 * `execute` and `discoverResources` against `mockFetch`: the request sent
 * (method, URL, headers, body), the failures thrown, the declines with no
 * request sent, and the payloads discovery refuses. Routes follow Axonaut's
 * OpenAPI file (doc.json, read 2026-11-05).
 */
import { describe, expect, test } from 'vitest';

import { UpstreamProtocolError, toolPrefixFor } from '@vaubaan/plugin-sdk';
import { mockFetch, refusalText } from '@vaubaan/plugin-sdk/testing';

import { API_KEY_HEADER, AXONAUT_API_BASE } from '../../src/execute.ts';
import { API_KEY_FIELD, PROVIDER_ID, TOOL } from '../../src/identity.ts';
import { axonautPlugin } from '../../src/index.ts';
import { ACCOUNT, KEY, account, ctx, otherAccount } from './fixtures.ts';

const API = AXONAUT_API_BASE;
const run = (fetch: typeof globalThis.fetch, tool: string, args: Record<string, unknown>) =>
  axonautPlugin.execute(ctx(fetch), tool, args);
const textOf = (result: { content: readonly unknown[] }): unknown =>
  JSON.parse((result.content[0] as { text: string }).text);

const ME = {
  id: 58962,
  email: 'claire@acme.fr',
  fullname: 'Claire Rousseau',
  roles: 'ROLE_ADMIN',
  user_api_key: KEY,
  api_time_consumed: 12,
  account: [{ id: 4242, company_name: 'Acme SAS', company_siret: '123' }],
};

describe('reads', () => {
  test('sends the key in the userApiKey header and returns the answer', async () => {
    const fetch = mockFetch([
      { method: 'GET', url: `${API}/companies/33`, body: { id: 33, name: 'Globex' } },
    ]);
    const result = await run(fetch, TOOL.getCompany, { company_id: '33' });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toEqual({ id: 33, name: 'Globex' });
    expect(fetch.calls[0]!.headers[API_KEY_HEADER.toLowerCase()]).toBe(KEY);
    expect(fetch.calls[0]!.headers.authorization).toBeUndefined();
  });

  test('filters go in the query, the page in a header, as the OpenAPI file declares', async () => {
    const fetch = mockFetch([{ method: 'GET', url: /\/companies\?/, body: [] }]);
    await run(fetch, TOOL.listCompanies, {
      search: 'Globex & Co',
      is_customer: true,
      city: 'Toulouse',
      page: 2,
    });
    const url = new URL(fetch.calls[0]!.url);
    expect(url.pathname).toBe('/api/v2/companies');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      search: 'Globex & Co',
      is_customer: 'true',
      address_city: 'Toulouse',
    });
    expect(fetch.calls[0]!.headers.page).toBe('2');
  });

  test('a list without filter sends no query and no page', async () => {
    const fetch = mockFetch([{ method: 'GET', url: `${API}/tasks`, body: [] }]);
    await run(fetch, TOOL.listTasks, {});
    expect(fetch.calls[0]!.url).toBe(`${API}/tasks`);
    expect(fetch.calls[0]!.headers.page).toBeUndefined();
  });

  test.each([
    [TOOL.listContacts, { company_id: '33' }, `${API}/companies/33/employees`],
    [TOOL.listEvents, { company_id: '33' }, `${API}/companies/33/events`],
    [TOOL.listOpportunities, { company_id: '33' }, `${API}/companies/33/opportunities`],
    [TOOL.listOpportunities, { status: 'archived' }, `${API}/opportunities?status=archived`],
    [TOOL.listQuotations, { company_id: '33' }, `${API}/companies/33/quotations`],
    [
      TOOL.listInvoices,
      { company_id: '33', is_paid: false },
      `${API}/companies/33/invoices?is_paid=false`,
    ],
    [TOOL.listPayments, { invoice_id: '90' }, `${API}/payments?invoice_id=90`],
    [TOOL.listTickets, { company_id: '33' }, `${API}/tickets?company_id=33`],
    [TOOL.listProjects, { name: 'Web' }, `${API}/projects?name=Web`],
    [TOOL.listProducts, {}, `${API}/products`],
    [TOOL.getContact, { contact_id: '81' }, `${API}/employees/81`],
    [TOOL.getQuotation, { quotation_id: '55' }, `${API}/quotations/55`],
    [TOOL.getInvoice, { invoice_id: '90' }, `${API}/invoices/90`],
    [TOOL.getProduct, { product_id: '73' }, `${API}/products/73`],
  ] as const)('%s %j → GET %s', async (tool, args, url) => {
    const fetch = mockFetch([{ method: 'GET', url, body: [] }]);
    await run(fetch, tool, { ...args });
    expect(fetch.calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${url}`]);
  });
});

describe('writes are built field by field', () => {
  test('create_company: the declared fields, nothing else', async () => {
    const fetch = mockFetch([{ method: 'POST', url: `${API}/companies`, body: { id: 34 } }]);
    await run(fetch, TOOL.createCompany, {
      name: 'Globex',
      address_city: 'Toulouse',
      is_prospect: true,
      iban: 'FR1420041010050500013M02606',
      employees: [{ email: 'x@y.z' }],
    });
    expect(fetch.calls[0]!.json).toEqual({
      name: 'Globex',
      address_city: 'Toulouse',
      is_prospect: true,
    });
  });

  test('create_contact sends the company id as the number Axonaut declares', async () => {
    const fetch = mockFetch([{ method: 'POST', url: `${API}/employees`, body: { id: 82 } }]);
    await run(fetch, TOOL.createContact, { company_id: '33', lastname: 'Rousseau' });
    expect(fetch.calls[0]!.json).toEqual({ company_id: 33, lastname: 'Rousseau' });
  });

  test.each([
    [
      TOOL.updateCompany,
      { company_id: '33', comments: 'VIP' },
      'PATCH',
      `${API}/companies/33`,
      { comments: 'VIP' },
    ],
    [
      TOOL.updateContact,
      { contact_id: '81', email: 'c@globex.fr' },
      'PATCH',
      `${API}/employees/81`,
      { email: 'c@globex.fr' },
    ],
    [
      TOOL.createEvent,
      { company_id: '33', title: 'Call', nature: 3, opportunity_id: '12', date: '2026-11-05' },
      'POST',
      `${API}/events`,
      { company_id: 33, title: 'Call', nature: 3, date: '2026-11-05', opportunity_id: 12 },
    ],
    [
      TOOL.createOpportunity,
      { company_id: '33', name: 'Deal', amount: 1800, pipe_name: 'Sales' },
      'POST',
      `${API}/opportunities`,
      { company_id: 33, name: 'Deal', amount: 1800, pipe_name: 'Sales' },
    ],
    [
      TOOL.updateOpportunity,
      { opportunity_id: '12', probability: 80 },
      'PATCH',
      `${API}/opportunities/12`,
      { probability: 80 },
    ],
    [
      TOOL.setOpportunityOutcome,
      { opportunity_id: '12', outcome: 'won', date: '2026-11-05' },
      'PATCH',
      `${API}/opportunities/12/won`,
      { date: '2026-11-05' },
    ],
    [
      TOOL.setOpportunityOutcome,
      { opportunity_id: '12', outcome: 'lost' },
      'PATCH',
      `${API}/opportunities/12/lost`,
      {},
    ],
    [
      TOOL.createTask,
      { title: 'Do', project_id: '7', priority: 'haute', start_date: '05/11/2026' },
      'POST',
      `${API}/tasks`,
      { title: 'Do', priority: 'haute', project_id: 7, start_date: '05/11/2026' },
    ],
    [
      TOOL.updateTask,
      { task_id: '61', task_status_id: '3' },
      'PATCH',
      `${API}/tasks/61`,
      { task_status_id: 3 },
    ],
    [
      TOOL.createTicket,
      { title: 'Bug', company_id: '33' },
      'POST',
      `${API}/tickets`,
      { title: 'Bug', company_id: 33 },
    ],
    [
      TOOL.updateTicket,
      { ticket_id: '19', is_closed: true },
      'PATCH',
      `${API}/tickets/19`,
      { is_closed: true },
    ],
    [
      TOOL.addTicketComment,
      { ticket_id: '19', text: 'Line one\nline two' },
      'POST',
      `${API}/tickets/19/comments`,
      { text: 'Line one\nline two' },
    ],
    [
      TOOL.recordPayment,
      { invoice_id: '90', amount: 2160, nature: 2, date: '2026-11-05', reference: 'VIR-1' },
      'POST',
      `${API}/payments`,
      { invoice_id: 90, amount: 2160, nature: 2, date: '2026-11-05', reference: 'VIR-1' },
    ],
  ] as const)('%s → %s %s', async (tool, args, method, url, body) => {
    const fetch = mockFetch([{ method, url, body: { id: 1 } }]);
    await run(fetch, tool, { ...args });
    expect(fetch.calls.map((c) => `${c.method} ${c.url}`)).toEqual([`${method} ${url}`]);
    expect(fetch.calls[0]!.json).toEqual(body);
  });

  test('set_quotation_outcome sends no body', async () => {
    const fetch = mockFetch([
      { method: 'PATCH', url: `${API}/quotations/55/accepted`, body: { id: 55, contract_id: 9 } },
    ]);
    const result = await run(fetch, TOOL.setQuotationOutcome, {
      quotation_id: '55',
      outcome: 'accepted',
    });
    expect(fetch.calls[0]!.body).toBeNull();
    expect(textOf(result)).toEqual({ id: 55, contract_id: 9 });
  });

  test('quotation and invoice lines are rebuilt field by field; a catalog product id is a number', async () => {
    const fetch = mockFetch([
      { method: 'POST', url: `${API}/quotations`, body: { id: 56 } },
      { method: 'POST', url: `${API}/invoices`, body: { id: 91, number: 'FAC2026-11-00001' } },
    ]);
    const products = [
      {
        name: 'Audit day',
        price: 900,
        quantity: 2,
        tax_rate: 20,
        product_id: '73',
        unit: 'day',
        allow_stripe_payment: true,
      },
    ];
    const expected = [
      { name: 'Audit day', price: 900, quantity: 2, tax_rate: 20, id: 73, unit: 'day' },
    ];
    await run(fetch, TOOL.createQuotation, {
      company_id: '33',
      products,
      expiry_date: '2026-12-05',
    });
    await run(fetch, TOOL.createInvoice, {
      company_id: '33',
      products,
      due_date: '2026-12-05',
      allow_stripe_payment: true,
    });
    expect(fetch.calls[0]!.json).toEqual({
      company_id: 33,
      products: expected,
      expiry_date: '2026-12-05',
    });
    expect(fetch.calls[1]!.json).toEqual({
      company_id: 33,
      products: expected,
      due_date: '2026-12-05',
    });
  });

  test('a deletion answered without content becomes a confirmation', async () => {
    const fetch = mockFetch([
      { method: 'DELETE', url: `${API}/companies/33`, status: 202 },
      { method: 'DELETE', url: `${API}/employees/81`, status: 200 },
      { method: 'DELETE', url: `${API}/opportunities/12`, status: 200 },
      { method: 'DELETE', url: `${API}/tasks/61`, status: 200 },
    ]);
    expect(textOf(await run(fetch, TOOL.deleteCompany, { company_id: '33' }))).toEqual({
      deleted: 'company',
      id: '33',
    });
    expect(textOf(await run(fetch, TOOL.deleteContact, { contact_id: '81' }))).toEqual({
      deleted: 'contact',
      id: '81',
    });
    await run(fetch, TOOL.deleteOpportunity, { opportunity_id: '12' });
    await run(fetch, TOOL.deleteTask, { task_id: '61' });
    expect(fetch.calls.map((c) => c.method)).toEqual(['DELETE', 'DELETE', 'DELETE', 'DELETE']);
  });
});

describe('failures and declines', () => {
  test('a provider failure is thrown: 401 UpstreamAuthError, another status UpstreamHttpError', async () => {
    const rejected = mockFetch([{ url: /\/tasks$/, status: 401, body: { error: 'Unauthorized' } }]);
    await expect(run(rejected, TOOL.listTasks, {})).rejects.toMatchObject({
      name: 'UpstreamAuthError',
      upstreamStatus: 401,
    });
    const broken = mockFetch([{ url: /\/tasks$/, status: 500, body: { error: 'down' } }]);
    await expect(run(broken, TOOL.listTasks, {})).rejects.toMatchObject({
      name: 'UpstreamHttpError',
      status: 500,
    });
    const notJson = mockFetch([
      { url: /\/tasks$/, body: 'not json', headers: { 'content-type': 'text/plain' } },
    ]);
    await expect(run(notJson, TOOL.listTasks, {})).rejects.toBeInstanceOf(UpstreamProtocolError);
  });

  test('what the reader refuses is declined before any request', async () => {
    const fetch = mockFetch([]);
    expect(await refusalText(run(fetch, TOOL.getCompany, { company_id: '..' }))).toBe(
      'company_id: malformed Axonaut id',
    );
    expect(
      await refusalText(run(fetch, TOOL.getCompany, { account: '777', company_id: '1' })),
    ).toBe("account '777' is not selected in this mission");
    expect(await refusalText(run(fetch, TOOL.updateTicket, { ticket_id: '19' }))).toMatch(
      /^nothing to update/,
    );
    const unknown = `${toolPrefixFor(PROVIDER_ID)}send_event`;
    expect(await refusalText(run(fetch, unknown, { event_id: '1' }))).toBe(
      `unknown ${PROVIDER_ID} tool '${unknown}'`,
    );
    const ambiguous = axonautPlugin.execute(
      ctx(fetch, [account, otherAccount]),
      TOOL.listTasks,
      {},
    );
    expect(await refusalText(ambiguous)).toMatch(/holds 2 Axonaut accounts/);
    expect(fetch.calls).toHaveLength(0);
  });

  test('a credential without the declared secret field is refused before any request', async () => {
    const fetch = mockFetch([]);
    const noKey = {
      ...ctx(fetch),
      credential: { kind: 'api-key' as const, fields: {}, metadata: {} },
    };
    await expect(axonautPlugin.execute(noKey, TOOL.listTasks, {})).rejects.toThrow(
      new RegExp(`'${API_KEY_FIELD}'`),
    );
    expect(fetch.calls).toHaveLength(0);
  });
});

describe('discoverResources', () => {
  test('one resource: the account of /me, never the key /me also answers', async () => {
    const fetch = mockFetch([{ method: 'GET', url: `${API}/me`, body: ME }]);
    const resources = await axonautPlugin.discoverResources(ctx(fetch));
    expect(resources).toEqual([
      {
        provider: PROVIDER_ID,
        ref: ACCOUNT,
        displayName: 'Acme SAS',
        metadata: { account_id: ACCOUNT, company_name: 'Acme SAS', user_email: 'claire@acme.fr' },
      },
    ]);
    expect(JSON.stringify(resources)).not.toContain(KEY);
    expect(fetch.calls[0]!.headers[API_KEY_HEADER.toLowerCase()]).toBe(KEY);
  });

  test('a key that opens no account is a CredentialRefusal', async () => {
    const fetch = mockFetch([{ method: 'GET', url: `${API}/me`, body: { ...ME, account: [] } }]);
    await expect(axonautPlugin.discoverResources(ctx(fetch))).rejects.toMatchObject({
      name: 'CredentialRefusal',
      message: 'This Axonaut key opens no company account.',
    });
  });

  test('an account id no call could name, or an answer that is not an object, is refused', async () => {
    const odd = mockFetch([
      {
        method: 'GET',
        url: `${API}/me`,
        body: { ...ME, account: [{ id: '../1', company_name: 'X' }] },
      },
    ]);
    await expect(axonautPlugin.discoverResources(ctx(odd))).rejects.toBeInstanceOf(
      UpstreamProtocolError,
    );
    const list = mockFetch([{ method: 'GET', url: `${API}/me`, body: [ME] }]);
    await expect(axonautPlugin.discoverResources(ctx(list))).rejects.toThrow(
      new UpstreamProtocolError(`${PROVIDER_ID} GET /me: unexpected answer`),
    );
  });
});

/**
 * Shared fixtures of the `axonaut` tests: the mission's account, the
 * execution context and the samples of every tool (catalog coverage, data
 * model, identifier proof).
 */
import type { ExecuteContext, Resource } from '@vaubaan/plugin-sdk';
import type { ToolSamples } from '@vaubaan/plugin-sdk/testing';

import { API_KEY_FIELD, PROVIDER_ID, TOOL } from '../../src/identity.ts';

export const KEY = 'axk-0123456789abcdef';
export const ACCOUNT = '4242';

export const account: Resource = {
  provider: PROVIDER_ID,
  ref: ACCOUNT,
  displayName: 'Acme SAS',
  metadata: { account_id: ACCOUNT, company_name: 'Acme SAS' },
};
export const otherAccount: Resource = {
  provider: PROVIDER_ID,
  ref: '777',
  displayName: 'Globex SARL',
};

export function ctx(
  fetch: typeof globalThis.fetch,
  resources: readonly Resource[] = [account],
): ExecuteContext {
  return {
    credential: { kind: 'api-key', fields: { [API_KEY_FIELD]: KEY }, metadata: {} },
    fetch,
    resources,
  };
}

const line = { name: 'Audit day', price: 900, quantity: 2, tax_rate: 20 };

/** At least one realistic call per tool, and the refusals worth keeping in the table. */
export const SAMPLES: ToolSamples = {
  [TOOL.listCompanies]: [
    { args: { account: ACCOUNT, search: 'Globex', is_customer: true, page: 2 } },
    { args: {} },
    { args: { account: '777' }, expectDenied: true },
  ],
  [TOOL.getCompany]: [
    { args: { account: ACCOUNT, company_id: '33' } },
    { args: { company_id: '33' }, resources: [account, otherAccount], expectDenied: true },
  ],
  [TOOL.listContacts]: [{ args: { company_id: '33' } }],
  [TOOL.getContact]: [{ args: { contact_id: '81' } }],
  [TOOL.listEvents]: [{ args: { company_id: '33', page: 1 } }],
  [TOOL.listOpportunities]: [{ args: { status: 'ongoing' } }, { args: { company_id: '33' } }],
  [TOOL.getOpportunity]: [{ args: { opportunity_id: '12' } }],
  [TOOL.listQuotations]: [{ args: { company_id: '33', status: 'pending' } }, { args: {} }],
  [TOOL.getQuotation]: [{ args: { quotation_id: '55' } }],
  [TOOL.listInvoices]: [{ args: { is_paid: false } }, { args: { company_id: '33' } }],
  [TOOL.getInvoice]: [{ args: { invoice_id: '90' } }],
  [TOOL.listPayments]: [{ args: { invoice_id: '90' } }, { args: {} }],
  [TOOL.listProjects]: [{ args: { name: 'Website' } }],
  [TOOL.getProject]: [{ args: { project_id: '7' } }],
  [TOOL.listTasks]: [{ args: { page: 3 } }],
  [TOOL.getTask]: [{ args: { task_id: '61' } }],
  [TOOL.listTickets]: [{ args: { company_id: '33', is_closed: false } }, { args: {} }],
  [TOOL.getTicket]: [{ args: { ticket_id: '19' } }],
  [TOOL.listProducts]: [{ args: { name: 'Audit' } }],
  [TOOL.getProduct]: [{ args: { product_id: '73' } }],
  [TOOL.createCompany]: [
    { args: { name: 'Globex', address_city: 'Toulouse', is_prospect: true } },
    { args: { address_city: 'Toulouse' }, expectDenied: true },
  ],
  [TOOL.updateCompany]: [
    { args: { company_id: '33', comments: 'Called back.' } },
    { args: { company_id: '33' }, expectDenied: true },
  ],
  [TOOL.createContact]: [
    { args: { company_id: '33', firstname: 'Claire', lastname: 'Rousseau', email: 'c@globex.fr' } },
  ],
  [TOOL.updateContact]: [{ args: { contact_id: '81', phone_number: '0102030405' } }],
  [TOOL.createEvent]: [
    { args: { company_id: '33', title: 'Call', content: 'Budget confirmed.', nature: 3 } },
  ],
  [TOOL.createOpportunity]: [{ args: { company_id: '33', name: 'Audit 2027', amount: 1800 } }],
  [TOOL.updateOpportunity]: [{ args: { opportunity_id: '12', probability: 80 } }],
  [TOOL.setOpportunityOutcome]: [
    { args: { opportunity_id: '12', outcome: 'won' } },
    { args: { opportunity_id: '12', outcome: 'maybe' }, expectDenied: true },
  ],
  [TOOL.createTask]: [{ args: { title: 'Prepare audit', project_id: '7', priority: 'haute' } }],
  [TOOL.updateTask]: [{ args: { task_id: '61', end_date: '25/11/2026' } }],
  [TOOL.createTicket]: [{ args: { title: 'Login fails', company_id: '33' } }],
  [TOOL.updateTicket]: [{ args: { ticket_id: '19', is_closed: true } }],
  [TOOL.addTicketComment]: [{ args: { ticket_id: '19', text: 'Customer called back.' } }],
  [TOOL.createQuotation]: [{ args: { company_id: '33', products: [line] } }],
  [TOOL.setQuotationOutcome]: [{ args: { quotation_id: '55', outcome: 'accepted' } }],
  [TOOL.createInvoice]: [{ args: { company_id: '33', products: [line], date: '2026-11-05' } }],
  [TOOL.recordPayment]: [
    { args: { invoice_id: '90', amount: 2160, nature: 2, date: '2026-11-05', reference: 'VIR-1' } },
  ],
  [TOOL.deleteCompany]: [{ args: { company_id: '33' } }],
  [TOOL.deleteContact]: [{ args: { contact_id: '81' } }],
  [TOOL.deleteOpportunity]: [{ args: { opportunity_id: '12' } }],
  [TOOL.deleteTask]: [{ args: { task_id: '61' } }],
};

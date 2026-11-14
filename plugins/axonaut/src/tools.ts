/**
 * MCP tools of the `axonaut` provider.
 *
 * Handbook : docs/handbook/providers/axonaut.md §2.
 * Written from Axonaut's OpenAPI description of its API v2
 * (https://axonaut.com/api/v2/doc.json, read 2026-11-05): every argument maps
 * to a parameter or a body field that file declares, under the same name
 * unless stated in its description.
 *
 * Naming : `axonaut__<verb>_<noun>`, built once in `identity.ts` (`TOOL`).
 * Every tool takes `account`, the ref of the account's one resource; it may
 * be left out when the mission holds exactly one Axonaut account.
 *
 * Each tool is declared once here (`AXONAUT_TOOL_SPECS`): its schema for
 * `tools/list`, its title for people and the arguments the shared reader
 * (`fields.ts`) reads for `classify` and `execute` are all derived from it.
 * Bank details (IBAN, BIC), SEPA mandates, payment links and custom fields are
 * never declared, so no tool can send them.
 */

import type { McpToolDeclaration } from '@vaubaan/plugin-sdk';

import {
  amount,
  code,
  dayMonthYear,
  email,
  flag,
  id,
  integer,
  isoDate,
  line,
  oneOf,
  page,
  percent,
  productLines,
  schemaOf,
  text,
  type Field,
  type Fields,
} from './fields.ts';
import { TOOL, type AxonautTool } from './identity.ts';

export interface ToolSpec {
  readonly name: AxonautTool;
  /** For people: the head of an approval request (`toolTitles`). */
  readonly title: string;
  /** For the agent (`tools/list`). */
  readonly description: string;
  /** Every argument but `account`, which every tool takes. */
  readonly fields: Fields;
  readonly required: readonly string[];
}

/** The resource argument of every tool. */
export const ACCOUNT_FIELD: Field = id(
  'Axonaut account id, one of the accounts of the mission; optional when the mission holds one.',
);

const PRIORITY = ['basse', 'normale', 'haute', 'urgente'] as const;

// ─── Shared field groups ─────────────────────────────────────────────────

const companyAddress = {
  address_street: line('Street address.'),
  address_zip_code: line('Postal code.', 32),
  address_city: line('City.'),
  address_country: line('Country, such as France.'),
} satisfies Fields;

const companyDetails = {
  name: line('Company name.'),
  ...companyAddress,
  siret: line('SIRET number of the company.', 32),
  intracommunity_number: line('Intra-community VAT number.', 32),
  comments: text('Notes on the company.'),
} satisfies Fields;

const contactDetails = {
  firstname: line('First name.'),
  lastname: line('Last name.'),
  email: email('E-mail address of the contact.'),
  phone_number: line('Phone number.', 64),
  cellphone_number: line('Mobile phone number.', 64),
} satisfies Fields;

const opportunityDetails = {
  name: line('Name of the opportunity.'),
  amount: amount('Expected amount.'),
  probability: percent('Probability of winning, in percent.'),
  comments: text('Notes on the opportunity.'),
  pipe_step_name: line('Name of the pipeline step, as Axonaut shows it.'),
  due_date_ts: integer('Expected closing date, as a Unix timestamp in seconds.', 0, 99_999_999_999),
} satisfies Fields;

const taskDetails = {
  title: line('Title of the task.'),
  description: text('Description of the task.'),
  priority: oneOf('Priority, in Axonaut’s values (low to urgent).', PRIORITY),
  estimated_workload: amount('Estimated workload.'),
  company_id: id('Company the task is about.'),
  project_id: id('Project the task belongs to.'),
  start_date: dayMonthYear('Start date, DD/MM/YYYY.'),
  end_date: dayMonthYear('End date, DD/MM/YYYY.'),
  estimated_end_date: dayMonthYear('Estimated end date, DD/MM/YYYY.'),
} satisfies Fields;

const outcome = (values: readonly string[], what: string): Field =>
  oneOf(`The outcome to register on the ${what}.`, values);

// ─── The tools ───────────────────────────────────────────────────────────

export const AXONAUT_TOOL_SPECS: readonly ToolSpec[] = [
  // ─── Reads — CRM ───────────────────────────────────────────────────────
  {
    name: TOOL.listCompanies,
    title: 'List companies',
    description:
      'List the companies of the CRM (customers, prospects, suppliers), one page at a time.',
    fields: {
      search: line('Only companies whose name contains this text.'),
      is_customer: flag('Only customers (true) or only non-customers (false).'),
      is_prospect: flag('Only prospects (true) or only non-prospects (false).'),
      city: line('Only companies in this city (Axonaut’s `address_city` filter).'),
      page,
    },
    required: [],
  },
  {
    name: TOOL.getCompany,
    title: 'Read a company',
    description: 'Read one company of the CRM.',
    fields: { company_id: id('Id of the company.') },
    required: ['company_id'],
  },
  {
    name: TOOL.listContacts,
    title: 'List the contacts of a company',
    description: 'List the contact people of one company (Axonaut calls them employees).',
    fields: { company_id: id('Id of the company.'), page },
    required: ['company_id'],
  },
  {
    name: TOOL.getContact,
    title: 'Read a contact',
    description: 'Read one contact person.',
    fields: { contact_id: id('Id of the contact (an Axonaut employee id).') },
    required: ['contact_id'],
  },
  {
    name: TOOL.listEvents,
    title: 'List the CRM events of a company',
    description: 'List the notes, calls, meetings and e-mail logs recorded on one company.',
    fields: { company_id: id('Id of the company.'), page },
    required: ['company_id'],
  },
  {
    name: TOOL.listOpportunities,
    title: 'List opportunities',
    description: 'List the opportunities of the pipeline, or those of one company.',
    fields: {
      company_id: id('Only the opportunities of this company.'),
      status: oneOf('Ongoing, archived or all (the default).', ['ongoing', 'archived', 'all']),
      page,
    },
    required: [],
  },
  {
    name: TOOL.getOpportunity,
    title: 'Read an opportunity',
    description: 'Read one opportunity.',
    fields: { opportunity_id: id('Id of the opportunity.') },
    required: ['opportunity_id'],
  },
  // ─── Reads — sales ─────────────────────────────────────────────────────
  {
    name: TOOL.listQuotations,
    title: 'List quotations',
    description: 'List the quotations, or those of one company.',
    fields: {
      company_id: id('Only the quotations of this company.'),
      status: oneOf('Accepted, refused, pending or all (the default).', [
        'accepted',
        'refused',
        'pending',
        'all',
      ]),
      page,
    },
    required: [],
  },
  {
    name: TOOL.getQuotation,
    title: 'Read a quotation',
    description: 'Read one quotation with its lines.',
    fields: { quotation_id: id('Id of the quotation.') },
    required: ['quotation_id'],
  },
  {
    name: TOOL.listInvoices,
    title: 'List invoices',
    description: 'List the customer invoices, or those of one company.',
    fields: {
      company_id: id('Only the invoices of this company.'),
      is_paid: flag('Only paid (true) or only unpaid (false) invoices.'),
      page,
    },
    required: [],
  },
  {
    name: TOOL.getInvoice,
    title: 'Read an invoice',
    description: 'Read one invoice with its lines.',
    fields: { invoice_id: id('Id of the invoice.') },
    required: ['invoice_id'],
  },
  {
    name: TOOL.listPayments,
    title: 'List invoice payments',
    description: 'List the payments received on invoices, or those of one invoice.',
    fields: { invoice_id: id('Only the payments of this invoice.'), page },
    required: [],
  },
  // ─── Reads — work and catalog ──────────────────────────────────────────
  {
    name: TOOL.listProjects,
    title: 'List projects',
    description: 'List the projects of the account.',
    fields: { name: line('Only projects whose name matches this text.'), page },
    required: [],
  },
  {
    name: TOOL.getProject,
    title: 'Read a project',
    description: 'Read one project.',
    fields: { project_id: id('Id of the project.') },
    required: ['project_id'],
  },
  {
    name: TOOL.listTasks,
    title: 'List tasks',
    description: 'List the tasks of the account (Axonaut offers no filter on this list).',
    fields: { page },
    required: [],
  },
  {
    name: TOOL.getTask,
    title: 'Read a task',
    description: 'Read one task.',
    fields: { task_id: id('Id of the task.') },
    required: ['task_id'],
  },
  {
    name: TOOL.listTickets,
    title: 'List tickets',
    description: 'List the support tickets, or those of one company.',
    fields: {
      company_id: id('Only the tickets of this company.'),
      is_closed: flag('Only closed (true) or only open (false) tickets.'),
      page,
    },
    required: [],
  },
  {
    name: TOOL.getTicket,
    title: 'Read a ticket',
    description: 'Read one support ticket.',
    fields: { ticket_id: id('Id of the ticket.') },
    required: ['ticket_id'],
  },
  {
    name: TOOL.listProducts,
    title: 'List products',
    description: 'List the products and services of the catalog.',
    fields: { name: line('Only products whose name contains this text.'), page },
    required: [],
  },
  {
    name: TOOL.getProduct,
    title: 'Read a product',
    description: 'Read one product of the catalog.',
    fields: { product_id: id('Id of the product.') },
    required: ['product_id'],
  },
  // ─── Writes — CRM ──────────────────────────────────────────────────────
  {
    name: TOOL.createCompany,
    title: 'Create a company',
    description: 'Create a company in the CRM, as a customer, a prospect or neither.',
    fields: {
      ...companyDetails,
      is_customer: flag('The company is a customer.'),
      is_prospect: flag('The company is a prospect.'),
    },
    required: ['name'],
  },
  {
    name: TOOL.updateCompany,
    title: 'Update a company',
    description: 'Change the name, address, identifiers or notes of a company.',
    fields: { company_id: id('Id of the company.'), ...companyDetails },
    required: ['company_id'],
  },
  {
    name: TOOL.createContact,
    title: 'Add a contact to a company',
    description: 'Create a contact person in a company.',
    fields: { company_id: id('Id of the company the contact works for.'), ...contactDetails },
    required: ['company_id', 'lastname'],
  },
  {
    name: TOOL.updateContact,
    title: 'Update a contact',
    description: 'Change the name, e-mail address or phone numbers of a contact.',
    fields: { contact_id: id('Id of the contact.'), ...contactDetails },
    required: ['contact_id'],
  },
  {
    name: TOOL.createEvent,
    title: 'Log a CRM event on a company',
    description:
      'Record a note, call, meeting or e-mail log on a company. Recording it sends nothing to anyone.',
    fields: {
      company_id: id('Id of the company.'),
      title: line('Title of the event.'),
      content: text('What happened.'),
      nature: code(
        'Kind of event: 1 meeting, 2 e-mail, 3 phone call, 4 letter, 5 text message, 6 note.',
        [1, 2, 3, 4, 5, 6],
      ),
      date: isoDate('When it happened, ISO 8601.'),
      duration: integer('Duration in minutes.', 0, 100_000),
      is_done: flag('The event already took place.'),
      opportunity_id: id('Opportunity the event belongs to.'),
    },
    required: ['company_id', 'title', 'nature'],
  },
  {
    name: TOOL.createOpportunity,
    title: 'Create an opportunity',
    description: 'Add a deal to the pipeline, for a company.',
    fields: {
      company_id: id('Id of the company.'),
      ...opportunityDetails,
      pipe_name: line('Name of the pipeline, as Axonaut shows it.'),
    },
    required: ['company_id', 'name'],
  },
  {
    name: TOOL.updateOpportunity,
    title: 'Update an opportunity',
    description: 'Change the amount, probability, step, due date or notes of an opportunity.',
    fields: { opportunity_id: id('Id of the opportunity.'), ...opportunityDetails },
    required: ['opportunity_id'],
  },
  {
    name: TOOL.setOpportunityOutcome,
    title: 'Mark an opportunity won or lost',
    description: 'Register an opportunity as won or lost, which closes it in the pipeline.',
    fields: {
      opportunity_id: id('Id of the opportunity.'),
      outcome: outcome(['won', 'lost'], 'opportunity'),
      date: isoDate('Date of the outcome, ISO 8601; today when left out.'),
    },
    required: ['opportunity_id', 'outcome'],
  },
  // ─── Writes — work ─────────────────────────────────────────────────────
  {
    name: TOOL.createTask,
    title: 'Create a task',
    description: 'Create a task, on a project or a company.',
    fields: taskDetails,
    required: ['title'],
  },
  {
    name: TOOL.updateTask,
    title: 'Update a task',
    description: 'Change a task: its title, description, priority, dates, status or links.',
    fields: {
      task_id: id('Id of the task.'),
      ...taskDetails,
      task_status_id: id('Id of the task status to move the task to.'),
    },
    required: ['task_id'],
  },
  {
    name: TOOL.createTicket,
    title: 'Create a ticket',
    description: 'Open a support ticket.',
    fields: {
      title: line('Title of the ticket.'),
      description: text('Description of the request.'),
      priority: oneOf('Priority, in Axonaut’s values (low to urgent).', PRIORITY),
      company_id: id('Company the ticket is about.'),
      project_id: id('Project the ticket belongs to.'),
    },
    required: ['title'],
  },
  {
    name: TOOL.updateTicket,
    title: 'Update a ticket',
    description: 'Change the title, priority, company or project of a ticket, or close it.',
    fields: {
      ticket_id: id('Id of the ticket.'),
      title: line('Title of the ticket.'),
      priority: oneOf('Priority, in Axonaut’s values (low to urgent).', PRIORITY),
      company_id: id('Company the ticket is about.'),
      project_id: id('Project the ticket belongs to.'),
      is_closed: flag('Close (true) or reopen (false) the ticket.'),
    },
    required: ['ticket_id'],
  },
  {
    name: TOOL.addTicketComment,
    title: 'Comment on a ticket',
    description: 'Add a plain-text comment to a support ticket.',
    fields: {
      ticket_id: id('Id of the ticket.'),
      text: text('The comment; line breaks are kept.'),
    },
    required: ['ticket_id', 'text'],
  },
  // ─── Writes — sales ────────────────────────────────────────────────────
  {
    name: TOOL.createQuotation,
    title: 'Create a quotation',
    description:
      'Create a quotation for a company, with its product lines. Creating it does not send it.',
    fields: {
      company_id: id('Id of the customer company.'),
      products: productLines('The lines of the quotation.'),
      date: isoDate('Date of the quotation, ISO 8601.'),
      expiry_date: isoDate('Date the quotation expires, ISO 8601.'),
      opportunity_id: id('Opportunity the quotation answers.'),
      project_id: id('Project the quotation belongs to.'),
      payment_terms: text('Payment terms printed on the quotation.', 2000),
      comments: text('Comments printed on the quotation.'),
    },
    required: ['company_id', 'products'],
  },
  {
    name: TOOL.setQuotationOutcome,
    title: 'Mark a quotation accepted or refused',
    description:
      'Register the answer of the customer. Accepting creates the order; an accepted quotation cannot be refused.',
    fields: {
      quotation_id: id('Id of the quotation.'),
      outcome: outcome(['accepted', 'refused'], 'quotation'),
    },
    required: ['quotation_id', 'outcome'],
  },
  {
    name: TOOL.createInvoice,
    title: 'Create an invoice',
    description:
      'Create a numbered customer invoice with its product lines. An invoice cannot be deleted, only cancelled by a credit note.',
    fields: {
      company_id: id('Id of the customer company.'),
      products: productLines('The lines of the invoice.'),
      date: isoDate('Date of the invoice, ISO 8601.'),
      due_date: isoDate('Due date, ISO 8601.'),
      project_id: id('Project the invoice belongs to.'),
      order_number: line('Order number of the customer, printed on the invoice.'),
      payment_terms: text('Payment terms printed on the invoice.', 2000),
    },
    required: ['company_id', 'products'],
  },
  {
    name: TOOL.recordPayment,
    title: 'Record a payment on an invoice',
    description: 'Record money received on an invoice.',
    fields: {
      invoice_id: id('Id of the invoice paid.'),
      amount: amount('Amount received.'),
      nature: code(
        'How it was paid: 1 debit, 2 transfer, 3 cheque, 4 credit card, 5 cash, 6 other.',
        [1, 2, 3, 4, 5, 6],
      ),
      date: isoDate('Date of the payment, ISO 8601.'),
      reference: line('Reference of the payment, such as the bank transfer reference.'),
    },
    required: ['invoice_id', 'amount', 'nature', 'date'],
  },
  // ─── Writes — deletions ────────────────────────────────────────────────
  {
    name: TOOL.deleteCompany,
    title: 'Delete a company',
    description: 'Delete a company from the CRM. Cannot be undone.',
    fields: { company_id: id('Id of the company.') },
    required: ['company_id'],
  },
  {
    name: TOOL.deleteContact,
    title: 'Delete a contact',
    description: 'Delete a contact person. Cannot be undone.',
    fields: { contact_id: id('Id of the contact.') },
    required: ['contact_id'],
  },
  {
    name: TOOL.deleteOpportunity,
    title: 'Delete an opportunity',
    description: 'Delete an opportunity from the pipeline. Cannot be undone.',
    fields: { opportunity_id: id('Id of the opportunity.') },
    required: ['opportunity_id'],
  },
  {
    name: TOOL.deleteTask,
    title: 'Delete a task',
    description: 'Delete a task. Cannot be undone.',
    fields: { task_id: id('Id of the task.') },
    required: ['task_id'],
  },
];

/** The spec of each tool, by name. */
export const TOOL_SPEC_BY_NAME: ReadonlyMap<string, ToolSpec> = new Map(
  AXONAUT_TOOL_SPECS.map((spec) => [spec.name, spec]),
);

export const axonautTools: readonly McpToolDeclaration[] = AXONAUT_TOOL_SPECS.map((spec) => ({
  name: spec.name,
  description: spec.description,
  inputSchema: {
    type: 'object',
    properties: Object.fromEntries(
      Object.entries({ account: ACCOUNT_FIELD, ...spec.fields }).map(([name, field]) => [
        name,
        schemaOf(field),
      ]),
    ),
    ...(spec.required.length > 0 ? { required: [...spec.required] } : {}),
  },
}));

/** What each tool does, in a few words (`ProviderPlugin.toolTitles`). People only. */
export const axonautToolTitles: Readonly<Record<string, string>> = Object.fromEntries(
  AXONAUT_TOOL_SPECS.map((spec) => [spec.name, spec.title]),
);

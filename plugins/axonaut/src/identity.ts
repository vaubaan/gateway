/**
 * Identity of the `axonaut` service — the one place its ids are written.
 *
 * Handbook : docs/handbook/services/axonaut.md.
 *
 * `SERVICE_ID` is also written as `service:` and as the prefix of every id
 * in `risk-catalog.yaml`, and in the package name. Everything else — the
 * plugin id, the data-model service, the tool names, the resource discovery
 * returns, the credential field — is derived from this module.
 */

import { toolPrefixFor } from '@vaubaan/plugin-sdk';

/** The service id. */
export const SERVICE_ID = 'axonaut';

/** `axonaut__` : prepended to every tool name. */
export const TOOL_PREFIX = toolPrefixFor(SERVICE_ID);

/** Name of the secret field of the `api-key` credential. */
export const API_KEY_FIELD = 'api_key';

/** The MCP tool names, in the order `tools/list` gives them. */
export const TOOL = {
  // Reads
  listCompanies: `${TOOL_PREFIX}list_companies`,
  getCompany: `${TOOL_PREFIX}get_company`,
  listContacts: `${TOOL_PREFIX}list_contacts`,
  getContact: `${TOOL_PREFIX}get_contact`,
  listEvents: `${TOOL_PREFIX}list_events`,
  listOpportunities: `${TOOL_PREFIX}list_opportunities`,
  getOpportunity: `${TOOL_PREFIX}get_opportunity`,
  listQuotations: `${TOOL_PREFIX}list_quotations`,
  getQuotation: `${TOOL_PREFIX}get_quotation`,
  listInvoices: `${TOOL_PREFIX}list_invoices`,
  getInvoice: `${TOOL_PREFIX}get_invoice`,
  listPayments: `${TOOL_PREFIX}list_payments`,
  listProjects: `${TOOL_PREFIX}list_projects`,
  getProject: `${TOOL_PREFIX}get_project`,
  listTasks: `${TOOL_PREFIX}list_tasks`,
  getTask: `${TOOL_PREFIX}get_task`,
  listTickets: `${TOOL_PREFIX}list_tickets`,
  getTicket: `${TOOL_PREFIX}get_ticket`,
  listProducts: `${TOOL_PREFIX}list_products`,
  getProduct: `${TOOL_PREFIX}get_product`,
  // Writes — CRM
  createCompany: `${TOOL_PREFIX}create_company`,
  updateCompany: `${TOOL_PREFIX}update_company`,
  createContact: `${TOOL_PREFIX}create_contact`,
  updateContact: `${TOOL_PREFIX}update_contact`,
  createEvent: `${TOOL_PREFIX}create_event`,
  createOpportunity: `${TOOL_PREFIX}create_opportunity`,
  updateOpportunity: `${TOOL_PREFIX}update_opportunity`,
  setOpportunityOutcome: `${TOOL_PREFIX}set_opportunity_outcome`,
  // Writes — work
  createTask: `${TOOL_PREFIX}create_task`,
  updateTask: `${TOOL_PREFIX}update_task`,
  createTicket: `${TOOL_PREFIX}create_ticket`,
  updateTicket: `${TOOL_PREFIX}update_ticket`,
  addTicketComment: `${TOOL_PREFIX}add_ticket_comment`,
  // Writes — sales
  createQuotation: `${TOOL_PREFIX}create_quotation`,
  setQuotationOutcome: `${TOOL_PREFIX}set_quotation_outcome`,
  createInvoice: `${TOOL_PREFIX}create_invoice`,
  recordPayment: `${TOOL_PREFIX}record_payment`,
  // Writes — deletions
  deleteCompany: `${TOOL_PREFIX}delete_company`,
  deleteContact: `${TOOL_PREFIX}delete_contact`,
  deleteOpportunity: `${TOOL_PREFIX}delete_opportunity`,
  deleteTask: `${TOOL_PREFIX}delete_task`,
} as const;

export type AxonautTool = (typeof TOOL)[keyof typeof TOOL];

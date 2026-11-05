/**
 * Data model of the `axonaut` provider.
 *
 * Spec : docs/spec/gateway-risk-model.md §2 ; handbook docs/handbook/providers/axonaut.md §1.
 *
 * One plane, `erp`, rooted at the `account` — the Axonaut company account an
 * API key opens, and the one resource of a connection. Axonaut's REST API is
 * flat (`/companies/{id}`, `/employees/{id}`, `/invoices/{id}`…): a contact's
 * company or an invoice's customer is a field of the record, never a segment
 * of its path. The model says so: every entity is a direct child of the
 * account, and the account is the only boundary a mission can draw.
 *
 * Verb leaves (writes with a risk of their own): `delete` under the four
 * records the plugin deletes, `outcome` under an opportunity (won / lost) and
 * a quotation (accepted / refused), `comment` under a ticket.
 */

import type { DataModel, DataModelEntity } from '@vaubaan/plugin-sdk';

import { PROVIDER_ID } from './identity.ts';

/** A collection of the account: one record by id, or all of them (a list). */
function collection(name: string, description: string): DataModelEntity {
  return { name, parent: 'account', cardinalities: ['one', 'unbounded'], description };
}

function leaf(name: string, parent: string, description: string): DataModelEntity {
  return { name, parent, cardinalities: ['one'], description };
}

export const axonautDataModel: DataModel = {
  provider: PROVIDER_ID,
  planes: [
    {
      slug: 'erp',
      description: 'One Axonaut account: its CRM, sales documents, projects, tickets and products.',
      entities: [
        {
          name: 'account',
          parent: null,
          cardinalities: ['one'],
          description:
            'The Axonaut account the API key opens: the resource of a connection, one per key.',
        },
        collection('company', 'A company of the CRM: a customer, a prospect or a supplier.'),
        collection('contact', 'A contact person of a company (an Axonaut "employee").'),
        collection('opportunity', 'A deal in the sales pipeline.'),
        collection('quotation', 'A quote sent or to send to a company.'),
        collection('invoice', 'A customer invoice, a numbered accounting document.'),
        collection('payment', 'A payment received on an invoice.'),
        collection('project', 'A project of the account.'),
        collection('task', 'A task, on a project or a company.'),
        collection('ticket', 'A support ticket.'),
        collection('event', 'A CRM event on a company: a note, a call, a meeting, an e-mail log.'),
        collection('product', 'A product or service of the catalog.'),
        leaf('delete', 'company', 'Verb leaf: the deletion of a company.'),
        leaf('delete', 'contact', 'Verb leaf: the deletion of a contact.'),
        leaf('delete', 'opportunity', 'Verb leaf: the deletion of an opportunity.'),
        leaf('delete', 'task', 'Verb leaf: the deletion of a task.'),
        leaf('outcome', 'opportunity', 'Verb leaf: an opportunity registered as won or lost.'),
        leaf('outcome', 'quotation', 'Verb leaf: a quotation registered as accepted or refused.'),
        leaf('comment', 'ticket', 'A comment added to a ticket.'),
      ],
    },
  ],
};

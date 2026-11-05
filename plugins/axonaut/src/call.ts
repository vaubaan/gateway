/**
 * One reading of an `axonaut` call, for `classify` and `execute` alike.
 *
 * Spec : docs/spec/gateway-risk-model.md §3, §7 ; handbook docs/handbook/providers/axonaut.md §2.
 *
 * `readCall(tool, args, resources)` is pure: it resolves the account, reads
 * the declared arguments through `fields.ts`, and returns at once the slices
 * the call touches and the request that performs it. `classify` returns the
 * slices; `execute` sends the request. Both come from the same values, so
 * what is executed is what was classified, and `execute` is safe when called
 * without `classify`.
 *
 * Every slice is rooted at `axonaut.account[<ref>]`, the one resource of the
 * connection. Axonaut's endpoints are flat, so every record is a direct child
 * of the account. A list filtered on a company (or an invoice) also reads that
 * record (`company[<id>].R`). A deletion is a write on the record and on its
 * `delete` leaf (layered). An outcome (won / lost, accepted / refused) is the
 * `outcome` leaf alone.
 */

import { ANY_IDENT, type Resource, type Slice, type SliceSegment } from '@vaubaan/plugin-sdk';

import { axonautId, readArguments, type ProductLine, type Values } from './fields.ts';
import { PROVIDER_ID, TOOL } from './identity.ts';
import { TOOL_SPEC_BY_NAME } from './tools.ts';

type Args = Readonly<Record<string, unknown>>;
export type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** The request a call performs, built field by field from the values read. */
export interface AxonautRequest {
  readonly method: Method;
  /** Below the API base, every id in it read by `axonautId`. */
  readonly path: string;
  readonly query?: URLSearchParams;
  /** Axonaut's `page`, sent as a header (the OpenAPI file declares it `in: header`). */
  readonly page?: number;
  readonly body?: Readonly<Record<string, unknown>>;
  /** The answer given to the agent when Axonaut answers without content. */
  readonly confirmation?: Readonly<Record<string, unknown>>;
}

export interface AxonautCall {
  readonly account: string;
  readonly slices: readonly Slice[];
  readonly request: AxonautRequest;
}

export type CallReading = AxonautCall | { readonly denied: string };

// ─── The account ─────────────────────────────────────────────────────────

/**
 * The account a call targets:
 *
 *   - `args.account` given : a well-formed id AND one of the mission's
 *     Axonaut resources — anything else is refused, never replaced by the
 *     single resource;
 *   - absent : the mission's single Axonaut account, or a refusal when it
 *     holds none or several. A mission resource whose ref is not an Axonaut
 *     id is refused too.
 */
export function resolveAccount(
  args: Args,
  resources: readonly Resource[],
): { readonly ref: string } | { readonly denied: string } {
  const own = resources.filter((r) => r.provider === PROVIDER_ID);
  if (args.account !== undefined) {
    const explicit = axonautId(args.account);
    if (explicit === null) return { denied: 'account: malformed Axonaut id' };
    return own.some((r) => r.ref === explicit)
      ? { ref: explicit }
      : { denied: `account '${explicit}' is not selected in this mission` };
  }
  if (own.length !== 1) {
    return {
      denied:
        own.length === 0
          ? 'account: argument missing and the mission holds no Axonaut account'
          : `account: argument missing and the mission holds ${own.length} Axonaut accounts — name one`,
    };
  }
  const single = axonautId(own[0]!.ref);
  return single === null
    ? { denied: 'account: the mission resource is not an Axonaut account id' }
    : { ref: single };
}

// ─── Slices ──────────────────────────────────────────────────────────────

function name(value: string): SliceSegment {
  return { kind: 'name', value };
}

function ident(value: string): SliceSegment {
  return { kind: 'ident', value };
}

/** Every record of a collection: a list. */
const ALL = ANY_IDENT;

// ─── Values ──────────────────────────────────────────────────────────────

/** A value `readArguments` returned for an argument of kind `id`. */
function idOf(values: Values, key: string): string | undefined {
  const value = values[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * A required id. Unreachable when absent: `readArguments` refused the call
 * already, so this guards an invariant of the plugin, not an input.
 */
function requiredId(values: Values, key: string): string {
  const value = idOf(values, key);
  if (value === undefined) throw new Error(`${PROVIDER_ID}: '${key}' was not read`);
  return value;
}

type BodyValue = string | number | boolean | readonly ProductLine[];

/**
 * The body fields named in `keys`, from the values read: an id becomes the
 * JSON number Axonaut's schemas declare, every other value is sent as read.
 * `rename` maps an argument to the body field of another name.
 */
function bodyOf(
  values: Values,
  keys: readonly string[],
  ids: readonly string[] = [],
  rename: Readonly<Record<string, string>> = {},
): Record<string, BodyValue> {
  const body: Record<string, BodyValue> = {};
  for (const key of keys) {
    const value = values[key];
    if (value === undefined) continue;
    const field = rename[key] ?? key;
    body[field] = ids.includes(key) && typeof value === 'string' ? Number(value) : value;
  }
  return body;
}

/** The query filters named in `keys` (`[argument, parameter]`), each a string. */
function queryOf(
  values: Values,
  keys: readonly (readonly [string, string])[],
): URLSearchParams | undefined {
  const query = new URLSearchParams();
  for (const [key, parameter] of keys) {
    const value = values[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      query.set(parameter, String(value));
    }
  }
  return [...query].length > 0 ? query : undefined;
}

function pageOf(values: Values): { readonly page?: number } {
  const value = values.page;
  return typeof value === 'number' ? { page: value } : {};
}

const NOTHING_TO_UPDATE = 'nothing to update: give at least one field to change';

// ─── The reader ──────────────────────────────────────────────────────────

/** Fields of each update tool that may be changed; one at least must be given. */
const COMPANY_FIELDS = [
  'name',
  'address_street',
  'address_zip_code',
  'address_city',
  'address_country',
  'siret',
  'intracommunity_number',
  'comments',
] as const;
const CONTACT_FIELDS = [
  'firstname',
  'lastname',
  'email',
  'phone_number',
  'cellphone_number',
] as const;
const OPPORTUNITY_FIELDS = [
  'name',
  'amount',
  'probability',
  'comments',
  'pipe_step_name',
  'due_date_ts',
] as const;
const TASK_FIELDS = [
  'title',
  'description',
  'priority',
  'estimated_workload',
  'company_id',
  'project_id',
  'start_date',
  'end_date',
  'estimated_end_date',
] as const;
const TASK_IDS = ['company_id', 'project_id', 'task_status_id'] as const;
const TICKET_FIELDS = ['title', 'priority', 'company_id', 'project_id'] as const;

function anyGiven(values: Values, keys: readonly string[]): boolean {
  return keys.some((key) => values[key] !== undefined);
}

/**
 * The slices and the request of one call, or the reason it cannot be read.
 * The one reader of the plugin: `classify` and `execute` both call it.
 */
export function readCall(tool: string, args: Args, resources: readonly Resource[]): CallReading {
  const spec = TOOL_SPEC_BY_NAME.get(tool);
  if (spec === undefined) return { denied: `unknown ${PROVIDER_ID} tool '${tool}'` };
  const account = resolveAccount(args, resources);
  if ('denied' in account) return account;
  const read = readArguments(spec.fields, spec.required, args);
  if ('denied' in read) return read;
  const v = read.values;

  const root: readonly SliceSegment[] = [name('account'), ident(account.ref)];
  const R = (...path: SliceSegment[]): Slice => ({
    provider: PROVIDER_ID,
    path: [...root, ...path],
    action: 'R',
  });
  const W = (...path: SliceSegment[]): Slice => ({
    provider: PROVIDER_ID,
    path: [...root, ...path],
    action: 'W',
  });
  const call = (slices: readonly Slice[], request: AxonautRequest): AxonautCall => ({
    account: account.ref,
    slices,
    request,
  });
  /** A record read by its id. */
  const getOne = (entity: string, key: string, collection: string): AxonautCall => {
    const recordId = requiredId(v, key);
    return call([R(name(entity), ident(recordId))], {
      method: 'GET',
      path: `/${collection}/${recordId}`,
    });
  };
  /** A deletion: the record write and its `delete` leaf. */
  const deleteOne = (entity: string, key: string, collection: string): AxonautCall => {
    const recordId = requiredId(v, key);
    return call(
      [W(name(entity), ident(recordId)), W(name(entity), ident(recordId), name('delete'))],
      {
        method: 'DELETE',
        path: `/${collection}/${recordId}`,
        confirmation: { deleted: entity, id: recordId },
      },
    );
  };
  /** A list, on the whole account or on one company (`/companies/{id}/<collection>`). */
  const listOf = (
    entity: string,
    collection: string,
    filters: readonly (readonly [string, string])[] = [],
  ): AxonautCall => {
    const company = idOf(v, 'company_id');
    const query = queryOf(v, filters);
    return call(
      company === undefined
        ? [R(name(entity), ALL)]
        : [R(name('company'), ident(company)), R(name(entity), ALL)],
      {
        method: 'GET',
        path: company === undefined ? `/${collection}` : `/companies/${company}/${collection}`,
        ...(query ? { query } : {}),
        ...pageOf(v),
      },
    );
  };

  switch (tool) {
    // ─── Reads — CRM ─────────────────────────────────────────────────────
    case TOOL.listCompanies: {
      const query = queryOf(v, [
        ['search', 'search'],
        ['is_customer', 'is_customer'],
        ['is_prospect', 'is_prospect'],
        ['city', 'address_city'],
      ]);
      return call([R(name('company'), ALL)], {
        method: 'GET',
        path: '/companies',
        ...(query ? { query } : {}),
        ...pageOf(v),
      });
    }
    case TOOL.getCompany:
      return getOne('company', 'company_id', 'companies');
    case TOOL.listContacts: {
      const company = requiredId(v, 'company_id');
      return call([R(name('company'), ident(company)), R(name('contact'), ALL)], {
        method: 'GET',
        path: `/companies/${company}/employees`,
        ...pageOf(v),
      });
    }
    case TOOL.getContact:
      return getOne('contact', 'contact_id', 'employees');
    case TOOL.listEvents: {
      const company = requiredId(v, 'company_id');
      return call([R(name('company'), ident(company)), R(name('event'), ALL)], {
        method: 'GET',
        path: `/companies/${company}/events`,
        ...pageOf(v),
      });
    }
    case TOOL.listOpportunities:
      return listOf('opportunity', 'opportunities', [['status', 'status']]);
    case TOOL.getOpportunity:
      return getOne('opportunity', 'opportunity_id', 'opportunities');

    // ─── Reads — sales ───────────────────────────────────────────────────
    case TOOL.listQuotations:
      return listOf('quotation', 'quotations', [['status', 'status']]);
    case TOOL.getQuotation:
      return getOne('quotation', 'quotation_id', 'quotations');
    case TOOL.listInvoices:
      return listOf('invoice', 'invoices', [['is_paid', 'is_paid']]);
    case TOOL.getInvoice:
      return getOne('invoice', 'invoice_id', 'invoices');
    case TOOL.listPayments: {
      const invoice = idOf(v, 'invoice_id');
      const query = queryOf(v, [['invoice_id', 'invoice_id']]);
      return call(
        invoice === undefined
          ? [R(name('payment'), ALL)]
          : [R(name('invoice'), ident(invoice)), R(name('payment'), ALL)],
        { method: 'GET', path: '/payments', ...(query ? { query } : {}), ...pageOf(v) },
      );
    }

    // ─── Reads — work and catalog ────────────────────────────────────────
    case TOOL.listProjects: {
      const query = queryOf(v, [['name', 'name']]);
      return call([R(name('project'), ALL)], {
        method: 'GET',
        path: '/projects',
        ...(query ? { query } : {}),
        ...pageOf(v),
      });
    }
    case TOOL.getProject:
      return getOne('project', 'project_id', 'projects');
    case TOOL.listTasks:
      return call([R(name('task'), ALL)], { method: 'GET', path: '/tasks', ...pageOf(v) });
    case TOOL.getTask:
      return getOne('task', 'task_id', 'tasks');
    case TOOL.listTickets: {
      // `/tickets` takes the company as a query filter, not as a path.
      const company = idOf(v, 'company_id');
      const query = queryOf(v, [
        ['company_id', 'company_id'],
        ['is_closed', 'is_closed'],
      ]);
      return call(
        company === undefined
          ? [R(name('ticket'), ALL)]
          : [R(name('company'), ident(company)), R(name('ticket'), ALL)],
        { method: 'GET', path: '/tickets', ...(query ? { query } : {}), ...pageOf(v) },
      );
    }
    case TOOL.getTicket:
      return getOne('ticket', 'ticket_id', 'tickets');
    case TOOL.listProducts: {
      const query = queryOf(v, [['name', 'name']]);
      return call([R(name('product'), ALL)], {
        method: 'GET',
        path: '/products',
        ...(query ? { query } : {}),
        ...pageOf(v),
      });
    }
    case TOOL.getProduct:
      return getOne('product', 'product_id', 'products');

    // ─── Writes — CRM ────────────────────────────────────────────────────
    case TOOL.createCompany:
      return call([W(name('company'))], {
        method: 'POST',
        path: '/companies',
        body: bodyOf(v, [...COMPANY_FIELDS, 'is_customer', 'is_prospect']),
      });
    case TOOL.updateCompany: {
      if (!anyGiven(v, COMPANY_FIELDS)) return { denied: NOTHING_TO_UPDATE };
      const company = requiredId(v, 'company_id');
      return call([W(name('company'), ident(company))], {
        method: 'PATCH',
        path: `/companies/${company}`,
        body: bodyOf(v, COMPANY_FIELDS),
      });
    }
    case TOOL.createContact:
      return call([W(name('contact'))], {
        method: 'POST',
        path: '/employees',
        body: bodyOf(v, ['company_id', ...CONTACT_FIELDS], ['company_id']),
      });
    case TOOL.updateContact: {
      if (!anyGiven(v, CONTACT_FIELDS)) return { denied: NOTHING_TO_UPDATE };
      const contact = requiredId(v, 'contact_id');
      return call([W(name('contact'), ident(contact))], {
        method: 'PATCH',
        path: `/employees/${contact}`,
        body: bodyOf(v, CONTACT_FIELDS),
      });
    }
    case TOOL.createEvent:
      return call([W(name('event'))], {
        method: 'POST',
        path: '/events',
        body: bodyOf(
          v,
          [
            'company_id',
            'title',
            'content',
            'nature',
            'date',
            'duration',
            'is_done',
            'opportunity_id',
          ],
          ['company_id', 'opportunity_id'],
        ),
      });
    case TOOL.createOpportunity:
      return call([W(name('opportunity'))], {
        method: 'POST',
        path: '/opportunities',
        body: bodyOf(v, ['company_id', ...OPPORTUNITY_FIELDS, 'pipe_name'], ['company_id']),
      });
    case TOOL.updateOpportunity: {
      if (!anyGiven(v, OPPORTUNITY_FIELDS)) return { denied: NOTHING_TO_UPDATE };
      const opportunity = requiredId(v, 'opportunity_id');
      return call([W(name('opportunity'), ident(opportunity))], {
        method: 'PATCH',
        path: `/opportunities/${opportunity}`,
        body: bodyOf(v, OPPORTUNITY_FIELDS),
      });
    }
    case TOOL.setOpportunityOutcome: {
      const opportunity = requiredId(v, 'opportunity_id');
      // `outcome` is read against its enum (`won` | `lost`): one path segment of two.
      const verb = v.outcome === 'won' ? 'won' : 'lost';
      return call([W(name('opportunity'), ident(opportunity), name('outcome'))], {
        method: 'PATCH',
        path: `/opportunities/${opportunity}/${verb}`,
        body: bodyOf(v, ['date']),
      });
    }

    // ─── Writes — work ───────────────────────────────────────────────────
    case TOOL.createTask:
      return call([W(name('task'))], {
        method: 'POST',
        path: '/tasks',
        body: bodyOf(v, TASK_FIELDS, TASK_IDS),
      });
    case TOOL.updateTask: {
      if (!anyGiven(v, [...TASK_FIELDS, 'task_status_id'])) return { denied: NOTHING_TO_UPDATE };
      const task = requiredId(v, 'task_id');
      return call([W(name('task'), ident(task))], {
        method: 'PATCH',
        path: `/tasks/${task}`,
        body: bodyOf(v, [...TASK_FIELDS, 'task_status_id'], TASK_IDS),
      });
    }
    case TOOL.createTicket:
      return call([W(name('ticket'))], {
        method: 'POST',
        path: '/tickets',
        body: bodyOf(
          v,
          ['title', 'description', 'priority', 'company_id', 'project_id'],
          ['company_id', 'project_id'],
        ),
      });
    case TOOL.updateTicket: {
      if (!anyGiven(v, [...TICKET_FIELDS, 'is_closed'])) return { denied: NOTHING_TO_UPDATE };
      const ticket = requiredId(v, 'ticket_id');
      return call([W(name('ticket'), ident(ticket))], {
        method: 'PATCH',
        path: `/tickets/${ticket}`,
        body: bodyOf(v, [...TICKET_FIELDS, 'is_closed'], ['company_id', 'project_id']),
      });
    }
    case TOOL.addTicketComment: {
      const ticket = requiredId(v, 'ticket_id');
      return call([W(name('ticket'), ident(ticket), name('comment'))], {
        method: 'POST',
        path: `/tickets/${ticket}/comments`,
        body: bodyOf(v, ['text']),
      });
    }

    // ─── Writes — sales ──────────────────────────────────────────────────
    case TOOL.createQuotation:
      return call([W(name('quotation'))], {
        method: 'POST',
        path: '/quotations',
        body: bodyOf(
          v,
          [
            'company_id',
            'products',
            'date',
            'expiry_date',
            'opportunity_id',
            'project_id',
            'payment_terms',
            'comments',
          ],
          ['company_id', 'opportunity_id', 'project_id'],
        ),
      });
    case TOOL.setQuotationOutcome: {
      const quotation = requiredId(v, 'quotation_id');
      // `outcome` is read against its enum (`accepted` | `refused`).
      const verb = v.outcome === 'accepted' ? 'accepted' : 'refused';
      return call([W(name('quotation'), ident(quotation), name('outcome'))], {
        method: 'PATCH',
        path: `/quotations/${quotation}/${verb}`,
      });
    }
    case TOOL.createInvoice:
      return call([W(name('invoice'))], {
        method: 'POST',
        path: '/invoices',
        body: bodyOf(
          v,
          [
            'company_id',
            'products',
            'date',
            'due_date',
            'project_id',
            'order_number',
            'payment_terms',
          ],
          ['company_id', 'project_id'],
        ),
      });
    case TOOL.recordPayment:
      return call([W(name('payment'))], {
        method: 'POST',
        path: '/payments',
        body: bodyOf(v, ['invoice_id', 'amount', 'nature', 'date', 'reference'], ['invoice_id']),
      });

    // ─── Writes — deletions ──────────────────────────────────────────────
    case TOOL.deleteCompany:
      return deleteOne('company', 'company_id', 'companies');
    case TOOL.deleteContact:
      return deleteOne('contact', 'contact_id', 'employees');
    case TOOL.deleteOpportunity:
      return deleteOne('opportunity', 'opportunity_id', 'opportunities');
    case TOOL.deleteTask:
      return deleteOne('task', 'task_id', 'tasks');

    default:
      return { denied: `unknown ${PROVIDER_ID} tool '${tool}'` };
  }
}

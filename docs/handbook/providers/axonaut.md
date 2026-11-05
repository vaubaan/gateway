---
title: Axonaut provider plugin
tracks:
  - plugins/axonaut/src/
  - plugins/axonaut/tests/unit/
  - plugins/axonaut/package.json
  - plugins/axonaut/README.md
last_reviewed: 2026-11-05
---

# Axonaut provider plugin — handbook

`@vaubaan/plugin-axonaut`: the CRM, sales documents, projects and tickets of one Axonaut account,
through Axonaut's REST API v2 with the API key of one Axonaut user. One resource per connection: the
account. Tools, slices and the catalog are tabled in the
[plugin README](../../../plugins/axonaut/README.md); rules common to every plugin:
[providers README](README.md).

## Start here

- [`src/call.ts`](../../../plugins/axonaut/src/call.ts) — `readCall`, the one reader: the account,
  the slices and the request of a call. `classify` returns its slices, `execute` sends its request.
- [`src/fields.ts`](../../../plugins/axonaut/src/fields.ts) — the argument kinds, `axonautId`,
  `readArguments`.
- [`src/tools.ts`](../../../plugins/axonaut/src/tools.ts) — one spec per tool; schema, title and
  arguments derive from it.
- [`src/execute.ts`](../../../plugins/axonaut/src/execute.ts) — transport (`userApiKey` header,
  `page` header), `readMe`, discovery.

## 1. Data model

One plane, `erp`, rooted at `account` (the resource). Every other entity is a direct child of the
account, because Axonaut's endpoints are flat: `company`, `contact` (Axonaut's "employee"),
`opportunity`, `quotation`, `invoice`, `payment`, `project`, `task`, `ticket`, `event` (a CRM note,
call, meeting or e-mail log on a company), `product`. Verb leaves: `delete` under `company`,
`contact`, `opportunity`, `task`; `outcome` under `opportunity` and `quotation`; `comment` under
`ticket`. No entity carries an environment: Axonaut has no test mode.

## 2. Tool → slice mapping

Every slice is rooted at `axonaut.account[<ref>]`. A read of one record is `<entity>[<id>].R`, a
list `<entity>[*].R`; a list filtered on a company (or payments on an invoice) also reads that
record (`company[<id>].R`), because the filter names it. A creation is `<entity>.W`, an update
`<entity>[<id>].W`. A deletion emits two slices, `<entity>[<id>].W` and `<entity>[<id>].delete.W`.
An outcome (`won` / `lost`, `accepted` / `refused`) is the `outcome` leaf alone; a ticket comment the
`comment` leaf. The full table is in the plugin README.

- **Identifiers.** One grammar, `axonautId` (`^(0|[1-9][0-9]{0,14})$`, a string or a safe
  integer), for every identifier: the account ref (a slice only; Axonaut's paths never carry the
  account, the key selects it), record ids (a URL path segment), ids in a body (sent as the JSON
  number Axonaut's schemas declare), ids in a query (`company_id` of `/tickets`, `invoice_id` of
  `/payments`) and product ids nested in quotation and invoice lines. No leading zero, so the slice,
  the path and the number in a body name the same record. Free text (`search`, `name`, `city`)
  goes into the query through `URLSearchParams`, never into a path. The outcome verbs reach the
  path only as one value of a closed enum.
- **Undeclared arguments.** The executor builds every request field by field from the arguments
  the tool declares; an undeclared argument is never read, never classified, never sent, so the
  plugin does not refuse it.

## 3. Catalog and macro-actions

13 named risks and the fallback, four macro-actions (`read`, `crm`, `sell`, `clean-up`), each
with its `narrative` in the catalog. Choices that are not
obvious:

- `read-crm` is `pii`: contact people, e-mail addresses, phone numbers, notes about people. It is
  tier 2, so a Careful read of the CRM asks first, while sales, work and catalog reads run freely.
- `invoice-create` is `irreversible` and `public`: a numbered invoice is a legal accounting
  document addressed to a customer, which French rules forbid deleting (it is cancelled by a credit
  note). It is left out at Careful and asks first at every other level.
- `quotation-outcome` and `opportunity-outcome` are `costly`: an accepted quotation creates an order;
  a closed deal changes the reporting. Both are verb leaves matched by their own entry only (the
  write patterns use `[*]`, not `[**]`).
- `payment-record` is `costly`: an accounting entry that marks an invoice paid.
- `delete-record` is `irreversible` (Axonaut documents no restore) and `pii`; layered on the
  record's write risk.
- Budgets are moderate (reads 30 a minute, writes 2 to 20 a minute): Axonaut documents no rate
  limit but meters API time (`api_time_consumed` in `/me`).

## 4. Coverage

Every tool is covered by a named risk; the test's `fallbackHits` and `risksUntouched` are empty.

| Tools                                                                                  | Risks                                      |
| -------------------------------------------------------------------------------------- | ------------------------------------------ |
| `list_companies`, `get_company`, `get_contact`, `get_opportunity`                      | `read-crm`                                 |
| `list_contacts`, `list_events`                                                         | `read-crm` (company and collection)        |
| `list_opportunities`                                                                   | `read-crm`                                 |
| `list_quotations`, `list_invoices`, `list_tickets` with a company                      | `read-sales` / `read-work`, and `read-crm` |
| `get_quotation`, `get_invoice`, `list_payments`                                        | `read-sales`                               |
| `list_projects`, `get_project`, `list_tasks`, `get_task`, `get_ticket`                 | `read-work`                                |
| `list_products`, `get_product`                                                         | `read-catalog`                             |
| `create_company`, `update_company`, `create_contact`, `update_contact`, `create_event` | `crm-write`                                |
| `create_opportunity`, `update_opportunity`                                             | `opportunity-write`                        |
| `set_opportunity_outcome`                                                              | `opportunity-outcome`                      |
| `create_task`, `update_task`, `create_ticket`, `update_ticket`, `add_ticket_comment`   | `work-write`                               |
| `create_quotation`                                                                     | `quotation-create`                         |
| `set_quotation_outcome`                                                                | `quotation-outcome`                        |
| `create_invoice`                                                                       | `invoice-create`                           |
| `record_payment`                                                                       | `payment-record`                           |
| `delete_company`, `delete_contact`                                                     | `crm-write` + `delete-record`              |
| `delete_opportunity`                                                                   | `opportunity-write` + `delete-record`      |
| `delete_task`                                                                          | `work-write` + `delete-record`             |

## 5. Edge cases

- **The account is the only boundary.** Axonaut's records are flat: a contact's company, an
  invoice's customer, a task's project are fields of the record, not segments of its path. Nothing
  binds a contact to a company slice, and the plugin cannot narrow a mission to one customer: a
  mission that may read the CRM reads every company of the account. Filtering a list on a company
  adds `company[<id>].R` because the call names it, not because it confines anything.
- **`/me` answers the key itself** (`user_api_key`). `readMe` copies the user's name and e-mail
  address and the first account's id and name out of the answer and drops the rest; no tool calls
  `/me`, and discovery metadata never holds the key (tests assert it).
- **`page` is a header**, as the OpenAPI file declares it on every list used (`in: header`), not
  a query parameter. The page size is not documented.
- **Rate limit unknown.** Axonaut documents none; a 429, if any, is an `UpstreamHttpError`.
- **Invoice finality.** `invoice.post` has no draft or status field, and `invoice.get` carries a
  `number` and no status: the file does not say whether `POST /invoices` creates a draft. The
  plugin models it as a final, numbered document (the worst case).
- **What an outcome triggers.** The file says of `PATCH /quotations/{id}/accepted`: "The order is
  created automatically (contract_id), linked to the project of the quotation if any", and of
  `/refused`: "An accepted quotation (with an order) cannot be refused". It says nothing of what
  `/opportunities/{id}/won` triggers beyond closing the opportunity.
- **A CRM event of nature 2 (e-mail) is a log, not an e-mail.** `POST /events` records it; sending
  is `POST /events/{id}/send`, which no tool exposes.
- **Nothing sends a document.** Creating a quotation or an invoice does not send it in what the
  file describes; the answer carries a `public_path` and a `customer_portal_url`, links the agent
  could pass on.
- **Ticket comments.** The file does not say whether a comment is shown to or mailed to the
  customer; it is classified as a team-visible write.
- **Booleans of `company.post`.** `is_customer` / `is_prospect` reference a schema `boolean` that
  the file declares as `type: string, enum: [true, false]`; the plugin sends JSON booleans, as for
  the other boolean fields. Not verified against Axonaut.

### Tools deliberately left out

- Sending an event as e-mail (`POST /events/{id}/send`): it mails a customer, an exfiltration path
  that needs recipient zoning first.
- Deleting a project: removes work and its time tracking; no agent need identified.
- Expenses and expense payments: supplier-side accounting, outside the CRM and sales scope.
- Payslips: HR data about employees.
- Bank accounts and bank transactions: the company's bank data.
- Suppliers, supplier contracts, order forms and supplier deliveries: the purchasing side, a
  first version keeps to sales.
- SEPA mandates and mandate signature links: they authorise debits from a customer's account.
- Document download (`/documents/{id}/download`, delivery form and order form downloads): binary
  files, not JSON.
- Product and stock writes: the catalog and the stock feed every quotation and invoice.
- Accounting codes: they change the books of the company.
- Users and workforces: the people of the company and their rights.
- Credits history: Axonaut's own billing of the account.
- Custom fields: their definitions change every form of the account.
- Delivery forms: a first version keeps to quotations and invoices.

## 6. Credential, discovery, execution, tests

- **Credential.** `api-key`, one secret field `api_key` (printable, no whitespace, 8 to 256
  characters), sent in the `userApiKey` header (the `securitySchemes.userApiKey` of the file, `in:
header`). No permission choice: the key acts as its user, with the user's rights in Axonaut, on
  the whole account; the guide recommends a dedicated user whose role matches what agents may do.
  `expiry: none`. `verify` → `GET /me` → `<fullname> · <company_name>`; no account → a
  `CredentialRefusal`.
- **Discovery.** `GET /me` → one resource, `ref` = `account[0].id`, metadata `account_id`,
  `company_name`, `user_email`. An id outside `axonautId` is an `UpstreamProtocolError`.
- **Execution.** `readCall` again, then `httpJson`. A deletion answered without content (202 for a
  company, an empty 200 otherwise) returns `{ deleted, id }`. Declines are `refusalResult` before any
  request; provider failures are thrown typed.
- **Tests.** `plugin.test.ts` (kit, macro-actions), `classify.test.ts` (every branch and refusal),
  `execute.test.ts` (requests, failures, discovery), `identifiers.test.ts` (hostile ids on both
  sides), `credential.test.ts`.

## Outside the repo

- The person signs in to Axonaut as the user the agents will act as and copies the key from
  Settings (Paramètres), API, "Afficher la clé API". This menu path comes from two independent
  integration guides; Axonaut publishes no page on it and the address of that settings page is not
  known, so the guide links the sign-in page (`https://axonaut.com/en/login`). Probed 2026-11-05:
  authenticated routes live under `https://axonaut.com/business/` (`/business/dashboard` redirects
  to the sign-in page); a dozen guessed settings paths answered 404.
- Revocation: the person regenerates the key in Settings, API. Nothing is withdrawn by the gateway.
- Documentation read, 2026-11-05: Axonaut's OpenAPI 3.0 file `https://axonaut.com/api/v2/doc.json`
  (the Swagger page `https://axonaut.com/api/v2/doc` renders it): the security scheme, `/me`, and
  the paths, parameters and schemas `company.*`, `employee.*`, `opportunity.*` (with
  `opportunity.status`), `quotation.*`, `invoice.*`, `invoicePayment.*`, `project.get`, `task.*`,
  `ticket.*`, `ticketComment.post`, `event.*`, `product.get`, `date`, `boolean`. Context7's copy
  (`/websites/axonaut_api_v2_doc`) answered nothing for the API key, its header or rate limits.

## Debug

- `<field>: malformed Axonaut id` → a decimal id without sign, space or leading zero, at most 15
  digits.
- `nothing to update: …` → an update tool called with its id alone.
- `account 'N' is not selected in this mission` → the key's account is another one: check
  `account_id` in the connection's metadata.
- 401 on every call → the key was regenerated in Axonaut; reconnect with the new one.

# `@vaubaan/plugin-axonaut`

[Axonaut](https://axonaut.com) — the French CRM and invoicing software for small companies —
under a mission: companies and their contacts, the sales pipeline, quotations, invoices and the
payments received on them, projects, tasks, support tickets and the product catalog of one Axonaut
account.

Handbook (the model and the reasons behind it):
[`docs/handbook/services/axonaut.md`](../../docs/handbook/services/axonaut.md). Written from
Axonaut's OpenAPI description of its API v2 (`https://axonaut.com/api/v2/doc.json`, read
2026-11-05), its only documentation.

## Files

| File                    | What is in it                                                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `src/identity.ts`       | `SERVICE_ID`, `TOOL_PREFIX`, the tool names (`TOOL`), the credential field.                                                 |
| `src/data-model.ts`     | One plane, `erp`, rooted at the account.                                                                                    |
| `src/risk-catalog.yaml` | 13 named risks, the fallback, 4 macro-actions.                                                                              |
| `src/fields.ts`         | The kinds of argument, the id grammar `axonautId`, and `readArguments`, the one reader of a call's arguments.               |
| `src/tools.ts`          | One spec per tool: its schema, its title, its arguments.                                                                    |
| `src/call.ts`           | `readCall`: the account, the slices and the request of a call, for `classify` and `execute` alike.                          |
| `src/classify.ts`       | `classifyAxonaut`: the slices of `readCall`.                                                                                |
| `src/execute.ts`        | `executeAxonaut` (sends the request of `readCall`), `readMe`, `discoverAxonautResources`, the transport (`userApiKey`).     |
| `src/credential.ts`     | The `api-key` way: guide and `verify`.                                                                                      |
| `src/index.ts`          | `definePlugin({...})`, the default export the gateway registers.                                                            |
| `tests/unit/`           | The SDK kit, classifier branches, `execute` and discovery against `mockFetch`, hostile identifiers, the credential's guide. |

## Data model

One plane, `erp`. Axonaut's API is flat (`/companies/{id}`, `/employees/{id}`,
`/invoices/{id}`…): a contact's company or an invoice's customer is a field of the record, not a
segment of its path, so every entity is a direct child of the account.

```
account[<account id>]          the resource: the Axonaut account the key opens
  ├─ company[<id>]             └─ delete
  ├─ contact[<id>]             └─ delete        (an Axonaut "employee")
  ├─ opportunity[<id>]         ├─ outcome (won / lost)   └─ delete
  ├─ quotation[<id>]           └─ outcome (accepted / refused)
  ├─ invoice[<id>]
  ├─ payment[<id>]
  ├─ project[<id>]
  ├─ task[<id>]                └─ delete
  ├─ ticket[<id>]              └─ comment
  ├─ event[<id>]               a CRM note, call, meeting or e-mail log on a company
  └─ product[<id>]
```

No entity carries an environment: Axonaut has no test mode, and every risk is account-scoped.

## Credential and resources

Kind `api-key`, one required secret field:

| Field     | Pattern          | Purpose                                                                  |
| --------- | ---------------- | ------------------------------------------------------------------------ |
| `api_key` | `^[!-~]{8,256}$` | The API key of the Axonaut user the agents act as, sent in `userApiKey`. |

The key is shown in Axonaut under Settings (Paramètres), API. It has no scope to choose: it acts as
its user, with that user's rights, on the whole account. Axonaut documents no expiry. `verify` asks
`GET /me` and names the user and the account (`Claire Rousseau · Acme SAS`).

`discoverResources` calls `GET /me` and returns **one resource**: `ref` is the account id
(`account[0].id`, a decimal string), `displayName` its company name, metadata `account_id`,
`company_name`, `user_email`. `/me` also answers the key itself (`user_api_key`): only the named
fields are read out of it. Not paginated.

## Tools

41 tools named `axonaut__<verb>_<noun>`. Each takes `account`, which must be one of the mission's
accounts (it may be left out when the mission holds exactly one). Every id (`company_id`,
`task_id`…) is an Axonaut id, `^(0|[1-9][0-9]{0,14})$`, given as a string or a number; anything
else is refused before classification and before any request. Lists take `page` (sent as the
`page` header the OpenAPI file declares); Axonaut answers one page per call, of a size it does not
document.

| Tool                                                                    | Request                                               | Slice (under `axonaut.account[<a>]`)      |
| ----------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------- |
| `list_companies`                                                        | `GET /companies`                                      | `company[*].R`                            |
| `get_company`                                                           | `GET /companies/{id}`                                 | `company[id].R`                           |
| `list_contacts`                                                         | `GET /companies/{id}/employees`                       | `company[id].R`, `contact[*].R`           |
| `get_contact`                                                           | `GET /employees/{id}`                                 | `contact[id].R`                           |
| `list_events`                                                           | `GET /companies/{id}/events`                          | `company[id].R`, `event[*].R`             |
| `list_opportunities`, `list_quotations`, `list_invoices`                | `GET /<collection>` or `/companies/{id}/<collection>` | `<entity>[*].R` (+ `company[id].R`)       |
| `get_opportunity`, `get_quotation`, `get_invoice`                       | `GET /<collection>/{id}`                              | `<entity>[id].R`                          |
| `list_payments`                                                         | `GET /payments`                                       | `payment[*].R` (+ `invoice[id].R`)        |
| `list_projects`, `get_project`                                          | `GET /projects`, `/projects/{id}`                     | `project[*\|id].R`                        |
| `list_tasks`, `get_task`                                                | `GET /tasks`, `/tasks/{id}`                           | `task[*\|id].R`                           |
| `list_tickets`, `get_ticket`                                            | `GET /tickets`, `/tickets/{id}`                       | `ticket[*\|id].R` (+ `company[id].R`)     |
| `list_products`, `get_product`                                          | `GET /products`, `/products/{id}`                     | `product[*\|id].R`                        |
| `create_company`, `update_company`                                      | `POST /companies`, `PATCH /companies/{id}`            | `company.W`, `company[id].W`              |
| `create_contact`, `update_contact`                                      | `POST /employees`, `PATCH /employees/{id}`            | `contact.W`, `contact[id].W`              |
| `create_event`                                                          | `POST /events`                                        | `event.W`                                 |
| `create_opportunity`, `update_opportunity`                              | `POST /opportunities`, `PATCH /opportunities/{id}`    | `opportunity.W`, `opportunity[id].W`      |
| `set_opportunity_outcome`                                               | `PATCH /opportunities/{id}/won\|lost`                 | `opportunity[id].outcome.W`               |
| `create_task`, `update_task`                                            | `POST /tasks`, `PATCH /tasks/{id}`                    | `task.W`, `task[id].W`                    |
| `create_ticket`, `update_ticket`                                        | `POST /tickets`, `PATCH /tickets/{id}`                | `ticket.W`, `ticket[id].W`                |
| `add_ticket_comment`                                                    | `POST /tickets/{id}/comments`                         | `ticket[id].comment.W`                    |
| `create_quotation`                                                      | `POST /quotations`                                    | `quotation.W`                             |
| `set_quotation_outcome`                                                 | `PATCH /quotations/{id}/accepted\|refused`            | `quotation[id].outcome.W`                 |
| `create_invoice`                                                        | `POST /invoices`                                      | `invoice.W`                               |
| `record_payment`                                                        | `POST /payments`                                      | `payment.W`                               |
| `delete_company`, `delete_contact`, `delete_opportunity`, `delete_task` | `DELETE /<collection>/{id}`                           | `<entity>[id].W`, `<entity>[id].delete.W` |

Every request is built field by field from the arguments the tool declares; bank details (IBAN,
BIC), SEPA mandates, payment links and custom fields are declared by no tool and never sent.

## Catalog

`src/risk-catalog.yaml`: 13 named risks and the fallback. Axonaut documents no rate limit (its
`/me` answer reports an `api_time_consumed` counter), so the base budgets are moderate.

| Risk                          | Action | Notes                                                                                           |
| ----------------------------- | ------ | ----------------------------------------------------------------------------------------------- |
| `axonaut.read-crm`            | R      | Companies, contacts, opportunities, CRM events: personal data (`pii`), asks first at Careful.   |
| `axonaut.read-sales`          | R      | Quotations, invoices, payments.                                                                 |
| `axonaut.read-work`           | R      | Projects, tasks, tickets.                                                                       |
| `axonaut.read-catalog`        | R      | Products.                                                                                       |
| `axonaut.crm-write`           | W      | Create or modify companies and contacts, log CRM events (`pii`).                                |
| `axonaut.opportunity-write`   | W      | Create or modify opportunities.                                                                 |
| `axonaut.opportunity-outcome` | W      | The `outcome` leaf of an opportunity: won or lost. Costly.                                      |
| `axonaut.work-write`          | W      | Create or modify tasks and tickets, comment on a ticket.                                        |
| `axonaut.quotation-create`    | W      | Create a quotation (not sent by its creation).                                                  |
| `axonaut.quotation-outcome`   | W      | The `outcome` leaf of a quotation; accepting creates the order. Costly.                         |
| `axonaut.invoice-create`      | W      | Create a numbered invoice. Irreversible: it cannot be deleted, only cancelled by a credit note. |
| `axonaut.payment-record`      | W      | Record a payment on an invoice: an accounting entry. Costly.                                    |
| `axonaut.delete-record`       | W      | The `delete` leaf of a company, contact, opportunity or task. Irreversible.                     |
| `axonaut.uncategorized-write` | W      | Fallback (`fallback: true`); touched by no tool of the plugin, in no macro-action.              |

Deletions are layered: deleting a contact touches `crm-write` and `delete-record`, deleting a task
`work-write` and `delete-record`, and a mission needs both. An outcome touches its own risk alone.

## Macro-actions

A creator ticks macro-actions at a trust level (Careful / Trusting / Autonomous), risk model §4.6.
Each macro-action's `narrative`, the two to four sentences its public page shows, is in
`src/risk-catalog.yaml`.

| Macro-action | Label            | Its risks                                                                   |
| ------------ | ---------------- | --------------------------------------------------------------------------- |
| `read`       | Read             | `read-crm`, `read-sales`, `read-work`, `read-catalog`                       |
| `crm`        | Work the CRM     | `crm-write`, `opportunity-write`, `opportunity-outcome`, `work-write`       |
| `sell`       | Sell and invoice | `quotation-create`, `quotation-outcome`, `invoice-create`, `payment-record` |
| `clean-up`   | Clean up         | `delete-record`                                                             |

The gateway adds "Anything else", holding the fallback.

## Tests

`npx vitest run plugins/axonaut`: the SDK kit (`assertPluginWellFormed`, `assertNoWildcard`,
`assertCatalogCoverage` with no fallback hit and no risk untouched, `assertSlicesOnDataModel`,
`catalogPathIssues`, `assertIdentifiersRefused` on the plugin's `examples`, `src/examples.ts`), missions written from the
macro-actions (`policyFromMacroActions`), the classifier branch by branch (every refusal included,
the layered risks of a deletion), `execute` and `discoverResources` against `mockFetch` (headers,
query, page header, bodies field by field, failures, declines with nothing sent), hostile
identifiers in every id position of both sides, and the credential's guide and `verify`. No test
calls Axonaut.

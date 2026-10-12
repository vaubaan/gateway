# Provider plugins

One folder per provider, published as `@vaubaan/plugin-<provider>`. A plugin
declares a provider's tools and data model, classifies each call into the
risks of its catalog (`risk-catalog.yaml`), executes the call upstream with
the credential the gateway holds, and declares how that credential is
obtained and refreshed.

Current plugins: `cloudflare-dns`, `github`, `gmail`, `railway`, `resend`,
`ssh`, `stripe`, `supabase`, `upstash-redis`, `vercel`.

## Writing a plugin

The plugin contract (`ProviderPlugin`, `CredentialSpec`, the registry and
the test kit) is being extracted into `packages/plugin-sdk` as part of the
v5 plan (feature P0.2). Until it lands, the ten plugins above are the
reference: each one ships `data-model.ts`, `risk-catalog.yaml` with its
TypeScript twin, `risk-classifier.ts`, `tools.ts`, an adapter, and unit
tests under `tests/unit/` that exercise the classifier without any network
call.

The risk model the catalogs follow is specified in
[`docs/spec/gateway-risk-model.md`](../docs/spec/gateway-risk-model.md);
the per-provider modelling notes are under
[`docs/handbook/providers/`](../docs/handbook/providers/).

## Contributing

Read [`CONTRIBUTING.md`](../CONTRIBUTING.md) first (doc-first rule,
English only, local CI gate). Open a
[plugin request](../.github/ISSUE_TEMPLATE/plugin_request.yml) issue
before starting a new provider so the risk catalog can be discussed
up front.

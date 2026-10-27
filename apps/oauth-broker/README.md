# OAuth broker

An OAuth broker that **keeps no token**, runs in an **attested enclave**
(Google Confidential Space first), and is small enough to be read in an hour.

It lets a Vaubaan Gateway instance connect a provider that offers no key and
no dynamic client registration — Google Calendar — through one verified OAuth
client, without whoever operates the broker being able to use anyone's
tokens. The instance keeps the refresh token, sealed so that only its own
broker key opens it; the broker adds the client secret when that instance
asks to refresh, and keeps nothing.

- **What and why**: spec [`docs/spec/oauth-broker.md`](../../docs/spec/oauth-broker.md),
  ADR [`oauth-broker-stateless-in-an-attested-enclave`](../../docs/decisions/oauth-broker-stateless-in-an-attested-enclave.md).
- **The calls** between a gateway and a broker:
  [`docs/handbook/oauth-broker-contract.md`](../../docs/handbook/oauth-broker-contract.md).
- **How it works, configuration, running it in Confidential Space, verifying a
  release**: [`docs/handbook/oauth-broker.md`](../../docs/handbook/oauth-broker.md).

## In one screen

```
gateway ──TLS (enclave key, attested)──▶ :8443  POST /flows /grants/redeem /token /revoke /attest
browser ──HTTPS front──▶ :8080  GET /oauth/callback/<provider>   GET /healthz
```

- No dependency outside Node 26; Node runs the TypeScript in `src/` as is.
- Flows live ten minutes, in memory, at most 500 per instance. Nothing is
  written to disk.
- `/attest` takes no key and no body: it answers a cached attestation bound
  to the API's TLS key.
- The configuration holds digests only: Confidential Space puts it in the
  attestation, which anyone can read.
- Provider endpoints and scopes are compiled in (`src/providers.ts`), never
  configured.
- The platform adapter (`src/platform/`) attests and unseals the client
  secret; `local` is for development and says `platform: "none"`.

## Run it locally

```bash
OAUTH_BROKER_PLATFORM=local OAUTH_BROKER_CONFIG="$(cat broker.json)" \
  npm start --workspace @vaubaan/oauth-broker
```

The configuration format is in the handbook ("Configuration").

## Test it

```bash
npx vitest run apps/oauth-broker
```

## Release and verify

Tag `oauth-broker-v<version>` on `main`: the workflow
`.github/workflows/oauth-broker-image.yml` builds the image reproducibly,
signs it with cosign, and publishes its digest. To rebuild and compare, see
the handbook ("Verifying a release").

Licence: Apache-2.0, as the rest of the repository.

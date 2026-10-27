---
title: OAuth broker — how it works, how to run it in Confidential Space, how to verify a release
status: current
date: 2026-10-27
last_synced: 2026-10-27
tracks:
  - apps/oauth-broker/src/
  - apps/oauth-broker/Dockerfile
  - apps/oauth-broker/package.json
  - apps/oauth-broker/tests/
  - .github/workflows/oauth-broker-image.yml
---

# OAuth broker

`apps/oauth-broker` is the broker of ADR
[oauth-broker-stateless-in-an-attested-enclave](../decisions/oauth-broker-stateless-in-an-attested-enclave.md)
and of its amendment "review": it keeps no token, it is small enough to be
read in an hour, its image is reproducible and signed, and it runs in Google
Confidential Space. What it does and why: spec
[oauth-broker](../spec/oauth-broker.md). The calls between a gateway and a
broker: [oauth-broker-contract](oauth-broker-contract.md). The implementation
choices (no dependency, no build step, the certificate written by hand): ADR
[oauth-broker-runs-its-typescript-source-with-no-dependency](../decisions/oauth-broker-runs-its-typescript-source-with-no-dependency.md).

It is a generic component: anyone can run it, enroll instances with it and
publish its measurement; nothing in it knows who operates it.

## Shape

About 1 800 lines of TypeScript, comments included, no dependency outside
Node's standard library. Node 26 runs the `.ts` files as they are (type
stripping): the image holds the very sources a reviewer reads.

| File                                           | Does                                                                                                                                                                 |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main.ts`                                  | Entry point: reads `OAUTH_BROKER_PLATFORM` and `OAUTH_BROKER_CONFIG`, then `startBroker`. A start failure exits with a reason that names no secret.                  |
| `src/app.ts`                                   | Assembles the broker: unseals every client secret and the sealing key, creates the TLS identity, fetches the first attestation, starts both listeners, sweeps flows. |
| `src/broker.ts`                                | The core: authentication by key digest, the five API calls, the browser callback.                                                                                    |
| `src/flows.ts`                                 | Flows in memory: 10 minutes for a flow, 5 for its grant, a grant spent by its first redeem attempt; at most 500 per instance and 10 000 in all.                      |
| `src/sealing.ts`                               | Refresh tokens sealed to their instance: AES-256-GCM, `v1.` prefix, the enrollment id and the provider as additional data.                                           |
| `src/attestation.ts`                           | The attestation served by `/attest`: one token in memory, nonce = the TLS key's SPKI digest, refreshed every 5 minutes and 15 s after a failure.                     |
| `src/oauth-client.ts`                          | The three provider calls (code exchange with PKCE, refresh, revocation); the client secret is added here.                                                            |
| `src/providers.ts`                             | The providers served, **compiled in**: endpoints and allowed scopes. Google only.                                                                                    |
| `src/config.ts`                                | Parses the operator's configuration: public URL, ports, client ids, enrolled instances **as digests**, platform settings.                                            |
| `src/tls-identity.ts`                          | A P-256 key pair generated at start and a self-signed X.509 v1 certificate for it, in memory; the SHA-256 of its SPKI.                                               |
| `src/server.ts`                                | The two listeners, their routes, timeouts, connection limit and access log.                                                                                          |
| `src/rate-limit.ts`                            | Token buckets for the unauthenticated `POST /attest`: per source address (least recently seen forgotten first) and global.                                           |
| `src/http-util.ts`, `crypto-util.ts`, `log.ts` | Body reading (16 KiB at most, JSON only), answers, PKCE S256, constant-time comparison, the JSON-lines logger.                                                       |
| `src/platform/types.ts`                        | The adapter interface `{ attest(nonces), unsealSecret(name) }` and the attestation audience `oauth-broker-attestation`.                                              |
| `src/platform/gcp-confidential-space.ts`       | The Confidential Space adapter.                                                                                                                                      |
| `src/platform/local.ts`                        | The development adapter: evidence `platform: "none"`, secrets from the configuration.                                                                                |

## Listeners

| Listener    | Default port | Protocol                                                    | Serves                                                          | Sits behind                                                                 |
| ----------- | ------------ | ----------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------- |
| gateway API | 8443         | TLS 1.3, with the in-memory key and self-signed certificate | `POST /flows`, `/grants/redeem`, `/token`, `/revoke`, `/attest` | a **TCP passthrough** only: TLS must end in the enclave (ADR D6)            |
| browser     | 8080         | plain HTTP                                                  | `GET /oauth/callback/<provider>`, `GET /healthz`                | the operator's public HTTPS front (load balancer with a public certificate) |

Each serves its own paths only (404 otherwise, 405 for another method).
Limits: TLS handshake 10 s, headers 10 s, request 30 s, keep-alive 5 s, 1 024
connections per listener; provider and platform calls 10 to 15 s. The gateway
does not trust the API's certificate through a certificate authority: it
calls `POST /attest` on the connection and pins the key the attestation names.

## The calls, as implemented

The wire contract is [oauth-broker-contract](oauth-broker-contract.md). Errors
are `{"error": "<code>", "message": "<text>"}`. Every call but the callback
and `POST /attest` needs `Authorization: Bearer <broker key>`, else
`401 invalid_key`. The key is hashed (SHA-256) and compared, in constant time,
with **every** enrolled digest.

| Call                      | Success                                                                 | Refusals                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /flows`             | `201 {authorize_url}`                                                   | `400 unsupported_provider`, `400 invalid_scope` (none, more than 20, repeated, or outside the compiled-in list), `403 return_url_not_registered` (not https, or its SHA-256 not on record for this instance), `400 invalid_request` (state not 20–128 `[A-Za-z0-9_-]`, challenge not 43 base64url characters, method not `S256`), `429 rate_limited` (500 flows in progress for this instance), `503 temporarily_unavailable` (10 000 in all) |
| `GET /oauth/callback/<p>` | `302 <return_url>?grant=…&state=…`                                      | `302 <return_url>?error=<code>&state=…` (the provider's code if it is `[a-z_]{1,40}`, else `server_error`); `400` text page for an unknown, expired or already answered flow                                                                                                                                                                                                                                                                  |
| `POST /grants/redeem`     | `200 {refresh_token, access_token, expires_at, account, scopes}`        | `400 invalid_grant` for everything: unknown, spent, expired, another instance, wrong verifier, provider refusal or failure, no refresh token in the provider's answer                                                                                                                                                                                                                                                                         |
| `POST /token`             | `200 {access_token, expires_at, scopes?}`                               | `400 invalid_grant` (the sealed token is not this instance's, is altered, or the provider answered `invalid_grant`), `502 temporarily_unavailable` (anything else from the provider)                                                                                                                                                                                                                                                          |
| `POST /revoke`            | `204` (also when the provider answers `invalid_token`: already revoked) | `400 invalid_grant` (the sealed token is not this instance's, or is altered), `502 temporarily_unavailable`                                                                                                                                                                                                                                                                                                                                   |
| `POST /attest`            | `200 {platform, evidence}`                                              | `429 rate_limited` with `Retry-After`, `503 temporarily_unavailable` (no attestation fetched in the last 9 minutes)                                                                                                                                                                                                                                                                                                                           |

Details the contract leaves to the broker:

- `authorize_url` carries `client_id`, `redirect_uri` =
  `<public_url>/oauth/callback/<provider>`, `response_type=code`, the scopes,
  `state` = the flow id (32 random bytes), `code_challenge` = S256 of the
  broker's **own** verifier, `code_challenge_method=S256`, and for Google
  `access_type=offline`, `prompt=consent`.
- The return URL is on record as a digest only: `/flows` computes the SHA-256
  of the `return_url` the gateway sends, compares it with the instance's
  digests, keeps that URL in the flow, and the callback sends the browser to
  it.
- The code waits in the flow, unexchanged; a second callback for the same
  flow is refused. The redeem takes the flow out of memory first (spent by
  the attempt), checks the instance and `BASE64URL(SHA256(verifier))` against
  the gateway's challenge, and only then exchanges the code with the client
  secret and the broker's verifier.
- **`refresh_token` is sealed to the instance** (`src/sealing.ts`):
  `v1.<base64url(iv | ciphertext | tag)>`, AES-256-GCM, additional data
  `v1|<enrollment id>|<provider>`. The gateway keeps it as an opaque string and
  sends it back as is to `/token` and `/revoke`, which open it with the
  authenticated instance's enrollment id: another instance's key, an altered
  blob or the provider's raw token is `400 invalid_grant`, and the provider is
  not called. Unenrolling an instance, or enrolling its key again under
  another id, ends every token it holds.
- `account` is the `email` claim of the ID token in the provider's answer,
  when the scopes include `openid` and `email`; otherwise `null`.
  `expires_at` is `now + expires_in`; `scopes` is the provider's `scope`, else
  the scopes asked.
- **`POST /attest`** takes no key and no body (a body sent is ignored). It
  answers the token in memory: fetched from the platform at start, every 5
  minutes, and 15 s after a failed fetch; never per request. Its `eat_nonce` is
  exactly `[base64url(SHA-256(DER SPKI of the API's TLS key))]`, its audience
  `oauth-broker-attestation`. No token fetched in the last 9 minutes: `503`
  (the gateway refuses one older than 10 minutes anyway). Rate limit, per
  source address: a burst of 30, then 5 per second; all callers together: a
  burst of 1 000, then 300 per second.

## Configuration

Two environment variables, nothing else:

| Variable                | Set by                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `OAUTH_BROKER_PLATFORM` | the image (`gcp-confidential-space`); `local` for development. The launch policy forbids overriding it. |
| `OAUTH_BROKER_CONFIG`   | the operator: one JSON document (below). Removed from the process environment once read.                |

**The configuration is public.** Confidential Space measures the container's
environment, values included, into the attestation token
(`submods.container.env`, `env_override`), and `POST /attest` gives that
token to anyone. So the configuration holds no name, no key and no URL of a
customer: opaque ids and SHA-256 digests only. What remains readable by
anyone: `public_url` and the ports, each provider's `client_id` (public
anyway: it is in every consent URL), the platform settings (the federation
provider and the project holding the secrets), the number of instances and
their opaque ids.

```json
{
  "public_url": "https://broker.example.com",
  "api_port": 8443,
  "http_port": 8080,
  "providers": {
    "google": {
      "client_id": "1234-abc.apps.googleusercontent.com",
      "client_secret_name": "google-client-secret"
    }
  },
  "instances": [
    {
      "id": "i_5f1c9a07e2b4",
      "key_sha256": "<hex SHA-256 of the broker key>",
      "return_url_sha256": ["<hex SHA-256 of the exact return URL>"]
    }
  ],
  "platform": {
    "gcp-confidential-space": {
      "workload_identity_provider": "//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/oauth-broker/providers/attestation",
      "secret_project": "my-broker-project"
    }
  }
}
```

| Key                     | Rule                                                                                                                                                                                                                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `public_url`            | https (http on a loopback host for development), no query; the redirect URI registered with the OAuth client is `<public_url>/oauth/callback/<provider>`.                                                                                                                               |
| `api_port`, `http_port` | Optional, 8443 and 8080. The image exposes those two.                                                                                                                                                                                                                                   |
| `providers.<id>`        | Only a provider compiled into the image (`google`). `client_id` is public; `client_secret_name` (default `<id>-client-secret`) is the name the platform adapter unseals. The secret itself is never in the configuration.                                                               |
| `instances[]`           | **Enrollment.** `id`: opaque, `[A-Za-z0-9_-]{8,64}`, unique — random, never a customer's name (it is readable, and it seals the instance's tokens). `key_sha256`: 64 lowercase hex, unique. `return_url_sha256`: the SHA-256, lowercase hex, of each exact return URL of that instance. |
| `platform.<platform>`   | The settings of the adapter the image runs (below). `platform.local.secrets` holds the development secrets.                                                                                                                                                                             |

**Enrolling an instance.** The operator generates a key, gives it to the
instance's administrator (who sets `oauth_brokers.<name>.key` on the gateway),
and keeps only digests:

```bash
id="i_$(openssl rand -hex 6)"
key="bk_$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
printf %s "$key" | sha256sum | cut -c1-64        # → key_sha256
printf %s 'https://gateway.acme.example/connections/callback/google-calendar' \
  | sha256sum | cut -c1-64                        # → return_url_sha256
```

The return URL is hashed exactly as the gateway sends it (no trailing slash
added or removed). Enrollment is the operator's to decide and cannot reach a
token (spec §4): a return URL the operator adds can only receive grants of
flows started with that instance's key, and a grant is worthless without the
instance's verifier. Changing the enrollment is a restart with the new
configuration; the flows in progress are lost (spec open question 1). An
instance's id must not change while it is enrolled: its sealed tokens open
only under that id.

## Platform adapters

The core calls `attest(nonces)` and `unsealSecret(name)` and nothing else of
the platform (ADR D5). At start, `unsealSecret` is called for each provider's
client secret and for `refresh-token-sealing-key` (32 bytes, base64).

### `gcp-confidential-space`

- **attest**: `POST http://localhost/v1/token` on the launcher's Unix socket
  `/run/container_launcher/teeserver.sock`, body
  `{"audience":"oauth-broker-attestation","token_type":"OIDC","nonces":["<SPKI digest>"]}`.
  The answer is the JWT itself (not JSON), signed by Google, issuer
  `https://confidentialcomputing.googleapis.com`. Confidential Space accepts
  up to six nonces of 10 to 74 bytes; ours is one of 43. Called every 5
  minutes, never per request: Google limits these requests to 5 per second per
  project and region.
- **unsealSecret(name)**: `GET http://localhost/v1/token` on the same socket
  (the default attestation token, audience `https://sts.googleapis.com`) →
  `POST https://sts.googleapis.com/v1/token` (token exchange: `audience` = the
  Workload Identity Federation provider, `subject_token_type`
  `urn:ietf:params:oauth:token-type:jwt`, scope `cloud-platform`) → `GET
https://secretmanager.googleapis.com/v1/projects/<secret_project>/secrets/<name>/versions/latest:access`
  with the federated token → `payload.data`, base64, trimmed. Any failure is a
  `PlatformError` naming the step (unreachable, status, not JSON, no payload,
  empty) and stops the start. The federation provider's attribute condition
  and the secret's binding decide which image may have it.

**What a gateway's verifier checks in this evidence** (the gateway's side,
for whoever builds it): signature against the JWKS of
`https://confidentialcomputing.googleapis.com/.well-known/openid-configuration`;
`iss` that issuer; `aud` = `oauth-broker-attestation`; `exp`, and `iat` at
most 10 minutes old; `eat_nonce` = exactly `[SHA-256 of the SPKI the TLS
connection presented]`; `swname` = `CONFIDENTIAL_SPACE`; `dbgstat` =
`disabled-since-boot` (production image); `secboot` = `true`; `STABLE` in
`submods.confidential_space.support_attributes`;
`submods.container.image_digest` on the release's allowlist.

### `local`

For development and tests. Evidence: an unsigned token of the same shape
(`alg: none`, `aud`, `eat_nonce`), `platform: "none"`, which a gateway accepts
only for a broker declared `attestation: none`. Secrets, the sealing key
included, from `platform.local.secrets` — development only, since the
configuration is not secret.

## Logging

One JSON line per event on stdout: `started` (platform, ports, providers,
number of instances, the TLS public key digest), `request` (listener,
method, **route template**, status, duration), `attestation_failed`,
`unexpected_error` and `start_failed` (the error's class name; a
configuration or platform error's own message, which names no secret). Never
a body, a URL with its query (the callback carries the code), a header, a
token, a code, a verifier, a state, a grant or a key; the integration test
asserts it. The launch policy lets these logs reach Cloud Logging
(`log_redirect=always`); spec open question 4.

## Running it locally

```bash
OAUTH_BROKER_PLATFORM=local OAUTH_BROKER_CONFIG="$(cat broker.json)" \
  npm start --workspace @vaubaan/oauth-broker
```

with `public_url` on `http://127.0.0.1:8080`, and `google-client-secret` and
`refresh-token-sealing-key` (`openssl rand -base64 32`) under
`platform.local.secrets`. A gateway reaches it with
`oauth_brokers.<name>.attestation: none`.

## Running it in Google Confidential Space

The operator's checklist. `PROJECT`, `PROJECT_NUMBER`, `ZONE` are the
operator's; `DIGEST` is the release's image digest.

1. **APIs**: enable `compute.googleapis.com`,
   `confidentialcomputing.googleapis.com`, `sts.googleapis.com`,
   `secretmanager.googleapis.com`, `logging.googleapis.com`.
2. **Workload service account** `oauth-broker-workload@PROJECT.iam.gserviceaccount.com`,
   with `roles/confidentialcomputing.workloadUser` (to obtain attestation
   tokens) and `roles/logging.logWriter` (for the redirected logs). Nothing
   else: it is not given the secrets.
3. **The OAuth client** (Google Auth Platform): type **Web application**, one
   authorized redirect URI `https://<public host>/oauth/callback/google`; the
   consent screen and verification of
   [oauth-broker-contract](oauth-broker-contract.md), "What a broker operator
   provides". Whoever owns this project can create further client secrets at
   any time (ADR amendment "review").
4. **Secret Manager**, two secrets, created with no copy kept:
   ```bash
   gcloud secrets create google-client-secret --replication-policy=automatic
   gcloud secrets versions add google-client-secret --data-file=-   # paste the client secret, Ctrl-D
   gcloud secrets create refresh-token-sealing-key --replication-policy=automatic
   openssl rand -base64 32 | gcloud secrets versions add refresh-token-sealing-key --data-file=-
   ```
   The sealing key must never be rotated by a new version while instances are
   enrolled: every refresh token they hold would stop opening (spec open
   question 6).
5. **Workload Identity Federation**, and both secrets bound to the image
   digest:
   ```bash
   gcloud iam workload-identity-pools create oauth-broker --location=global
   gcloud iam workload-identity-pools providers create-oidc attestation \
     --location=global --workload-identity-pool=oauth-broker \
     --issuer-uri="https://confidentialcomputing.googleapis.com" \
     --allowed-audiences="https://sts.googleapis.com" \
     --attribute-mapping="google.subject=\"gcpcs::\"+assertion.submods.container.image_digest+\"::\"+assertion.submods.gce.project_number+\"::\"+assertion.submods.gce.instance_id,attribute.image_digest=assertion.submods.container.image_digest" \
     --attribute-condition="assertion.swname == 'CONFIDENTIAL_SPACE' && 'STABLE' in assertion.submods.confidential_space.support_attributes && assertion.dbgstat == 'disabled-since-boot' && 'oauth-broker-workload@PROJECT.iam.gserviceaccount.com' in assertion.google_service_accounts"
   for secret in google-client-secret refresh-token-sealing-key; do
     gcloud secrets add-iam-policy-binding "$secret" \
       --role=roles/secretmanager.secretAccessor \
       --member="principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/oauth-broker/attribute.image_digest/DIGEST"
   done
   ```
   Each binding names **one image digest**: only that image, attested on the
   production Confidential Space image, obtains the secrets. A new release adds
   bindings for its digest; the old ones are removed once the gateways moved
   (ADR D5).
6. **The configuration**, digests only (see "Configuration"): an opaque `id`,
   `key_sha256` and `return_url_sha256` per instance; no name, no key, no URL
   of a customer. It is readable by anyone from the attestation.
7. **The image** must be pullable by the VM: the GHCR package public, or a
   copy by digest in Artifact Registry (then `roles/artifactregistry.reader`
   for the workload service account). Always reference it **by digest**.
8. **Network**: a static external IP for the VM. Firewall: `tcp:8443` from
   the gateways (the internet, or their egress addresses) straight to the VM
   or through a **passthrough** network load balancer — never a load balancer
   that terminates TLS; `tcp:8080` only from the public front (for a Google
   external Application Load Balancer, its proxy and health-check ranges
   `35.191.0.0/16`, `130.211.0.0/22`).
9. **The public front** for browsers: HTTPS with a public certificate for the
   host of `public_url`, forwarding to the VM's port 8080, health check
   `GET /healthz`. The API's host name (e.g. `api.broker.example.com`) points
   at the VM's address, port 8443; the gateway's `oauth_brokers.<name>.url` is
   `https://api.broker.example.com:8443`.
10. **The VM**:
    ```bash
    gcloud compute instances create oauth-broker --zone=ZONE \
      --machine-type=n2d-standard-2 --confidential-compute-type=SEV \
      --shielded-secure-boot --maintenance-policy=MIGRATE \
      --image-project=confidential-space-images --image-family=confidential-space \
      --service-account=oauth-broker-workload@PROJECT.iam.gserviceaccount.com \
      --scopes=cloud-platform --address=<static IP> \
      --metadata="^~^tee-image-reference=ghcr.io/<owner>/oauth-broker@DIGEST~tee-restart-policy=Always~tee-container-log-redirect=cloud_logging~tee-env-OAUTH_BROKER_CONFIG=$(jq -c . broker.json)"
    ```
    The **production** image family `confidential-space`, never
    `confidential-space-debug` (which the attribute condition refuses anyway).
    The configuration must not contain `~`, the metadata delimiter chosen
    here. Any other `tee-env-*`, `tee-cmd`, `tee-mount` or capability is
    refused by the image's launch policy and the VM does not start the
    container.
11. **Check**: the serial console or Cloud Logging shows `started` with the
    TLS key digest and no `attestation_failed`; `/healthz` answers through the
    front; `POST /attest` answers; a gateway's attestation succeeds.

The launch policy, read by the launcher from the image's labels (hence part
of what is measured): `allow_env_override=OAUTH_BROKER_CONFIG`,
`allow_cmd_override=false`, `allow_capabilities=false`, `allow_cgroups=false`,
`monitoring_memory_allow=never`, `log_redirect=always`, no mount destination.

## Releasing

1. Bump `version` in `apps/oauth-broker/package.json` and add a CHANGELOG
   bullet, in a pull request to `main`.
2. Once merged, push the tag `oauth-broker-v<version>` on that commit.
   `.github/workflows/oauth-broker-image.yml` (that trigger only), in order:
   checks the version and that the commit is on `main`; **builds twice from
   scratch** for `linux/amd64` to OCI tarballs (`SOURCE_DATE_EPOCH` = the
   commit time, `rewrite-timestamp=true`, OCI media types, no provenance or
   SBOM manifest — they would change the digest) **and fails unless both
   digests are equal**; only then pushes `ghcr.io/<owner>/oauth-broker:<version>`
   from the same layers, refusing a pushed digest that is not the checked one;
   signs that digest keylessly with cosign (the certificate names this
   workflow at this tag; the signature is recorded in Rekor) and verifies it;
   publishes a GitHub release (never marked latest) with the digest, the
   measurement and the commands below. Nothing is public before the
   comparison passes.
3. **The measurement** for Confidential Space is the image digest itself
   (`submods.container.image_digest` of the attestation). It reaches gateways
   only through a gateway release whose allowlist names it (ADR D4), and the
   operator's federation bindings (step 5 above).

## Verifying a release

Anyone, without trusting the operator or the CI:

```bash
git checkout oauth-broker-v<version>
SOURCE_DATE_EPOCH=$(git log -1 --pretty=%ct) docker buildx build --no-cache \
  --platform linux/amd64 --provenance=false --sbom=false --metadata-file rebuild.json \
  --output type=oci,dest=broker.tar,oci-mediatypes=true,rewrite-timestamp=true \
  -f apps/oauth-broker/Dockerfile apps/oauth-broker
jq -r '."containerimage.digest"' rebuild.json       # must equal the release's digest

cosign verify ghcr.io/<owner>/oauth-broker@<digest> \
  --certificate-identity "https://github.com/<owner>/<repo>/.github/workflows/oauth-broker-image.yml@refs/tags/oauth-broker-v<version>" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

`cosign verify` checks the certificate and the signature's inclusion in the
Rekor transparency log; the log entry it prints can be read again with
`rekor-cli get --log-index <index>`. The same digest was obtained with
BuildKit's `docker` and `docker-container` drivers, and with the `oci` and
`image` exporters (BuildKit 0.13 or later is needed for `rewrite-timestamp`).

## What was verified, and where

On 2026-10-27:

- **Context7**: the Workload Identity Federation STS exchange (endpoint,
  parameters, audience format of a workload pool provider), Secret Manager's
  `versions/<v>:access` and its `payload.data`, Google's OAuth endpoints
  (`/o/oauth2/v2/auth`, `oauth2.googleapis.com/token`, `/revoke`, `access_type`,
  the token answer), cosign keyless signing and `verify` flags, BuildKit
  `SOURCE_DATE_EPOCH` and `rewrite-timestamp`.
- **Not in Context7** (no index of the Confidential Space pages): read from
  Google's Confidential Space documentation ("Access resources not managed by
  Google Cloud IAM", "Create and customize workloads", "Deploy workloads",
  "Create and grant access to confidential resources", "Token claims") and
  from the launcher's source (`github.com/google/go-tpm-tools`, `launcher/`):
  the socket path, the `/v1/token` handler (GET default token, POST
  `{audience, nonces, token_type}`, answer = the JWT as body), the nonce
  limits, the default audience `https://sts.googleapis.com`, the launch-policy
  label names and values (`tee.launch_policy.*`), the `tee-*` metadata keys,
  `EXPOSE` opening ports.
- **The environment is in the attestation.** Google's token claims reference:
  `submods.container.env` is "the environment variables and their values that
  have been explicitly passed to the container", `env_override` "the
  overwritten environment variables". The launcher's source
  (`launcher/container_runner.go`) measures every variable of the container
  as `NAME=value` (`EnvVarType`) and each `tee-env-*` override again
  (`OverrideEnvType`). So `OAUTH_BROKER_CONFIG`, value included, is readable by
  whoever holds an attestation token: hence the digests-only configuration.

## Tests

`apps/oauth-broker/tests/`, in `npm run test` (scenarios:
[integration-tests](../tests/integration-tests.md), "OAuth broker"):

- `unit/crypto-and-tls.test.ts` — PKCE S256 (RFC 7636 appendix B), the
  self-signed certificate (parses, verifies, matches its key, SPKI digest).
- `unit/config-and-flows.test.ts` — configuration rules (digests only, opaque
  ids); flow and grant lifetimes, one callback per flow, a grant spent by its
  first attempt, the global cap, the per-instance cap.
- `unit/sealing-and-attestation.test.ts` — sealed tokens (open for their
  instance and provider only, refused when altered, raw or under another key;
  the key format); the attestation cache (the SPKI digest as only nonce, served
  from memory, nothing before a first success or too old, kept across a failed
  refresh, refreshed in the background).
- `unit/gcp-confidential-space.test.ts` — the adapter against a fake TEE
  server on a real Unix socket and a fake `fetch`: the custom-token body, the
  STS form, the Secret Manager URL, refusals with a named reason (STS or
  Secret Manager not JSON, unreachable, no payload, empty secret, missing
  socket).
- `unit/rate-limit.test.ts` — the attestation buckets: burst and refill per
  address, the global cap, the bounded memory of addresses, least recently
  seen forgotten first.
- `unit/image.test.ts` — the Dockerfile: one base pinned by digest (the
  gateway's), no frontend, nothing installed, read-only sources, the platform
  fixed, the launch policy.
- `integration/broker-flow.test.ts` — the whole broker over its two
  listeners, a fake provider and the local adapter: the full flow (the sealed
  refresh token then refreshes), refusals at the provider, expiry, wrong
  instance, wrong verifier, flow refusals, refresh, revocation, sealed tokens
  refused for another instance, altered, raw, or after the instance is
  unenrolled or re-enrolled, the per-instance flow cap, the cached
  attestation bound to the TLS key, without key or body, rate-limited,
  listener separation, logs free of secrets.

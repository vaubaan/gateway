---
title: OAuth broker — running it in Confidential Space or without an enclave, releasing and verifying its image
tracks:
  - apps/oauth-broker/src/
  - apps/oauth-broker/Dockerfile
  - apps/oauth-broker/package.json
  - apps/oauth-broker/tests/
  - packages/oauth-providers/
  - .github/workflows/oauth-broker-image.yml
last_reviewed: 2026-11-05
---

# OAuth broker — handbook

`apps/oauth-broker`, the broker that keeps no token and runs in Google Confidential Space, or
without an enclave behind the platform's TLS (`unattested`). Spec:
[oauth-broker](../spec/oauth-broker.md); the wire contract:
[oauth-broker-contract](oauth-broker-contract.md); ADRs
[oauth-broker-stateless-in-an-attested-enclave](../decisions/oauth-broker-stateless-in-an-attested-enclave.md),
[oauth-broker-can-run-without-an-enclave](../decisions/oauth-broker-can-run-without-an-enclave.md),
[oauth-broker-runs-its-typescript-source-with-no-dependency](../decisions/oauth-broker-runs-its-typescript-source-with-no-dependency.md).

## Start here

- [`src/app.ts`](../../apps/oauth-broker/src/app.ts) — the start: unseal secrets, then TLS
  identity, first attestation and both listeners; or, for a platform that does not attest, one
  plain HTTP listener.
- [`src/broker.ts`](../../apps/oauth-broker/src/broker.ts) — authentication by key digest, the
  calls, the browser callback.
- [`src/config.ts`](../../apps/oauth-broker/src/config.ts) — the `OAUTH_BROKER_CONFIG` format.
- [`src/platform/gcp-confidential-space.ts`](../../apps/oauth-broker/src/platform/gcp-confidential-space.ts)
  — attest and unseal through the launcher's socket, STS and Secret Manager.
- [`src/platform/unattested.ts`](../../apps/oauth-broker/src/platform/unattested.ts) — no
  enclave: secrets from `OAUTH_BROKER_SECRET_<NAME>`, nothing to attest.

## Invariants

- **The configuration is public**: Confidential Space measures every container variable, value
  included (`submods.container.env`), into the token `/attest` gives anyone. Enrollment is an
  opaque `id`, `key_sha256` and `return_url_sha256[]`; never a key, a URL or a customer's name.
- **Provider endpoints and allowed scopes are compiled in**, never configured: no configuration
  can send the client secret elsewhere. The table's source is
  [`packages/oauth-providers/src/providers.ts`](../../packages/oauth-providers/src/providers.ts)
  (`@vaubaan/oauth-providers`), which the gateway imports to refuse at boot a brokered plugin whose
  provider or scopes it does not list (`checkBrokeredPlugins`, `server/compose/registry.ts`).
  `src/providers.ts` is a **byte-identical copy**, not an import: the image builds from
  `apps/oauth-broker` alone and runs its own sources with no dependency and no build step (ADR
  [oauth-broker-runs-its-typescript-source-with-no-dependency](../decisions/oauth-broker-runs-its-typescript-source-with-no-dependency.md)),
  so the measured image holds the table a reviewer reads. `tests/unit/provider-table-copy.test.ts`
  fails when the two differ: edit the package's file, then copy it over the broker's. Adding a
  scope is a release of both (a broker image, its measurement, a gateway release).
- **An instance's `id` seals its tokens** (`sealing.ts`, additional data `v1|<id>|<provider>`):
  changing it, or unenrolling, ends every refresh token that instance holds.
- **Nothing sensitive is logged** (route templates, statuses, durations, class names, a refusal's
  fixed `reason` code); logs leave the enclave (`log_redirect=always`). The integration test
  asserts no secret in the logs.

## Traps

- In an enclave, port 8443 (the API, TLS ending in the enclave) needs a **TCP passthrough**, never a TLS-ending
  load balancer; 8080 (callback, `/healthz`) sits behind the public HTTPS front.
- The return URL is hashed exactly as the gateway sends it (no slash added or removed).
- `microsoft` has no `revokeEndpoint`: `/revoke` answers 204 without calling Microsoft (logged
  `reason: no_revoke_endpoint`). Microsoft also returns a new refresh token on each refresh, which
  `/token` does not pass on (spec open question 2): the instance keeps refreshing with the first
  one until Microsoft lets it lapse, then the account expires and the person reconnects.
- `refresh-token-sealing-key` is never rotated by a new version while instances are enrolled:
  every token they hold would stop opening (spec open question).
- Changing the enrollment is a restart: flows in progress are lost, and so is each instance's count
  of refreshes (`refresh_per_hour`, 600 by default, all providers together; past it `/token`
  answers 429 `rate_limited` with `retry-after`, logged `reason: refresh_limit`, which the gateway
  reads as a broker failure, never an expiry).
- `OAUTH_BROKER_CONFIG` must not contain `~`, the metadata delimiter below. Any other `tee-env-*`,
  `tee-cmd` or mount is refused by the image's launch policy (its labels, so measured).
- Locally: `OAUTH_BROKER_PLATFORM=local`, secrets under `platform.local.secrets`; its evidence says
  `platform: "none"`, so a gateway reaches it only with `attestation: none`. It keeps the enclave's
  two listeners and self-signed TLS key, which no ordinary client accepts: in production outside an
  enclave, use `unattested`.

## Procedures

### Enrolling an instance

1. `key="bk_$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"`, `id="i_$(openssl rand -hex 6)"`;
   hand the key to the instance's administrator (`oauth_brokers.<name>.key`).
2. Keep `printf %s "$key" | sha256sum` and the same for each exact return URL; restart.

### Running it in Confidential Space

1. Enable `compute`, `confidentialcomputing`, `sts`, `secretmanager`, `logging` APIs. Service
   account `oauth-broker-workload@PROJECT.iam.gserviceaccount.com` with
   `roles/confidentialcomputing.workloadUser` and `roles/logging.logWriter`, nothing else.
2. OAuth client of type Web application, redirect URI `https://<public host>/oauth/callback/google`
   ([contract](oauth-broker-contract.md), "Outside the repo").
3. Secrets `google-client-secret` (pasted, no copy kept) and `refresh-token-sealing-key`
   (`openssl rand -base64 32`), `gcloud secrets versions add <name> --data-file=-`.
4. Workload Identity Federation, both secrets bound to one image digest (a binding per released
   digest; drop old ones once gateways moved):

   ```bash
   gcloud iam workload-identity-pools create oauth-broker --location=global
   gcloud iam workload-identity-pools providers create-oidc attestation \
     --location=global --workload-identity-pool=oauth-broker \
     --issuer-uri="https://confidentialcomputing.googleapis.com" \
     --allowed-audiences="https://sts.googleapis.com" \
     --attribute-mapping="google.subject=\"gcpcs::\"+assertion.submods.container.image_digest+\"::\"+assertion.submods.gce.project_number+\"::\"+assertion.submods.gce.instance_id,attribute.image_digest=assertion.submods.container.image_digest" \
     --attribute-condition="assertion.swname == 'CONFIDENTIAL_SPACE' && 'STABLE' in assertion.submods.confidential_space.support_attributes && assertion.dbgstat == 'disabled-since-boot' && 'oauth-broker-workload@PROJECT.iam.gserviceaccount.com' in assertion.google_service_accounts"
   for secret in google-client-secret refresh-token-sealing-key; do
     gcloud secrets add-iam-policy-binding "$secret" --role=roles/secretmanager.secretAccessor \
       --member="principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/oauth-broker/attribute.image_digest/DIGEST"
   done
   ```

5. Image pullable by the VM (GHCR public, or a copy in Artifact Registry), always **by digest**.
   Static IP; firewall `tcp:8443` from gateways, `tcp:8080` from the front only (for a Google
   Application Load Balancer, `35.191.0.0/16`, `130.211.0.0/22`). The API host
   (`api.broker.example.com:8443`) points at the VM: that is the gateway's `oauth_brokers.<name>.url`.
6. The VM, on the **production** image family (the condition refuses `-debug`):

   ```bash
   gcloud compute instances create oauth-broker --zone=ZONE \
     --machine-type=n2d-standard-2 --confidential-compute-type=SEV \
     --shielded-secure-boot --maintenance-policy=MIGRATE \
     --image-project=confidential-space-images --image-family=confidential-space \
     --service-account=oauth-broker-workload@PROJECT.iam.gserviceaccount.com \
     --scopes=cloud-platform --address=<static IP> \
     --metadata="^~^tee-image-reference=ghcr.io/<owner>/oauth-broker@DIGEST~tee-restart-policy=Always~tee-container-log-redirect=cloud_logging~tee-env-OAUTH_BROKER_CONFIG=$(jq -c . broker.json)"
   ```

7. Check: log `started` with the TLS key digest, no `attestation_failed`; `/healthz` through the
   front; a gateway's attestation succeeds.
8. Recommended hardening of the project. A project owner can read both secrets from the console,
   and the two secrets plus a sealed refresh token from an instance's database or backup give
   access to that user's account. Neither secret alone reaches an account.
   - Data Access audit logs, `DATA_READ`, on the Secret Manager API (IAM & Admin → Audit Logs).
     Every read of a secret is then logged with its caller, and any reader other than the
     workload's federated principal deserves an alert.
   - As few project owners and editors as possible, ideally one, each with two-step verification
     enforced. No service account key on the project.

### Running it without an enclave

Platform `unattested` (ADR
[oauth-broker-can-run-without-an-enclave](../decisions/oauth-broker-can-run-without-an-enclave.md)).
Whoever operates the platform can read both secrets and can run other code in the image's place,
seeing every token that passes; the gateways say the broker is not attested.

1. Steps 2 (OAuth client) and 3 (the two secrets) as above, except that each secret goes into an
   environment secret of the platform, pasted, never in a file or the configuration:
   `OAUTH_BROKER_SECRET_GOOGLE_CLIENT_SECRET` and `OAUTH_BROKER_SECRET_REFRESH_TOKEN_SEALING_KEY`.
   The broker removes each from `process.env` once read (the platform's store keeps them).
2. The published image, by digest, with `OAUTH_BROKER_PLATFORM=unattested` and
   `OAUTH_BROKER_CONFIG` (same format; `api_port` unused). One listener on `http_port` (8080)
   serves the API, the callback and `/healthz`, in plain HTTP: the platform ends TLS for one
   public host, which is both `public_url` and the gateways' `oauth_brokers.<name>.url`
   (`https://broker.example.com`, port 443 implied). Route the platform to 8080 (the broker
   ignores `PORT`; set `http_port` to the platform's port instead, and ignore the image's
   `EXPOSE 8443`). One machine: flows live in its memory.
3. Each gateway declares the broker `attestation: none`; `/attest` answers 404 `not_attested`.
4. Check: log `started` with `attested: false`; `/healthz`; a gateway's connect page says
   "not attested".
5. Moving to an enclave: the same sealing key into Secret Manager, the Confidential Space steps
   above, then each gateway back to `attestation: required`. Enrolled instances and their tokens
   carry over.

### Releasing

1. Bump `apps/oauth-broker/package.json` `version` and the CHANGELOG in a PR; once merged, push tag
   `oauth-broker-v<version>` (the workflow builds twice and compares, pushes, signs with cosign,
   publishes a non-latest release with the digest).
2. The digest is the Confidential Space measurement: add it to the gateway's
   `broker-measurements.json` in a gateway release, and add the operator's secret bindings.

### Verifying a release

The signature is in Sigstore's bundle format, stored under the `sha256-<digest>` tag: verify with
cosign 3 or later. cosign 2 answers "no signatures found".

```bash
git checkout oauth-broker-v<version>
SOURCE_DATE_EPOCH=$(git log -1 --pretty=%ct) docker buildx build --no-cache \
  --platform linux/amd64 --provenance=false --sbom=false --metadata-file rebuild.json \
  --output type=oci,dest=broker.tar,oci-mediatypes=true,rewrite-timestamp=true \
  -f apps/oauth-broker/Dockerfile apps/oauth-broker
jq -r '."containerimage.digest"' rebuild.json   # must equal the release's (BuildKit >= 0.13)
cosign verify ghcr.io/<owner>/oauth-broker@<digest> \
  --certificate-identity "https://github.com/<owner>/<repo>/.github/workflows/oauth-broker-image.yml@refs/tags/oauth-broker-v<version>" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## Debug

- **Redeem `400 invalid_grant`** → the `reason` of its `request` log line: `grant_unknown` (never
  issued, already redeemed, or older than its lifetime: a double submit or a back navigation),
  `consent_incomplete` (the callback brought no code), `flow_mismatch` (another instance's key or
  verifier), `provider_not_served`, `provider_refused` (the provider answered `invalid_grant` to the
  code: reused or expired code, redirect URI), `provider_unavailable` (the provider failed or did
  not answer), `no_refresh_token`.

## What was verified

- Context7 (2026-10-27): STS exchange, Secret Manager `:access`, Google OAuth endpoints, cosign,
  BuildKit `rewrite-timestamp`.
- Not in Context7: Google's Confidential Space pages and the launcher's source
  (`google/go-tpm-tools`, `launcher/`): the socket, `/v1/token`, nonce limits (six, 10-74 bytes),
  `tee.launch_policy.*` labels, that every variable is measured.

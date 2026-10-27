# OAuth broker — the image a Confidential Space VM runs as is.
# Reproducible: anyone rebuilds the same digest from the same commit
# (docs/handbook/oauth-broker.md, "Verifying a release"):
#
#   SOURCE_DATE_EPOCH=$(git log -1 --pretty=%ct) docker buildx build \
#     --platform linux/amd64 --provenance=false --sbom=false --no-cache \
#     --output type=oci,dest=broker.tar,rewrite-timestamp=true \
#     -f apps/oauth-broker/Dockerfile apps/oauth-broker
#
# Deterministic by construction: a base pinned by digest, no package install,
# no build step (Node runs the TypeScript sources as they are), files copied
# with a fixed mode, every timestamp set to SOURCE_DATE_EPOCH by the exporter,
# no user created (the base image's `node` user).

# Bump the tag and the digest together, with the gateway's (deploy/docker/Dockerfile).
FROM node:26.12.1-bookworm-slim@sha256:28147155d47dc31abe0a46e0d12b59b2fb3d0a2dcc5dc65fce76a074180b16fe

# The broker needs node and nothing else: no package manager in the image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v* \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg

# The directories exist before the copies, so that the read-only mode of the
# files is not given to them (COPY --chmod applies to directories it creates).
WORKDIR /broker/src/platform
WORKDIR /broker
COPY --chmod=0444 package.json ./
COPY --chmod=0444 src/*.ts ./src/
COPY --chmod=0444 src/platform/*.ts ./src/platform/

# The platform is part of the image, not of the operator's configuration.
ENV NODE_ENV=production \
    OAUTH_BROKER_PLATFORM=gcp-confidential-space

# Confidential Space launch policy (read by the launcher from these labels,
# hence part of the measured image): the operator may set the configuration
# and nothing else — no other variable, no command, no mount, no capability,
# no memory monitoring. Logs may leave: the broker writes no body, token,
# code, verifier or key (src/log.ts).
LABEL "tee.launch_policy.allow_env_override"="OAUTH_BROKER_CONFIG" \
      "tee.launch_policy.allow_cmd_override"="false" \
      "tee.launch_policy.allow_capabilities"="false" \
      "tee.launch_policy.allow_cgroups"="false" \
      "tee.launch_policy.monitoring_memory_allow"="never" \
      "tee.launch_policy.log_redirect"="always" \
      "org.opencontainers.image.title"="oauth-broker" \
      "org.opencontainers.image.licenses"="Apache-2.0"

USER node
# 8443: the gateway API over the enclave's own TLS (TCP passthrough).
# 8080: the browser callback and /healthz, behind the public HTTPS front.
EXPOSE 8443/tcp 8080/tcp
ENTRYPOINT ["node", "--disallow-code-generation-from-strings", "src/main.ts"]

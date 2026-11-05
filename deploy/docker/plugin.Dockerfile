# One pinnable plugin as an image: its bundle and nothing else, to be copied into a
# gateway image (ADR plugins-bundled-or-pinned-by-the-operator; deploy/README.md
# "Pin a plugin"):
#
#   COPY --from=ghcr.io/vaubaan/plugin-<id>:<version> /plugin /plugins/<id>
#
# Built from the repository root after the bundles (scripts/build-plugin-bundle.mjs):
#   node scripts/build-plugin-bundle.mjs <id>
#   docker build -f deploy/docker/plugin.Dockerfile --build-arg PLUGIN=<id> \
#     --build-arg VERSION=<version> --build-arg SOURCE=<repository URL> .
# The context is filtered by plugin.Dockerfile.dockerignore: dist/plugins only.
# No RUN step and no base: the image is the same files on every architecture, so it is
# built for several without emulation. The release workflow publishes it.
FROM scratch
ARG PLUGIN
ARG VERSION=unknown
ARG SOURCE=
COPY dist/plugins/${PLUGIN} /plugin
LABEL org.opencontainers.image.title="vaubaan-plugin-${PLUGIN}" \
      org.opencontainers.image.description="Vaubaan Gateway plugin ${PLUGIN}, pinnable bundle" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.source="${SOURCE}" \
      org.opencontainers.image.licenses="Apache-2.0"

# syntax=docker/dockerfile:1
# DSH Web image whose plugin environment is applied from this repository's dshenv manifest.
# Build: docker build --build-context dshenv=/path/to/dshenv -t my-dsh .
# For reproducible builds, pin the base image by digest, e.g. node:22-slim@sha256:<digest>.
ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-slim AS dshenv-build
ARG PNPM_VERSION=10.30.3
RUN npm install -g "pnpm@${PNPM_VERSION}"
WORKDIR /src
# dshenv is built from a dshenv checkout passed as a named build context, so unreleased changes can be used.
# Copy only build inputs: the checkout has no .dockerignore and may hold host node_modules.
COPY --from=dshenv package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsdown.config.ts README.md ./
COPY --from=dshenv bin ./bin
COPY --from=dshenv src ./src
COPY --from=dshenv templates ./templates
RUN pnpm install --frozen-lockfile && pnpm build && pnpm pack --pack-destination /out

FROM node:${NODE_VERSION}-slim
ARG DSH_VERSION=0.1.7-rc.2
ARG PNPM_VERSION=10.30.3
ARG DSHENV_OVERLAY=
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
# dsh plugin delegates to pnpm, which must be on PATH.
RUN npm install -g "pnpm@${PNPM_VERSION}" "@deepseek-ai/dsh@${DSH_VERSION}"
COPY --from=dshenv-build /out/ /tmp/dshenv/
RUN npm install -g /tmp/dshenv/*.tgz && rm -rf /tmp/dshenv

RUN useradd --create-home --shell /bin/bash dsh
ENV DSH_HOME=/home/dsh/.dsh
USER dsh
WORKDIR /home/dsh
# Created as dsh so the compose named volume mounted here is initialized with dsh ownership.
RUN mkdir -p /home/dsh/.dsh/sessions
COPY --chown=dsh:dsh envctl/ /home/dsh/.dsh/envctl/
# Binds the web server to all container interfaces; see the file for the network exposure this implies.
COPY --chown=dsh:dsh cordis.patch.yml /home/dsh/.dsh/cordis.patch.yml
# plan exits non-zero when the applied environment still differs from the manifest, failing the build.
# --no-overlay stops an empty DSHENV_OVERLAY from falling back to envctl/overlay-selection.json.
RUN set -eu; \
  if [ -n "${DSHENV_OVERLAY}" ]; then set -- --overlay "${DSHENV_OVERLAY}"; else set -- --no-overlay; fi; \
  dshenv apply --yes "$@"; \
  dshenv plan "$@"

# No EXPOSE: `docker run -P` would then publish the port on every host interface.
# No --trusted-host: loopback is always trusted, and an all-interface bind already trusts the container IPs.
CMD ["dsh", "web", "--no-open"]

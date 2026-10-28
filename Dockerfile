# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:22-bookworm-slim
ARG BUN_IMAGE=oven/bun:1.3.13
FROM ${BUN_IMAGE} AS bun
FROM ${NODE_IMAGE} AS base
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN --mount=type=cache,id=infinite-canvas-apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=infinite-canvas-apt-lists,target=/var/lib/apt/lists,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
    && echo 'Binary::apt::APT::Keep-Downloaded-Packages "true";' > /etc/apt/apt.conf.d/keep-cache \
    && apt-get update && apt-get install -y --no-install-recommends bash ca-certificates git
ENV PATH="/app/canvas-agent/node_modules/.bin:${PATH}"

FROM base AS web-deps
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
# ProComponents beta declares an antd 5 peer; package-lock.json is authoritative.
RUN --mount=type=cache,id=infinite-canvas-npm,target=/root/.npm \
    npm ci --prefer-offline --ignore-scripts --no-audit --no-fund --legacy-peer-deps

FROM base AS agent-deps
WORKDIR /app/canvas-agent
COPY canvas-agent/package.json canvas-agent/package-lock.json ./
RUN --mount=type=cache,id=infinite-canvas-npm,target=/root/.npm \
    npm ci --prefer-offline --ignore-scripts --no-audit --no-fund

FROM base AS source
WORKDIR /app
COPY --from=web-deps /app/web ./web
COPY --from=agent-deps /app/canvas-agent ./canvas-agent
COPY VERSION CHANGELOG.md docker-compose.yml docker-entrypoint.sh ./
COPY web ./web
COPY canvas-agent ./canvas-agent
COPY deploy ./deploy

FROM source AS test
RUN --mount=type=cache,id=infinite-canvas-apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=infinite-canvas-apt-lists,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends python3 util-linux
RUN node --test deploy/tests/healthcheck.test.mjs deploy/tests/import-codex-config.test.mjs && python3 deploy/tests/test_deployment.py -v && python3 deploy/tests/test_magpie_gateway.py -v
RUN cd /app/web && bun test tests src/server/ai-response.test.mjs
RUN cd /app/canvas-agent && npm test

FROM web-deps AS web-build
COPY VERSION CHANGELOG.md /app/
COPY web ./
RUN --mount=type=cache,id=infinite-canvas-npm,target=/root/.npm \
    VITE_CANVAS_AGENT_URL=/api/canvas-agent npm run build

FROM agent-deps AS agent-build
COPY canvas-agent ./
RUN --mount=type=cache,id=infinite-canvas-npm,target=/root/.npm \
    npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM base AS office-tools
RUN --mount=type=cache,id=infinite-canvas-apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=infinite-canvas-apt-lists,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-venv curl jq ripgrep file zip unzip \
    poppler-utils pandoc libreoffice-writer libreoffice-calc libreoffice-impress \
    tesseract-ocr tesseract-ocr-eng tesseract-ocr-chi-sim ffmpeg fontconfig fonts-dejavu-core fonts-noto-cjk
COPY deploy/office-requirements.txt /usr/local/lib/infinite-canvas/office-requirements.txt
RUN --mount=type=cache,id=infinite-canvas-pip,target=/root/.cache/pip \
    python3 -m venv /opt/office \
    && /opt/office/bin/python -m pip install -r /usr/local/lib/infinite-canvas/office-requirements.txt
COPY deploy/image-info.py /usr/local/bin/canvas-image-info
COPY deploy/office-tools.md /usr/local/lib/infinite-canvas/office-tools.md
RUN chmod 755 /usr/local/bin/canvas-image-info
ENV PATH="/opt/office/bin:${PATH}" INFINITE_CANVAS_OFFICE_TOOLS=1

FROM office-tools AS runtime
WORKDIR /app
ENV NODE_ENV=production HOME=/home/node PORT=3000 \
    INFINITE_CANVAS_DATA_DIR=/data CODEX_HOME=/home/node/.codex
COPY --from=web-build --chown=node:node /app/web ./web
COPY --from=agent-build --chown=node:node /app/canvas-agent ./canvas-agent
COPY VERSION CHANGELOG.md ./
COPY docker-entrypoint.sh /usr/local/bin/infinite-canvas-entrypoint
COPY deploy/healthcheck.mjs deploy/configure-runtime.mjs /usr/local/lib/infinite-canvas/
RUN chmod +x /usr/local/bin/infinite-canvas-entrypoint \
    && mkdir -p /data /home/node/.infinite-canvas /home/node/.codex \
    && chown node:node /data /home/node/.infinite-canvas /home/node/.codex \
    && chmod 700 /data /home/node/.infinite-canvas /home/node/.codex
USER node
EXPOSE 3000
VOLUME ["/data", "/home/node/.infinite-canvas", "/home/node/.codex"]
HEALTHCHECK CMD ["bun", "/usr/local/lib/infinite-canvas/healthcheck.mjs"]
ENTRYPOINT ["/usr/local/bin/infinite-canvas-entrypoint"]

FROM runtime AS runtime-test
COPY deploy/tests/test_office_runtime.py /tmp/test_office_runtime.py
RUN python /tmp/test_office_runtime.py

FROM runtime AS release

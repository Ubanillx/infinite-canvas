ARG NODE_IMAGE=node:22-bookworm-slim
ARG BUN_IMAGE=oven/bun:1.3.13
FROM ${BUN_IMAGE} AS bun
FROM ${NODE_IMAGE} AS base
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN apt-get update && apt-get install -y --no-install-recommends bash ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
ENV PATH="/app/canvas-agent/node_modules/.bin:${PATH}"

FROM base AS source
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
# ProComponents beta declares an antd 5 peer; package-lock.json is authoritative.
RUN npm ci --ignore-scripts --no-audit --no-fund --legacy-peer-deps
WORKDIR /app/canvas-agent
COPY canvas-agent/package.json canvas-agent/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
WORKDIR /app
COPY VERSION CHANGELOG.md docker-compose.yml docker-entrypoint.sh ./
COPY web ./web
COPY canvas-agent ./canvas-agent
COPY deploy ./deploy

FROM source AS test
RUN apt-get update && apt-get install -y --no-install-recommends python3 util-linux \
    && rm -rf /var/lib/apt/lists/*
RUN node --test deploy/tests/healthcheck.test.mjs && python3 deploy/tests/test_deployment.py -v
RUN cd /app/web && bun test tests src/server/ai-response.test.mjs
RUN cd /app/canvas-agent && npm test

FROM test AS build
RUN cd /app/web && VITE_CANVAS_AGENT_URL=/api/canvas-agent npm run build
RUN cd /app/canvas-agent && npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production HOME=/home/node PORT=3000 \
    INFINITE_CANVAS_DATA_DIR=/data CODEX_HOME=/home/node/.codex
COPY --from=build --chown=node:node /app/web ./web
COPY --from=build --chown=node:node /app/canvas-agent ./canvas-agent
COPY --from=build /app/VERSION /app/CHANGELOG.md ./
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

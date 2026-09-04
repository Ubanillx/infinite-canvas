# 构建 Vite 前端产物。
FROM oven/bun:1.3.13 AS web-build

WORKDIR /app/web
COPY web/package.json web/bun.lock ./
RUN bun install --no-cache
COPY VERSION /app/VERSION
COPY CHANGELOG.md /app/CHANGELOG.md
COPY web ./
RUN bun run build

# 构建 Canvas Agent。Agent 与 Vite preview 在同一容器内运行，保证同源代理和工作区认证可用。
FROM oven/bun:1.3.13 AS agent-build

WORKDIR /app/canvas-agent
COPY canvas-agent/package.json canvas-agent/bun.lock ./
RUN bun install --frozen-lockfile --no-cache
COPY canvas-agent ./
RUN bun run build

# 运行镜像：Vite preview 提供前端、工作区注册和 WebDAV/Agent 同源代理；Canvas Agent 仅监听容器回环地址。
FROM oven/bun:1.3.13

WORKDIR /app
ENV NODE_ENV=production
ENV INFINITE_CANVAS_DATA_DIR=/data

COPY --from=web-build /app/web /app/web
COPY --from=agent-build /app/canvas-agent /app/canvas-agent
COPY VERSION CHANGELOG.md /app/
COPY docker-entrypoint.sh /usr/local/bin/infinite-canvas-entrypoint
RUN chmod +x /usr/local/bin/infinite-canvas-entrypoint \
    && mkdir -p -m 700 /data /root/.infinite-canvas

EXPOSE 3000
VOLUME ["/data", "/root/.infinite-canvas"]
ENTRYPOINT ["/usr/local/bin/infinite-canvas-entrypoint"]

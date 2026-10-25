# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    UV_THREADPOOL_SIZE=8
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends tini curl && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
RUN mkdir -p uploads logs && chown -R node:node /app
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 CMD curl -fsS http://127.0.0.1:4000/health/ready || exit 1
ENTRYPOINT ["/usr/bin/tini", "--"]
# Override with ["node", "src/worker.js"] for the background worker container.
CMD ["node", "src/server.js"]

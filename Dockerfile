# syntax=docker/dockerfile:1
#
# The supported Core deployment shape (docs/DEPLOYMENT.md, ADR 0002): one
# container that runs `node dist/serve.js` against a mounted data directory.
#
#   docker build -t thebe-core:0.1.0 .
#   docker run --rm -p 127.0.0.1:8787:8787 \
#     -e THEBE_TOKEN=... -e THEBE_ALLOWED_HOSTS=... \
#     -v "$PWD/data:/data" -v /path/to/workspace:/workspace \
#     thebe-core:0.1.0
#
# deploy/docker-compose.yml wraps this with the data, workspace, and hardening
# defaults.

FROM node:22.20.0-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json vite.config.ts ./
RUN pnpm install --frozen-lockfile
COPY src ./src
RUN pnpm build

FROM node:22.20.0-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
WORKDIR /app
# Runtime dependencies only. pi-ai ships inside the pi-coding-agent package and
# is resolved from there; `node scripts/check-pi-resolution.mjs` verifies it
# inside the running container.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/dist ./dist
COPY --from=build /app/scripts/smoke.mjs /app/scripts/check-pi-resolution.mjs ./scripts/
RUN mkdir -p /data/config /data/agent /data/store /data/outputs /data/home /workspace \
  && chown -R node:node /data /workspace
USER node
ENV HOME=/data/home \
    THEBE_HOST=0.0.0.0 \
    THEBE_PORT=8787 \
    THEBE_CONFIG_DIR=/data/config \
    THEBE_AGENT_DIR=/data/agent \
    THEBE_AGENT_STORE_DIR=/data/store \
    THEBE_WORKSPACE_DIR=/workspace \
    THEBE_OUTPUT_DIR=/data/outputs
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.THEBE_PORT||8787)+'/v1/health',{headers:{'X-Thebe-Token':process.env.THEBE_TOKEN||''}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/serve.js"]

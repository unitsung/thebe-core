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
#
# Size/build notes:
# - Dependencies are installed once. The prune to production (and the removal of
#   build-only files under node_modules) happens in the build stage, before the
#   copy: deleting files in a later image layer only adds whiteouts, it does not
#   reclaim the bytes from the layer that held them.
# - The npm cache is mounted as a BuildKit cache, so it never lands in a layer.

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json vite.config.ts ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY src ./src
# Build, drop dev dependencies, and strip files the running process never reads:
# sourcemaps, type declarations, TypeScript sources (the pi runtime rewrites
# `.ts` imports to `.js` when loaded from built output) and tool caches. Markdown
# is KEPT: pi-coding-agent reads `docs/*.md` at runtime for auth guidance.
RUN npm run build \
  && npm prune --omit=dev \
  && find node_modules -type f \( \
       -name '*.map' \
       -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \
       -o \( -name '*.ts' ! -name '*.d.ts' \) \
     \) -delete \
  && rm -rf node_modules/.vite node_modules/.cache /root/.npm

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Runtime dependencies only. pi-ai ships inside the pi-coding-agent package and
# is resolved from there; `node scripts/check-pi-resolution.mjs` verifies it
# inside the running container.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY scripts/smoke.mjs scripts/check-pi-resolution.mjs ./scripts/
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
  CMD ["node", "-e", "const fs=require('fs');const p=(process.env.THEBE_CONFIG_DIR||'/data/config')+'/token';const t=process.env.THEBE_TOKEN||(fs.existsSync(p)?fs.readFileSync(p,'utf8').trim():'');fetch('http://127.0.0.1:'+(process.env.THEBE_PORT||8787)+'/v1/health',{headers:{'X-Thebe-Token':t}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/serve.js"]

# Multi-stage build for VPS OS Core services (dashboard-api + web UI, and agent)

FROM node:24-alpine AS builder
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-workspace.yaml tsconfig.base.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/tsconfig.json packages/shared/
COPY agent/package.json agent/tsconfig.json agent/
COPY dashboard/api/package.json dashboard/api/tsconfig.json dashboard/api/
COPY dashboard/web/package.json dashboard/web/tsconfig.json dashboard/web/vite.config.ts dashboard/web/index.html dashboard/web/
COPY tests/package.json tests/tsconfig.json tests/

RUN pnpm install --frozen-lockfile

COPY packages/shared/src packages/shared/src
COPY agent/src agent/src
COPY agent/hermes agent/hermes
COPY dashboard/api/src dashboard/api/src
COPY dashboard/web/src dashboard/web/src
COPY templates templates

RUN pnpm --filter @vps-os/shared build \
  && pnpm --filter @vps-os/agent build \
  && pnpm --filter @vps-os/dashboard-api build \
  && pnpm --filter @vps-os/dashboard-web build

FROM node:24-alpine AS api
WORKDIR /srv/vps-os
ENV NODE_ENV=production
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared ./packages/shared
COPY --from=builder /app/agent ./agent
COPY --from=builder /app/dashboard/api ./dashboard/api
COPY --from=builder /app/dashboard/web/dist ./dashboard/web/dist
USER node
WORKDIR /srv/vps-os/dashboard/api
CMD ["node", "dist/index.js"]

FROM node:24-alpine AS agent
WORKDIR /srv/vps-os
ENV NODE_ENV=production
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared ./packages/shared
COPY --from=builder /app/agent ./agent
COPY --from=builder /app/templates ./templates
USER node
WORKDIR /srv/vps-os/agent
CMD ["node", "dist/index.js"]

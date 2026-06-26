# Control-plane server image (C4). Built from the repo ROOT context so the
# pnpm workspace (incl. @app/shared) resolves. See docker-compose.yml.
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /app

# Workspace manifests first for better layer caching.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile=false

# Sources, then build shared → server.
COPY packages/shared packages/shared
COPY apps/server apps/server
RUN pnpm --filter @app/shared build && pnpm --filter @app/server build

# Produce a self-contained deploy dir (built dist + resolved @app/shared, prod deps).
RUN pnpm --filter @app/server --prod --legacy deploy /opt/server

FROM node:22-slim AS runtime
WORKDIR /opt/server
ENV NODE_ENV=production
COPY --from=build /opt/server ./
EXPOSE 8080
CMD ["node", "dist/index.js"]

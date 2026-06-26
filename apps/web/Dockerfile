# Web app image (C4). Runs the Vite dev server for the MVP so VITE_* env vars
# (VITE_API_BASE / VITE_WS_URL) are read at runtime from compose. Built from the
# repo ROOT context so the pnpm workspace (incl. @app/shared) resolves.
FROM node:22-slim
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile=false

COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @app/shared build

EXPOSE 5173
CMD ["pnpm", "--filter", "@app/web", "dev", "--host", "0.0.0.0", "--port", "5173"]

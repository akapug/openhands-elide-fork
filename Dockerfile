# Monorepo workspace image for Node apps (server-elide, baseline-express) and bench
FROM node:20-bullseye-slim AS workspace

# Enable pnpm via corepack and set working directory
ENV PNPM_HOME=/root/.local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /app

# Install dependencies (monorepo)
COPY package.json pnpm-lock.yaml .
COPY apps ./apps
COPY packages ./packages
COPY tsconfig.base.json ./
RUN pnpm install --frozen-lockfile

# Build TypeScript where needed
RUN pnpm -C apps/server-elide build \
 && pnpm -C apps/baseline-express build \
 && pnpm -C packages/bench build

# Default command is a shell; services override in docker-compose
CMD ["bash"]


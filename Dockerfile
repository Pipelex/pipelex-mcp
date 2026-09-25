# syntax=docker/dockerfile:1

# Dockerfile for a Skybridge MCP server.
#
# Detects npm, yarn, or pnpm from the lockfile in your project.
# (For bun or deno, adapt the install and build commands below.)

# Build stage: install every dependency and build the app. `skybridge` and the
# views' toolchain are devDependencies, so the install must not omit them.
FROM node:24-slim AS build
WORKDIR /app

COPY package.json yarn.lock* package-lock.json* pnpm-lock.yaml* .npmrc* ./
RUN --mount=type=cache,target=/root/.npm \
    --mount=type=cache,target=/usr/local/share/.cache/yarn \
    --mount=type=cache,target=/root/.local/share/pnpm/store \
    if [ -f package-lock.json ]; then \
      npm ci; \
    elif [ -f yarn.lock ]; then \
      corepack enable yarn && yarn install --frozen-lockfile; \
    elif [ -f pnpm-lock.yaml ]; then \
      corepack enable pnpm && pnpm install --frozen-lockfile; \
    else \
      echo "No lockfile found." && exit 1; \
    fi

ENV NODE_ENV=production

COPY . .
RUN if [ -f package-lock.json ]; then \
      npm run build; \
    elif [ -f yarn.lock ]; then \
      corepack enable yarn && yarn build; \
    elif [ -f pnpm-lock.yaml ]; then \
      corepack enable pnpm && pnpm build; \
    fi

# Runtime stage: the build output alone, run as non-root. The server starts from
# dist/server.bundle.js, the self-contained bundle `npm run build` copies out of
# Skybridge's build, so it needs no node_modules at all (see alpic.json, which
# starts the hosted console the same way, and scripts/check-server-bundle.mjs,
# which boots it from an empty directory on every `make check`).
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

USER node

COPY --from=build --chown=node:node /app/dist ./dist

EXPOSE 3000

# Run the built server directly rather than via `npm start` / `skybridge start`.
# Each wrapper adds a process layer that can swallow SIGTERM, which makes
# graceful shutdowns time out on platforms like Cloud Run, Fly, and k8s.
CMD ["node", "dist/server.bundle.js"]

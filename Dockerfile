# syntax=docker/dockerfile:1

# Dockerfile for the hosted console, a Skybridge MCP server.
#
# The console is a member of this repository's npm workspace
# (packages/console), and Alpic builds it without this file (see alpic.json and
# docs/alpic-builds.md); this is for running the same build anywhere else.

# Build stage: install the whole workspace and build the console. The install
# must not omit devDependencies: the console's build toolchain is declared
# there, and the core it inlines is a devDependency of the console.
FROM node:24-slim AS build
WORKDIR /app

# Every member's manifest must be present for `npm ci` to install the
# workspace the lockfile describes.
COPY package.json package-lock.json .npmrc* ./
COPY packages/core/package.json packages/core/
COPY packages/workshop/package.json packages/workshop/
COPY packages/console/package.json packages/console/
RUN --mount=type=cache,target=/root/.npm npm ci

ENV NODE_ENV=production

COPY . .
RUN npm run build

# Runtime stage: the console's build output alone, run as non-root. The server
# starts from dist/server.bundle.js, the self-contained bundle `npm run build`
# copies out of Skybridge's build, so it needs no node_modules at all (see
# alpic.json, which starts the hosted console the same way, and
# packages/console/scripts/check-server-bundle.mjs, which boots it from an empty
# directory on every `make check`). It is copied to ./dist so that the working
# directory is the one the server reads its view assets from (`dist/assets`).
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

USER node

COPY --from=build --chown=node:node /app/packages/console/dist ./dist

EXPOSE 3000

# Run the built server directly rather than via `npm start` / `skybridge start`.
# Each wrapper adds a process layer that can swallow SIGTERM, which makes
# graceful shutdowns time out on platforms like Cloud Run, Fly, and k8s.
CMD ["node", "dist/server.bundle.js"]

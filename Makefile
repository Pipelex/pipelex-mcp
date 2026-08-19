.DEFAULT_GOAL := help

.PHONY: help install lint format format-check typecheck test test-watch test-coverage smoke live-preflight test-e2e test-e2e-run seed-e2e-fixture te check check-no-local-deps check-release-ready build build-local all clean dev dev-local inspect-local dev-tunnel start deploy publish c t use-local use-npm use-local-ui use-npm-ui use-local-sdk use-npm-sdk ul un

# Sibling repos for live development of our npm dependencies (see use-local / use-npm).
MTHDS_UI_DIR := ../mthds-ui
PIPELEX_SDK_DIR := ../pipelex-sdk-js

define HELP
Manage pipelex-mcp located in $(CURDIR).
Usage:

make install        - Install dependencies
make dev            - Start Skybridge dev server
make dev-local      - Start the local stdio server from TypeScript
make inspect-local  - Open MCP Inspector against the local stdio server
make dev-tunnel     - Start Skybridge dev server with tunnel
make start          - Start the built app
make deploy         - Deploy the hosted console to Alpic (from a clean main)
make publish        - Publish @pipelex/mcp to npm (from a clean main)

make lint           - Run ESLint
make format         - Format source files with Prettier
make format-check   - Check Prettier formatting
make typecheck      - Run TypeScript without emitting files

make test           - Run the test suite
make test-watch     - Run tests in watch mode
make test-coverage  - Run tests with coverage
make t              - Shorthand -> test

Live checks against a REAL Pipelex API (never part of `make all`):
make smoke            - Drive the workshop stdio server end to end [PIPELEX_BASE_URL=...]
make test-e2e         - Run every capability's free path against the live API
make te               - Shorthand -> test-e2e
make test-e2e-run     - Same, plus the run family (SPENDS INFERENCE CREDIT)
make seed-e2e-fixture - Create/refresh the durable fixture method the by-id legs need

make build          - Build the Skybridge app
make build-local    - Build the npm-distributed local stdio server
make check          - Run lint, format check, typecheck, and build
make all            - Clean, check, and test
make clean          - Remove generated artifacts
make c              - Shorthand -> check

make use-local      - Switch @pipelex/mthds-ui AND @pipelex/sdk to their sibling repos (file links)
make use-npm        - Switch both back to npm (latest)
make use-local-ui   - Switch only @pipelex/mthds-ui to sibling ../mthds-ui
make use-npm-ui     - Switch only @pipelex/mthds-ui back to npm [VERSION=x.y.z]
make use-local-sdk  - Switch only @pipelex/sdk to sibling ../pipelex-sdk-js
make use-npm-sdk    - Switch only @pipelex/sdk back to npm [VERSION=x.y.z]
make ul             - Shorthand -> use-local
make un             - Shorthand -> use-npm

endef
export HELP

help:
	@echo "$$HELP"

install:
	npm install

lint:
	npm run lint

format:
	npm run format

format-check:
	npm run format:check

typecheck:
	npm run typecheck

test:
	npm test

test-watch:
	npm run test:watch

test-coverage:
	npm run test:coverage

# --- The live drift detectors (never part of `make all`) ---
# These are the only targets in the repo that touch the network, and they exist
# because the hermetic suite cannot see the failure that actually breaks this
# server: every capability reaches @pipelex/sdk through a hand-written narrow
# interface that the unit tests fake, so a wire-shape change on the API side
# fails nothing at all. See CLAUDE.md -> "Detecting API drift".
#
#   smoke            - the whole path a host exercises, through the stdio shell
#   test-e2e         - every capability's free path, through the real client
#   test-e2e-run     - the same, plus the run family (SPENDS INFERENCE CREDIT)
#   seed-e2e-fixture - WRITES the durable fixture method the by-id legs need
#
# The target and its key are resolved ONCE here and exported, so the URL these
# targets preflight is the URL the suites call. Precedence follows the dotenv
# convention: the shell environment (or a `make smoke PIPELEX_BASE_URL=...`
# override) wins, then `.env`, then the hosted API. `?=` is what enforces it — it
# only reaches for `.env` when the variable is not already set, and Node's
# `--env-file` in the npm script cannot override an inherited variable either.
DOTENV = set -a; [ -f .env ] && . ./.env; set +a;
LIVE_TARGETS = smoke test-e2e test-e2e-run seed-e2e-fixture live-preflight
$(LIVE_TARGETS): export PIPELEX_BASE_URL ?= $(shell $(DOTENV) printf '%s' "$${PIPELEX_BASE_URL:-https://api.pipelex.com}")
$(LIVE_TARGETS): export PIPELEX_API_KEY ?= $(shell $(DOTENV) printf '%s' "$$PIPELEX_API_KEY")

# Trailing slashes are stripped the way the SDK normalizes `baseUrl`, so a value
# ending in `/` cannot make the probe `//v1/version` — which a runner does not
# route — and report a live API as unreachable. It happens here, at the point of
# use: `?=` never fires for a value that arrived from the shell or the command
# line, so those two sources would otherwise keep their slash.
LIVE_API = $$(printf '%s' "$(PIPELEX_BASE_URL)" | sed 's:/*$$::')

# Shared gate for every live target. It is a prerequisite rather than copied
# recipe lines because target-specific variables are inherited by prerequisites,
# so the URL checked here is exactly the one the suite is about to call.
# `/v1/version` is the one route BOTH a bare runner and the hosted origin serve,
# and it needs no auth.
live-preflight:
	@target="$(LIVE_API)"; curl -fs --max-time 5 -o /dev/null "$$target/v1/version" || { \
		echo "ERROR: no Pipelex API reachable at $$target"; \
		echo "  Point PIPELEX_BASE_URL (shell or .env) at a running instance, or start the OSS runner: cd ../pipelex-api && make run"; \
		exit 1; \
	}
	@if [ -z "$(PIPELEX_API_KEY)" ]; then \
		echo "ERROR: PIPELEX_API_KEY is not set — every org-scoped call would fail as a config error."; \
		echo "  Put it in .env or export it. Against a keyless local runner, skip this guard by calling the npm script directly (e.g. 'npm run smoke')."; \
		exit 1; \
	fi
	@echo "-> target: $(LIVE_API)"

smoke: live-preflight
	npm run smoke

test-e2e: live-preflight
	@echo "-> the run family is skipped (it spends inference credit); use 'make test-e2e-run' to include it"
	npm run test:e2e

# The paid path, as its own target so nobody reaches it by accident: the run
# family executes the fixture method for real.
test-e2e-run: export PIPELEX_E2E_RUN = 1
test-e2e-run: live-preflight
	@echo "-> including the run family: this SPENDS INFERENCE CREDIT"
	npm run test:e2e

# Idempotent, and a WRITE: it creates (or refreshes) one durable fixture method
# in the organization the API key selects. The by-id legs need a registered
# method and the SDK has no delete, so a create-per-run suite would leak one
# method per run — hence one seeded fixture, resolved by name.
seed-e2e-fixture: live-preflight
	npm run seed:e2e-fixture

check: check-no-local-deps
	npm run check

check-no-local-deps:
	@if grep -qE '"@pipelex/(mthds-ui|sdk)":[[:space:]]*"(file:|link:|portal:)' package.json; then \
		echo "ERROR: a @pipelex dependency in package.json is a local link. Run 'make use-npm' first."; exit 1; \
	fi

build:
	npm run build

build-local:
	npm run build:local

all: clean check test

clean:
	rm -rf dist coverage *.tsbuildinfo

dev:
	npm run dev

dev-local:
	npm run dev:local

inspect-local:
	npm run inspect:local

dev-tunnel:
	npm run dev:tunnel

start:
	npm run start

# --- Release-only publish/deploy ---
# Both surfaces always ship from the same clean main commit (see CLAUDE.md
# "Versioning & changelog" and the /release skill). check-release-ready guards
# that, plus check-no-local-deps: a @pipelex file: link would ship a broken
# install (npm) or fail to resolve on Alpic's build machine (deploy).

check-release-ready:
	@current_branch="$$(git rev-parse --abbrev-ref HEAD)"; \
	if [ "$$current_branch" != "main" ]; then \
		echo "ERROR: must run from main (currently on $$current_branch). Publish/deploy only ship from main."; exit 1; \
	fi
	@if [ -n "$$(git status --porcelain)" ]; then \
		echo "ERROR: working tree is not clean. Commit or stash changes before publishing/deploying."; exit 1; \
	fi

deploy: check-no-local-deps check-release-ready
	npm run deploy

publish: check-no-local-deps check-release-ready
	npm publish

c: check
t: test
te: test-e2e

# --- Switch the source of our npm dependencies ---
# use-local / use-npm act on BOTH @pipelex/mthds-ui and @pipelex/sdk.
# The per-package targets act on one, and take VERSION=x.y.z to pin an npm version.

use-local: use-local-ui use-local-sdk

use-npm: use-npm-ui use-npm-sdk

use-local-ui:
	@if [ ! -d $(MTHDS_UI_DIR) ]; then echo "ERROR: $(MTHDS_UI_DIR) not found. Clone it next to pipelex-mcp."; exit 1; fi
	cd $(MTHDS_UI_DIR) && npm install && npm run build
	npm install @pipelex/mthds-ui@file:$(MTHDS_UI_DIR)
	@echo "Switched to local mthds-ui (file link). Run 'make use-npm-ui' to switch back."

use-npm-ui:
	@VERSION="$${VERSION:-latest}" && \
	echo "Installing @pipelex/mthds-ui@$$VERSION from npm" && \
	npm install @pipelex/mthds-ui@$$VERSION && \
	echo "Switched to npm @pipelex/mthds-ui@$$VERSION. Review the diff, then commit package.json + package-lock.json."

use-local-sdk:
	@if [ ! -d $(PIPELEX_SDK_DIR) ]; then echo "ERROR: $(PIPELEX_SDK_DIR) not found. Clone it next to pipelex-mcp."; exit 1; fi
	cd $(PIPELEX_SDK_DIR) && npm install && npm run build
	npm install @pipelex/sdk@file:$(PIPELEX_SDK_DIR)
	@echo "Switched to local pipelex-sdk-js (file link). Run 'make use-npm-sdk' to switch back."

use-npm-sdk:
	@VERSION="$${VERSION:-latest}" && \
	echo "Installing @pipelex/sdk@$$VERSION from npm" && \
	npm install @pipelex/sdk@$$VERSION && \
	echo "Switched to npm @pipelex/sdk@$$VERSION. Review the diff, then commit package.json + package-lock.json."

ul: use-local
un: use-npm

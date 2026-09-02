.DEFAULT_GOAL := help

.PHONY: help install lint format format-check typecheck test agent-test test-watch test-coverage smoke live-preflight test-e2e test-e2e-run test-all seed-e2e-fixture te check check-no-local-deps check-release-ready build build-local all clean dev dev-local inspect-local dev-tunnel start deploy deploy-prod deploy-dev deploy-staging deploy-envs alpic-deploy publish c t use-local use-npm use-local-ui use-npm-ui use-local-sdk use-npm-sdk ul un

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
make deploy         - Deploy the hosted console to Alpic Production (from a clean main)
make deploy-prod    - Same as deploy
make deploy-staging - Deploy the working tree to the Alpic Staging console
make deploy-dev     - Deploy the working tree to the Alpic Dev console
make deploy-envs    - List this project's Alpic environments and their URLs
make publish        - Publish @pipelex/mcp to npm (from a clean main)

make lint           - Run ESLint
make format         - Format source files with Prettier
make format-check   - Check Prettier formatting
make typecheck      - Run TypeScript without emitting files

make test           - Run the test suite
make agent-test     - Run the test suite for an agent (heartbeats; output only on failure)
make test-watch     - Run tests in watch mode
make test-coverage  - Run tests with coverage
make t              - Shorthand -> test

Live checks against a REAL Pipelex API (never part of `make all`):
make smoke            - Drive the workshop stdio server end to end [PIPELEX_BASE_URL=...]
make test-e2e         - Run every capability's free path (writes one 1x1 PNG)
make te               - Shorthand -> test-e2e
make test-e2e-run     - Same, plus the run family (SPENDS INFERENCE CREDIT)
make seed-e2e-fixture - Create/refresh the durable fixture method the by-id legs need
make test-all         - EVERY test: hermetic + smoke + live incl. run family (SPENDS CREDIT)

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

# --- The agent-facing test target ---
# Same hermetic suite as `make test`, run so that an agent can afford to watch it:
# stdout is captured and shown ONLY on failure, and a heartbeat line every
# HEARTBEAT_INTERVAL seconds distinguishes a slow run from a hung one. A green
# vitest run is a few hundred lines of context spent to learn one bit, which is
# why the workspace rule is "agents run agent-test, not test". The macro mirrors
# the one in the Python repos so the output reads the same across the workspace.
HEARTBEAT_INTERVAL ?= 15
define WAIT_WITH_HEARTBEAT
	start_time=$$(date +%s); \
	$(1) & \
	cmd_pid=$$!; \
	( while kill -0 "$$cmd_pid" 2>/dev/null; do \
		sleep $(HEARTBEAT_INTERVAL); \
		if kill -0 "$$cmd_pid" 2>/dev/null; then \
			elapsed=$$(( $$(date +%s) - $$start_time )); \
			echo "• $(2) still running ($${elapsed}s elapsed)"; \
		fi; \
	done ) & \
	heartbeat_pid=$$!; \
	wait "$$cmd_pid"; \
	exit_code=$$?; \
	kill "$$heartbeat_pid" 2>/dev/null || true; \
	wait "$$heartbeat_pid" 2>/dev/null || true
endef

# `--silent` drops npm's own two-line banner so the captured log is vitest and
# nothing else; on failure the whole thing is replayed, unfiltered.
agent-test:
	@echo "• Running the hermetic test suite..."
	@tmpfile=$$(mktemp); \
	$(call WAIT_WITH_HEARTBEAT,npm test --silent > "$$tmpfile" 2>&1,agent-test); \
	if [ $$exit_code -ne 0 ]; then cat "$$tmpfile"; fi; \
	rm -f "$$tmpfile"; \
	if [ $$exit_code -eq 0 ]; then echo "• All tests passed."; fi; \
	exit $$exit_code

# --- The live drift detectors (never part of `make all`) ---
# These are the only targets in the repo that touch the network, and they exist
# because the hermetic suite cannot see the failure that actually breaks this
# server: every capability reaches @pipelex/sdk through a hand-written narrow
# interface that the unit tests fake, so a wire-shape change on the API side
# fails nothing at all. See CLAUDE.md -> "Detecting API drift".
#
#   smoke            - the whole path a host exercises, through the stdio shell
#   test-e2e         - every capability's free path; WRITES one 1x1 PNG to storage
#   test-e2e-run     - the same, plus the run family (SPENDS INFERENCE CREDIT)
#   seed-e2e-fixture - WRITES the durable fixture method the by-id legs need
#
# The target and its key are resolved ONCE here and exported, so the URL these
# targets preflight is the URL the suites call. Precedence follows the dotenv
# convention: the shell environment (or a `make smoke PIPELEX_BASE_URL=...`
# override) wins, then `.env`, then the default below. `?=` is what enforces it —
# it only reaches for `.env` when the variable is not already set, and Node's
# `--env-file` in the npm script cannot override an inherited variable either.
#
# The default is DEV, not production, and that is a statement about what these
# targets are for. The by-selector legs gate on what the deployment advertises,
# and production does not advertise `method_ref` — so defaulting there made the
# suite's headline coverage skip on every default invocation, indefinitely.
# Dev is the hosted plane the addressing campaign ships to. Note this is the
# LIVE TARGETS' default only: the server's own `PIPELEX_BASE_URL` default (in
# `buildApiConfig`) is still production, which is what a workshop user gets.
DOTENV = set -a; [ -f .env ] && . ./.env; set +a;
LIVE_TARGETS = smoke test-e2e test-e2e-run seed-e2e-fixture live-preflight
$(LIVE_TARGETS): export PIPELEX_BASE_URL ?= $(shell $(DOTENV) printf '%s' "$${PIPELEX_BASE_URL:-https://api-dev.pipelex.com}")
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
	@if [ -z "$$PIPELEX_API_KEY" ]; then \
		echo "ERROR: PIPELEX_API_KEY is not set — every org-scoped call would fail as a config error."; \
		echo "  Put it in .env or export it. Against a keyless local runner, skip this guard by calling the npm script directly (e.g. 'npm run smoke')."; \
		exit 1; \
	fi
	@echo "-> target: $(LIVE_API)"

smoke: live-preflight
	npm run smoke

# The gate has to be closed here, not merely left unset: `run.e2e.ts` reads
# PIPELEX_E2E_RUN from the environment, and `vitest.e2e.config.ts` loads the
# whole `.env` — so an ambient `PIPELEX_E2E_RUN=1` (left in a shell, or parked in
# `.env`) would make this target print "skipped" and then spend inference credit.
# Setting it empty makes the guarantee the echo claims a property of the target
# rather than of whatever the caller's environment happened to hold.
test-e2e: export PIPELEX_E2E_RUN =
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

# Every test in the repo, in cost order: the hermetic suite first, so a broken
# projection fails before any credit is spent, then the read-only smoke run,
# then the live suite. `test-e2e-run` is the whole live suite plus the run
# family, so it subsumes `test-e2e` and running both would be duplicate work.
#
# It therefore SPENDS INFERENCE CREDIT. That is the point of the name being
# `test-all` and not `all`: `make all` stays the hermetic gate, and nothing
# reaches the paid leg without typing a target that says so.
#
# It deliberately does NOT seed. Seeding writes a durable method into the
# organization's catalog, which stays hand-invoked; an unseeded org fails the
# by-id legs loudly, with the seed command in the message. live-preflight runs
# here too, so a missing key fails in a second rather than after the unit suite.
test-all: live-preflight
	@echo "-> EVERY test: hermetic, then smoke, then the live suite WITH the run family (SPENDS INFERENCE CREDIT)"
	$(MAKE) test
	$(MAKE) smoke
	$(MAKE) test-e2e-run

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

deploy-prod: deploy

publish: check-no-local-deps check-release-ready
	npm publish

# --- The non-production consoles ---
# `make deploy` above ships Production through the tracked `.alpic/project.json`,
# exactly as release.yml does. These two name their environment explicitly and
# drop the release guards: shipping a work branch to Dev or Staging is the point.
# `check-no-local-deps` still applies — a @pipelex `file:` link does not resolve
# on Alpic's build machine, so it would fail the build there instead of here.
#
# There is no Alpic git integration on this project. A deploy uploads the
# WORKING TREE, not the branch the environment is named after, so the banner
# says which branch (and whether it is dirty) is actually being shipped.
#
# Run `make deploy-envs` for the current ids; these are pinned so a deploy
# needs no lookup, and a renamed or recreated environment fails loudly.
ALPIC_PROJECT_ID := prj_csxv0ybe166jmf0kohzu8
ALPIC_ENV_DEV := env_2jw695sbltlu6vzjjqyrx
ALPIC_ENV_STAGING := env_mfgz1sycy0si0sdc9vsd4

deploy-dev: check-no-local-deps
	@$(MAKE) --no-print-directory alpic-deploy ALPIC_ENV_NAME=Dev ALPIC_ENV_ID=$(ALPIC_ENV_DEV)

deploy-staging: check-no-local-deps
	@$(MAKE) --no-print-directory alpic-deploy ALPIC_ENV_NAME=Staging ALPIC_ENV_ID=$(ALPIC_ENV_STAGING)

deploy-envs:
	npx alpic environment list --project-id $(ALPIC_PROJECT_ID)

# Shared recipe behind deploy-dev / deploy-staging. The CLI relinks
# `.alpic/project.json` to whatever environment it just deployed, and that file
# is tracked, pins Production, and is the only thing telling release.yml (which
# deploys with no ids of its own) where a release goes — so a leftover Dev link
# would silently ship the next release to the wrong console.
#
# The restore is a `trap`, not a line after the CLI call, on purpose: the CLI
# waits on the build for minutes, so Ctrl-C is the LIKELY way this recipe ends,
# and a restore that only runs on a clean exit is exactly the one that misses.
alpic-deploy:
	@branch="$$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '(unknown)')"; \
	dirty=""; \
	if [ -n "$$(git status --porcelain 2>/dev/null)" ]; then dirty=" + uncommitted changes"; fi; \
	echo "-> Deploying to the Alpic $(ALPIC_ENV_NAME) console ($(ALPIC_ENV_ID))"; \
	echo "   shipping the working tree at $$branch$$dirty"; \
	link=.alpic/project.json; \
	if [ -f "$$link" ]; then \
		backup="$$(mktemp)"; cp "$$link" "$$backup"; \
		trap "if [ -f \$$backup ]; then if ! cmp -s \$$link \$$backup; then cp \$$backup \$$link; echo 'Restored .alpic/project.json — it stays pinned to Production for make deploy and release.yml.'; fi; rm -f \$$backup; fi" EXIT INT TERM; \
	fi; \
	npx alpic deploy --non-interactive --project-id $(ALPIC_PROJECT_ID) --environment-id $(ALPIC_ENV_ID)

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

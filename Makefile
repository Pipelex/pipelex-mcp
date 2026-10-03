.DEFAULT_GOAL := help

.PHONY: help install lint format format-check typecheck test agent-test test-watch test-coverage smoke live-preflight test-e2e test-e2e-run test-all seed-e2e-fixture te check check-no-local-deps check-release-ready check-workshop-released build-local all clean dev-local inspect-local publish c t use-local use-npm use-local-ui use-npm-ui use-local-sdk use-npm-sdk ul un

# Sibling checkouts for live development of our npm dependencies (see use-local / use-npm).
# @pipelex/sdk lives in the js/ directory of the pipelex-sdk monorepo.
MTHDS_UI_DIR := ../mthds-ui
PIPELEX_SDK_DIR := ../pipelex-sdk/js

define HELP
Manage pipelex-mcp located in $(CURDIR): an npm workspace holding the core
(packages/core) and the workshop published as @pipelex/mcp (packages/workshop).
Usage:

make install        - Install dependencies
make dev-local      - Start the local stdio server from TypeScript
make inspect-local  - Open MCP Inspector against the local stdio server
make publish        - Publish the workshop, @pipelex/mcp, to npm (from a clean main; break-glass)

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
make smoke            - Drive the workshop stdio server end to end [PIPELEX_E2E_BASE_URL=...]
make test-e2e         - Run every capability's free path (writes PNGs, updates fixture rows)
make te               - Shorthand -> test-e2e
make test-e2e-run     - Same, plus the run family (SPENDS INFERENCE CREDIT)
make seed-e2e-fixture - Create/refresh the durable fixture methods the live suites need
make test-all         - EVERY test: hermetic + smoke + live incl. run family (SPENDS CREDIT)

make build-local    - Build the workshop, the npm-distributed stdio server
make check          - Run lint, format check, the text budgets, the build and typecheck
make all            - Clean, check, and test
make clean          - Remove generated artifacts
make c              - Shorthand -> check

make use-local      - Switch @pipelex/mthds-ui AND @pipelex/sdk to their sibling repos (file links), in every member naming them
make use-npm        - Switch both back to npm (latest)
make use-local-ui   - Switch only @pipelex/mthds-ui to sibling ../mthds-ui
make use-npm-ui     - Switch only @pipelex/mthds-ui back to npm [VERSION=x.y.z]
make use-local-sdk  - Switch only @pipelex/sdk to sibling ../pipelex-sdk/js
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
# fails nothing at all. See docs/testing.md -> "Detecting API drift".
#
#   smoke            - the whole path a host exercises, through the stdio shell
#   test-e2e         - every capability's free path; WRITES PNGs to storage AND updates
#                      the seeded catalog write fixture (it never creates a row)
#   test-e2e-run     - the same, plus the run family (SPENDS INFERENCE CREDIT)
#   seed-e2e-fixture - WRITES the durable fixture methods the by-id and write legs need
#
# They read their OWN pair, `PIPELEX_E2E_BASE_URL` and `PIPELEX_E2E_API_KEY`,
# and never `PIPELEX_BASE_URL` / `PIPELEX_API_KEY`. Those two names belong to
# every other tool and to the server itself: a shell profile exporting the
# production pair for other tools aimed `make test-e2e` at production, and with
# the shell clear it followed `.env`, which named whatever the local server was
# pointed at. Neither is the deployment the durable fixture is seeded in, so
# every by-id leg failed with a fixture miss that read like drift. `PIPELEX_E2E_BASE_URL` is
# also the name the live suite of @pipelex/sdk, in pipelex-sdk/js, uses.
#
# The pair is resolved ONCE here and exported, so the URL these targets
# preflight is the URL the suites call (`packages/core/src/capabilities/e2e-support.ts` reads
# the same two names). Precedence is the make command line, then `.env`, then the
# shell, then the default, because `.env` is this checkout's own configuration
# and the shell is ambient. Each value is taken
# whole from the first source that sets it, and the preflight prints which one.
#
# The default is DEV, not production, and that is a statement about what these
# targets are for. The by-selector legs gate on what the deployment advertises,
# and production does not advertise `method_ref` — so defaulting there made the
# suite's headline coverage skip on every default invocation, indefinitely.
# Dev is the hosted plane the addressing campaign ships to. Note this is the
# LIVE TARGETS' default only: the server's own `PIPELEX_BASE_URL` default (in
# `buildApiConfig`) is still production, which is what a workshop user gets.
# `LIVE_DEFAULT_BASE_URL` in `e2e-support.ts` repeats it for a bare `npm run`.
DOTENV = set -a; [ -f .env ] && . ./.env; set +a;
LIVE_TARGETS = smoke test-e2e test-e2e-run seed-e2e-fixture live-preflight
LIVE_DEFAULT_BASE_URL = https://api-dev.pipelex.com

# The shell's own values, read while parsing, before the target-specific
# assignments below exist. (A command-line value lands here too, harmlessly:
# a command-line variable overrides those assignments, so nothing reads these.)
LIVE_SHELL_BASE_URL := $(PIPELEX_E2E_BASE_URL)
LIVE_SHELL_API_KEY := $(PIPELEX_E2E_API_KEY)

# What `.env` alone sets a variable to, empty when it sets nothing: `env -u`
# hides the inherited value from the shell that sources the file.
dotenv_value = $(shell env -u $(1) sh -c '$(DOTENV) printf "%s" "$${$(1)}"')

# Where a live variable's value comes from: $(1) the name, $(2) the shell's value,
# $(3) what to say when nothing sets it.
live_source = $(if $(filter command line,$(origin $(1))),the make command line,$(if $(call dotenv_value,$(1)),.env,$(if $(2),the shell,$(3))))

$(LIVE_TARGETS): export PIPELEX_E2E_BASE_URL = $(or $(call dotenv_value,PIPELEX_E2E_BASE_URL),$(LIVE_SHELL_BASE_URL),$(LIVE_DEFAULT_BASE_URL))
$(LIVE_TARGETS): export PIPELEX_E2E_API_KEY = $(or $(call dotenv_value,PIPELEX_E2E_API_KEY),$(LIVE_SHELL_API_KEY))

# Trailing slashes are stripped the way the SDK normalizes `baseUrl`, so a value
# ending in `/` cannot make the probe `//v1/version` — which a runner does not
# route — and report a live API as unreachable.
LIVE_API = $$(printf '%s' "$(PIPELEX_E2E_BASE_URL)" | sed 's:/*$$::')

# Shared gate for every live target. It is a prerequisite rather than copied
# recipe lines because target-specific variables are inherited by prerequisites,
# so the URL checked here is exactly the one the suite is about to call.
# `/v1/version` is the one route BOTH a bare runner and the hosted origin serve,
# and it needs no auth. The target line comes first, so a refusal below is read
# next to the deployment it is about.
#
# `PIPELEX_BASE_URL=…` on the command line is refused rather than ignored: it
# was how these targets were aimed, and ignoring it would send that habit to
# api-dev without a word. The same names from the shell ARE ignored — that is
# the ambient configuration this block exists to keep out — with a note, so
# someone who exported them on purpose sees why nothing changed.
live-preflight:
	@if [ "$(origin PIPELEX_BASE_URL)" = "command line" ] || [ "$(origin PIPELEX_API_KEY)" = "command line" ]; then \
		echo "ERROR: the live targets read PIPELEX_E2E_BASE_URL and PIPELEX_E2E_API_KEY, never PIPELEX_BASE_URL / PIPELEX_API_KEY."; \
		echo "  Rename the variable: make $(firstword $(MAKECMDGOALS) live-preflight) PIPELEX_E2E_BASE_URL=..."; \
		exit 1; \
	fi
	@echo "-> target: $(LIVE_API) (PIPELEX_E2E_BASE_URL from $(call live_source,PIPELEX_E2E_BASE_URL,$(LIVE_SHELL_BASE_URL),the default)); key: PIPELEX_E2E_API_KEY from $(call live_source,PIPELEX_E2E_API_KEY,$(LIVE_SHELL_API_KEY),nowhere)"
	@if [ -n "$$PIPELEX_BASE_URL$$PIPELEX_API_KEY" ]; then \
		echo "   (PIPELEX_BASE_URL / PIPELEX_API_KEY in the environment are ignored here: they belong to other tools)"; \
	fi
	@target="$(LIVE_API)"; curl -fs --max-time 5 -o /dev/null "$$target/v1/version" || { \
		echo "ERROR: no Pipelex API reachable at $$target"; \
		echo "  Set PIPELEX_E2E_BASE_URL (in .env, or on the command line) to a running instance, or start the OSS runner: cd ../pipelex-api && make run"; \
		exit 1; \
	}
	@if [ -z "$$PIPELEX_E2E_API_KEY" ]; then \
		echo "ERROR: PIPELEX_E2E_API_KEY is not set — every org-scoped call would fail as a config error."; \
		echo "  Put the key for that deployment's organization in .env as PIPELEX_E2E_API_KEY. Against a keyless local runner, skip this guard by calling the npm script directly (e.g. 'npm run smoke')."; \
		exit 1; \
	fi

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

# Every manifest in the workspace, since `use-local` links a package in each
# member that declares it.
MANIFESTS := package.json $(wildcard packages/*/package.json)

check-no-local-deps:
	@if grep -qE '"@pipelex/(mthds-ui|sdk)":[[:space:]]*"(file:|link:|portal:)' $(MANIFESTS); then \
		grep -nE '"@pipelex/(mthds-ui|sdk)":[[:space:]]*"(file:|link:|portal:)' $(MANIFESTS); \
		echo "ERROR: a @pipelex dependency above is a local link. Run 'make use-npm' first."; exit 1; \
	fi

build-local:
	npm run build:local

all: clean check test

clean:
	rm -rf coverage *.tsbuildinfo packages/*/dist packages/*/*.tsbuildinfo

dev-local:
	npm run dev:local

inspect-local:
	npm run inspect:local

# --- Release-only publish (break-glass) ---
# A release ships from the merge of its pull request into main, through
# release.yml, which publishes the workshop to npm (see docs/development.md
# "CI and releases" and the /release skill). `make publish` is the escape hatch
# for a CI outage. check-release-ready demands a clean main, and
# check-no-local-deps refuses a @pipelex file: link, which would ship a broken
# install.

check-release-ready:
	@current_branch="$$(git rev-parse --abbrev-ref HEAD)"; \
	if [ "$$current_branch" != "main" ]; then \
		echo "ERROR: must run from main (currently on $$current_branch). Publish only ships from main."; exit 1; \
	fi
	@if [ -n "$$(git status --porcelain)" ]; then \
		echo "ERROR: working tree is not clean. Commit or stash changes before publishing."; exit 1; \
	fi
	@git fetch -q origin main || { echo "ERROR: could not fetch origin/main, so nothing says this checkout is its tip."; exit 1; }; \
	if [ "$$(git rev-parse HEAD)" != "$$(git rev-parse FETCH_HEAD)" ]; then \
		echo "ERROR: HEAD is not origin/main's tip. Publish ships only main's tip: pull it, and if main has moved past the release you meant to ship, cut a new release instead."; exit 1; \
	fi

# The publish also ships only from the commit that released the workshop: the
# merge whose first parent carried another version. A tip that did not raise
# the version carries the released number with code that version never
# shipped, so a recovery from it would put the wrong bytes under the right
# number. Past that point the cure is a new release, not a recovery. The rise
# must be strict, so a revert that lowers the version never reads as a
# release, and check-release-ready holds HEAD to origin/main's tip.
check-workshop-released:
	@now="$$(bash .github/scripts/track-version.sh HEAD)" && \
	before="$$(bash .github/scripts/track-version.sh HEAD^)" || exit 1; \
	if [ "$$now" = "$$before" ] || [ "$$(printf '%s\n%s\n' "$$before" "$$now" | sort -V | tail -1)" != "$$now" ]; then \
		echo "ERROR: HEAD did not raise the workshop version: it carries $$now over its first parent's $$before. A break-glass publish runs only from the commit that raised the version; once main has moved past it, cut a new release instead."; exit 1; \
	fi

publish: check-no-local-deps check-release-ready check-workshop-released
	npm publish --workspace @pipelex/mcp

c: check
t: test
te: test-e2e

# --- Switch the source of our npm dependencies ---
# use-local / use-npm act on BOTH @pipelex/mthds-ui and @pipelex/sdk.
# The per-package targets act on one, and take VERSION=x.y.z to pin an npm version.
#
# Each package is installed into exactly the workspace members that declare it,
# never into the root, and both go into both members, which carry the same
# range (tests/workspace-manifests.test.ts fails when they drift apart). npm
# updates an entry in the block it already sits in, so a bump keeps @pipelex/sdk
# in `dependencies` and @pipelex/mthds-ui in `devDependencies`: the core imports
# only its `./static-graph` embed serializer, which tsup inlines into the
# workshop's bundle. What reaches every `npx @pipelex/mcp` install is the
# workshop's `dependencies` alone, so read the diff of
# packages/workshop/package.json before committing a bump.
UI_WORKSPACES := --workspace @pipelex/mcp-core --workspace @pipelex/mcp
SDK_WORKSPACES := --workspace @pipelex/mcp-core --workspace @pipelex/mcp

use-local: use-local-ui use-local-sdk

use-npm: use-npm-ui use-npm-sdk

use-local-ui:
	@if [ ! -d $(MTHDS_UI_DIR) ]; then echo "ERROR: $(MTHDS_UI_DIR) not found. Clone it next to pipelex-mcp."; exit 1; fi
	cd $(MTHDS_UI_DIR) && npm install && npm run build
	npm install $(UI_WORKSPACES) @pipelex/mthds-ui@file:$(abspath $(MTHDS_UI_DIR))
	@echo "Switched to local mthds-ui (file link). Run 'make use-npm-ui' to switch back."

use-npm-ui:
	@VERSION="$${VERSION:-latest}" && \
	echo "Installing @pipelex/mthds-ui@$$VERSION from npm" && \
	npm install $(UI_WORKSPACES) @pipelex/mthds-ui@$$VERSION && \
	echo "Switched to npm @pipelex/mthds-ui@$$VERSION. Review the diff, then commit packages/*/package.json + package-lock.json."

use-local-sdk:
	@if [ ! -d $(PIPELEX_SDK_DIR) ]; then echo "ERROR: $(PIPELEX_SDK_DIR) not found. Clone Pipelex/pipelex-sdk next to pipelex-mcp."; exit 1; fi
	cd $(PIPELEX_SDK_DIR) && npm install && npm run build
	npm install $(SDK_WORKSPACES) @pipelex/sdk@file:$(abspath $(PIPELEX_SDK_DIR))
	@echo "Switched to local @pipelex/sdk from $(PIPELEX_SDK_DIR) (file link). Run 'make use-npm-sdk' to switch back."

use-npm-sdk:
	@VERSION="$${VERSION:-latest}" && \
	echo "Installing @pipelex/sdk@$$VERSION from npm" && \
	npm install $(SDK_WORKSPACES) @pipelex/sdk@$$VERSION && \
	echo "Switched to npm @pipelex/sdk@$$VERSION. Review the diff, then commit packages/*/package.json + package-lock.json."

ul: use-local
un: use-npm

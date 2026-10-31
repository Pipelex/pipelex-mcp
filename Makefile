.DEFAULT_GOAL := help

.PHONY: help install lint format format-check typecheck test agent-test test-watch test-coverage smoke live-preflight test-e2e test-e2e-run test-all seed-e2e-fixture te check check-no-local-deps check-publishable check-release-ready check-workshop-released build-local all clean dev-local inspect-local publish c t use-local use-npm use-local-ui use-npm-ui use-local-sdk use-npm-sdk ul un

# Sibling checkouts for live development of our npm dependencies (see use-local / use-npm).
# @pipelex/sdk lives in the js/ directory of the pipelex-sdk monorepo.
MTHDS_UI_DIR := ../mthds-ui
PIPELEX_SDK_DIR := ../pipelex-sdk/js

define HELP
Manage pipelex-mcp located in $(CURDIR): the workshop, the local MCP server
published to npm as @pipelex/mcp from this directory.
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

make build-local    - Build the workshop's executable, dist/main.js
make check          - Run lint, format check, the text budgets, the build and typecheck
make check-publishable - Refuse a dependency that may not be published (a sprint pin, a git or local source)
make all            - Clean, check, and test
make clean          - Remove generated artifacts
make c              - Shorthand -> check

make use-local      - Switch @pipelex/mthds-ui AND @pipelex/sdk to their sibling repos (file links)
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
# production pair for other tools once aimed `make test-e2e` at production,
# where no fixture is seeded, and every by-id leg failed with a fixture miss
# that read like drift. `PIPELEX_E2E_BASE_URL` is also the name the live suite
# of @pipelex/sdk, in pipelex-sdk/js, uses.
#
# The key belongs to a registered test account, and comes with what the
# registry of test accounts expects of it: PIPELEX_E2E_API_KEY_EXPECTED_ORG_ID,
# _EXPECTED_ROLE and _EXPECTED_EMAIL. On a laptop the workspace's
# `test-account run pipelex-mcp -- make <target>` hands over all of them; a CI
# job sets them from the registry. Before the first live call, each live entry
# point asks `/v1/me` who the key is and stops on any difference
# (`src/capabilities/e2e-account.ts`); this preflight refuses a run with no key
# or no expectations before any request at all.
#
# The pair is resolved ONCE here and exported, so the URL these targets
# preflight is the URL the suites call (`src/capabilities/e2e-support.ts` reads
# the same two names). Precedence is the make command line, then the
# environment, then the default, and the preflight prints which one. `.env` is
# never read: it used to win over the shell, which would let a key parked there
# replace the one `test-account run` hands over, and a test credential never
# belongs in a repository's env file anyway.
#
# The default is DEV, not production, and that is a statement about what these
# targets are for. The by-selector legs gate on what the deployment advertises,
# and production does not advertise `method_ref` — so defaulting there made the
# suite's headline coverage skip on every default invocation, indefinitely.
# Dev is the hosted plane the addressing campaign ships to. Note this is the
# LIVE TARGETS' default only: the server's own `PIPELEX_BASE_URL` default (in
# `buildApiConfig`) is still production, which is what a workshop user gets.
# `LIVE_DEFAULT_BASE_URL` in `e2e-support.ts` repeats it for a bare `npm run`.
LIVE_TARGETS = smoke test-e2e test-e2e-run seed-e2e-fixture live-preflight
LIVE_DEFAULT_BASE_URL = https://api-dev.pipelex.com
LIVE_EXPECTATIONS = PIPELEX_E2E_API_KEY_EXPECTED_ORG_ID PIPELEX_E2E_API_KEY_EXPECTED_ROLE PIPELEX_E2E_API_KEY_EXPECTED_EMAIL
LIVE_RUN_COMMAND = test-account run pipelex-mcp -- make $(firstword $(filter smoke test-e2e test-e2e-run seed-e2e-fixture test-all,$(MAKECMDGOALS)) <target>)

# The environment's own values, read while parsing, before the target-specific
# assignments below exist. (A command-line value lands here too, harmlessly:
# a command-line variable overrides those assignments, so nothing reads these.)
LIVE_ENV_BASE_URL := $(PIPELEX_E2E_BASE_URL)
LIVE_ENV_API_KEY := $(PIPELEX_E2E_API_KEY)

# Where a live variable's value comes from: $(1) the name, $(2) the environment's
# value, $(3) what to say when nothing sets it.
live_source = $(if $(filter command line,$(origin $(1))),the make command line,$(if $(2),the environment,$(3)))

$(LIVE_TARGETS): export PIPELEX_E2E_BASE_URL = $(or $(LIVE_ENV_BASE_URL),$(LIVE_DEFAULT_BASE_URL))
$(LIVE_TARGETS): export PIPELEX_E2E_API_KEY = $(LIVE_ENV_API_KEY)

# Trailing slashes are stripped the way the SDK normalizes `baseUrl`, so a value
# ending in `/` cannot make the probe `//v1/version` — which a runner does not
# route — and report a live API as unreachable.
LIVE_API = $$(printf '%s' "$(PIPELEX_E2E_BASE_URL)" | sed 's:/*$$::')

# Shared gate for every live target. It is a prerequisite rather than copied
# recipe lines because target-specific variables are inherited by prerequisites,
# so the URL checked here is exactly the one the suite is about to call.
# The refusals that need no request come first: the other tools' names on the
# command line, a missing key, missing expectations. Then `/v1/version`, the one
# route BOTH a bare runner and the hosted origin serve, which needs no auth.
# The target line comes first of all, so a refusal is read next to the
# deployment it is about.
#
# `PIPELEX_BASE_URL=…` on the command line is refused rather than ignored: it
# was how these targets were aimed, and ignoring it would send that habit to
# api-dev without a word. The same names from the environment ARE ignored —
# `test-account run` sets `PIPELEX_BASE_URL` for every tool it starts, and a
# shell profile may export them — with a note, so someone who exported them on
# purpose sees why nothing changed.
live-preflight:
	@if [ "$(origin PIPELEX_BASE_URL)" = "command line" ] || [ "$(origin PIPELEX_API_KEY)" = "command line" ]; then \
		echo "ERROR: the live targets read PIPELEX_E2E_BASE_URL and PIPELEX_E2E_API_KEY, never PIPELEX_BASE_URL / PIPELEX_API_KEY."; \
		echo "  Rename the variable: make $(firstword $(MAKECMDGOALS) live-preflight) PIPELEX_E2E_BASE_URL=..."; \
		exit 1; \
	fi
	@echo "-> target: $(LIVE_API) (PIPELEX_E2E_BASE_URL from $(call live_source,PIPELEX_E2E_BASE_URL,$(LIVE_ENV_BASE_URL),the default)); key: PIPELEX_E2E_API_KEY from $(call live_source,PIPELEX_E2E_API_KEY,$(LIVE_ENV_API_KEY),nowhere)"
	@if [ -n "$$PIPELEX_BASE_URL$$PIPELEX_API_KEY" ]; then \
		echo "   (PIPELEX_BASE_URL / PIPELEX_API_KEY in the environment are ignored here: they belong to other tools)"; \
	fi
	@if [ -z "$$PIPELEX_E2E_API_KEY" ]; then \
		echo "ERROR: PIPELEX_E2E_API_KEY is not set, so no request was sent."; \
		echo "  Run the live targets through the workspace's '$(LIVE_RUN_COMMAND)', which hands over the key of the test account they act for beside what the registry expects of it. They never read .env. Against a keyless local runner, call the npm script directly (e.g. 'npm run smoke')."; \
		exit 1; \
	fi
	@missing=""; for variable in $(LIVE_EXPECTATIONS); do \
		[ -n "$$(printenv "$$variable")" ] || missing="$$missing $$variable"; \
	done; \
	if [ -n "$$missing" ]; then \
		echo "ERROR: not set:$$missing — nothing says which account PIPELEX_E2E_API_KEY must act for, so no request was sent."; \
		echo "  Run the live targets through the workspace's '$(LIVE_RUN_COMMAND)', which hands over the key beside what the registry of test accounts expects of it; a CI job sets the same variables from the registry (docs/testing.md)."; \
		exit 1; \
	fi
	@target="$(LIVE_API)"; curl -fs --max-time 5 -o /dev/null "$$target/v1/version" || { \
		echo "ERROR: no Pipelex API reachable at $$target"; \
		echo "  Set PIPELEX_E2E_BASE_URL (in the environment, or on the command line) to a running instance, or start the OSS runner with 'make -C api run' in a checkout of Pipelex/pipelex, which serves http://localhost:8081"; \
		exit 1; \
	}

smoke: live-preflight
	npm run smoke

# The gate has to be closed here, not merely left unset: `run.e2e.ts` reads
# PIPELEX_E2E_RUN from the environment, so an ambient `PIPELEX_E2E_RUN=1` left
# in a shell would make this target print "skipped" and then spend inference credit.
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
		grep -nE '"@pipelex/(mthds-ui|sdk)":[[:space:]]*"(file:|link:|portal:)' package.json; \
		echo "ERROR: a @pipelex dependency above is a local link. Run 'make use-npm' first."; exit 1; \
	fi

# The publish guard, which `npm publish` also runs as the manifest's
# `prepublishOnly` script, so every route to the registry passes through it:
# `release.yml`, `make publish` and a bare `npm publish` alike. `make publish`
# runs it as a prerequisite as well, since an npm configured with
# `ignore-scripts` skips every lifecycle script. It is not part
# of `make check`, which stays green while a sprint pin is deliberately in
# place on a sprint branch. `scripts/publish-guard.ts` says what it refuses.
check-publishable:
	npm run check:publishable

build-local:
	npm run build

all: clean check test

clean:
	rm -rf coverage *.tsbuildinfo dist

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
# install; check-publishable runs the publish guard, which `npm publish` runs
# again as `prepublishOnly`. `--ignore-scripts=false` keeps an npm configured
# with `ignore-scripts` from skipping that and the `prepack` build, which would
# publish whatever `dist/` already held.

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

# The publish also ships only from the commit that released the workshop, as
# `.github/scripts/release-verdict.sh` decides it for release.yml too: the
# merge whose first parent carried a lower version, or the repository's root
# commit, which has no parent. A tip that did not raise the version carries the
# released number with code that version never shipped, so a recovery from it
# would put the wrong bytes under the right number. Past that point the cure is
# a new release, not a recovery. The rise must be strict, so a revert that
# lowers the version never reads as a release, and check-release-ready holds
# HEAD to origin/main's tip.
check-workshop-released:
	@verdict="$$(bash .github/scripts/release-verdict.sh HEAD)" || exit 1; \
	now="$$(printf '%s\n' "$$verdict" | sed -n 's/^version=//p')"; \
	before="$$(printf '%s\n' "$$verdict" | sed -n 's/^parent_version=//p')"; \
	if [ "$$(printf '%s\n' "$$verdict" | sed -n 's/^release=//p')" != "true" ]; then \
		echo "ERROR: HEAD did not raise the workshop version: it carries $$now over its first parent's $$before. A break-glass publish runs only from the commit that raised the version; once main has moved past it, cut a new release instead."; exit 1; \
	fi

publish: check-no-local-deps check-release-ready check-workshop-released check-publishable
	npm publish --ignore-scripts=false

c: check
t: test
te: test-e2e

# --- Switch the source of our npm dependencies ---
# use-local / use-npm act on BOTH @pipelex/mthds-ui and @pipelex/sdk.
# The per-package targets act on one, and take VERSION=x.y.z to pin an npm version.
#
# npm updates an entry in the block it already sits in, so a bump keeps
# @pipelex/sdk in `dependencies` and @pipelex/mthds-ui in `devDependencies`: the
# capabilities import only its `./static-graph` embed serializer, which tsup
# inlines into the bundle. What reaches every `npx @pipelex/mcp` install is
# `dependencies` alone, so read the diff of package.json before committing a bump.

use-local: use-local-ui use-local-sdk

use-npm: use-npm-ui use-npm-sdk

use-local-ui:
	@if [ ! -d $(MTHDS_UI_DIR) ]; then echo "ERROR: $(MTHDS_UI_DIR) not found. Clone it next to pipelex-mcp."; exit 1; fi
	cd $(MTHDS_UI_DIR) && npm install && npm run build
	npm install @pipelex/mthds-ui@file:$(abspath $(MTHDS_UI_DIR))
	@echo "Switched to local mthds-ui (file link). Run 'make use-npm-ui' to switch back."

use-npm-ui:
	@VERSION="$${VERSION:-latest}" && \
	echo "Installing @pipelex/mthds-ui@$$VERSION from npm" && \
	npm install @pipelex/mthds-ui@$$VERSION && \
	echo "Switched to npm @pipelex/mthds-ui@$$VERSION. Review the diff, then commit package.json + package-lock.json."

use-local-sdk:
	@if [ ! -d $(PIPELEX_SDK_DIR) ]; then echo "ERROR: $(PIPELEX_SDK_DIR) not found. Clone Pipelex/pipelex-sdk next to pipelex-mcp."; exit 1; fi
	cd $(PIPELEX_SDK_DIR) && npm install && npm run build
	npm install @pipelex/sdk@file:$(abspath $(PIPELEX_SDK_DIR))
	@echo "Switched to local @pipelex/sdk from $(PIPELEX_SDK_DIR) (file link). Run 'make use-npm-sdk' to switch back."

use-npm-sdk:
	@VERSION="$${VERSION:-latest}" && \
	echo "Installing @pipelex/sdk@$$VERSION from npm" && \
	npm install @pipelex/sdk@$$VERSION && \
	echo "Switched to npm @pipelex/sdk@$$VERSION. Review the diff, then commit package.json + package-lock.json."

ul: use-local
un: use-npm

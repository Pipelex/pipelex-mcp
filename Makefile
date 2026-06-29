.DEFAULT_GOAL := help

.PHONY: help install lint format format-check typecheck test test-watch test-coverage check check-no-local-deps build all clean dev dev-tunnel start deploy c t use-local use-npm ul un

# Sibling repo for live @pipelex/mthds-ui development (see use-local / use-npm).
MTHDS_UI_DIR := ../mthds-ui

define HELP
Manage pipelex-mcp located in $(CURDIR).
Usage:

make install        - Install dependencies
make dev            - Start Skybridge dev server
make dev-tunnel     - Start Skybridge dev server with tunnel
make start          - Start the built app
make deploy         - Deploy with Alpic

make lint           - Run ESLint
make format         - Format source files with Prettier
make format-check   - Check Prettier formatting
make typecheck      - Run TypeScript without emitting files

make test           - Run the test suite
make test-watch     - Run tests in watch mode
make test-coverage  - Run tests with coverage
make t              - Shorthand -> test

make build          - Build the Skybridge app
make check          - Run lint, format check, typecheck, and build
make all            - Clean, check, and test
make clean          - Remove generated artifacts
make c              - Shorthand -> check

make use-local      - Switch @pipelex/mthds-ui to sibling ../mthds-ui (file link)
make use-npm        - Switch @pipelex/mthds-ui back to npm [VERSION=x.y.z]
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

check: check-no-local-deps
	npm run check

check-no-local-deps:
	@if grep -qE '"@pipelex/mthds-ui":[[:space:]]*"(file:|link:|portal:)' package.json; then \
		echo "ERROR: @pipelex/mthds-ui in package.json is a local link. Run 'make use-npm' first."; exit 1; \
	fi

build:
	npm run build

all: clean check test

clean:
	rm -rf dist coverage *.tsbuildinfo

dev:
	npm run dev

dev-tunnel:
	npm run dev:tunnel

start:
	npm run start

deploy:
	npm run deploy

c: check
t: test

# --- Switch @pipelex/mthds-ui source ---
# use-local:  file link to sibling ../mthds-ui for live development
# use-npm:    install from the npm registry (latest by default, or VERSION=x.y.z)

use-local:
	@if [ ! -d $(MTHDS_UI_DIR) ]; then echo "ERROR: $(MTHDS_UI_DIR) not found. Clone it next to pipelex-mcp."; exit 1; fi
	cd $(MTHDS_UI_DIR) && npm install && npm run build
	npm install @pipelex/mthds-ui@file:$(MTHDS_UI_DIR)
	@echo "Switched to local mthds-ui (file link). Run 'make use-npm' to switch back."

use-npm:
	@VERSION="$${VERSION:-latest}" && \
	echo "Installing @pipelex/mthds-ui@$$VERSION from npm" && \
	npm install @pipelex/mthds-ui@$$VERSION && \
	echo "Switched to npm @pipelex/mthds-ui@$$VERSION. Review the diff, then commit package.json + package-lock.json."

ul: use-local
un: use-npm

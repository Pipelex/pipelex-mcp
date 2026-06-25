.DEFAULT_GOAL := help

.PHONY: help install lint format format-check typecheck test test-watch test-coverage check build all clean dev dev-tunnel start deploy c t

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
make check          - Run lint, format check, typecheck, build, and tests
make all            - Clean, check, and build
make clean          - Remove generated artifacts
make c              - Shorthand -> check

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

check:
	npm run check

build:
	npm run build

all: clean check build

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

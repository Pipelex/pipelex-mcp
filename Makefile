ifeq ($(wildcard .env),.env)
include .env
export
endif
VIRTUAL_ENV := $(CURDIR)/.venv
PROJECT_NAME := $(shell grep '^name = ' pyproject.toml | sed -E 's/name = "(.*)"/\1/')

# The "?" is used to make the variable optional, so that it can be overridden by the user.
PYTHON_VERSION ?= 3.11
# Note: VENV_* variables include quotes to handle paths with spaces (e.g., "My Projects/pipelex")
VENV_PYTHON := "$(VIRTUAL_ENV)/bin/python"
VENV_PYTEST := "$(VIRTUAL_ENV)/bin/pytest"
VENV_RUFF := "$(VIRTUAL_ENV)/bin/ruff"
VENV_PYRIGHT := "$(VIRTUAL_ENV)/bin/pyright"
VENV_MYPY := "$(VIRTUAL_ENV)/bin/mypy"
VENV_PIPELEX := "$(VIRTUAL_ENV)/bin/pipelex"
VENV_MKDOCS := "$(VIRTUAL_ENV)/bin/mkdocs"
VENV_PYLINT := "$(VIRTUAL_ENV)/bin/pylint"

UV_MIN_VERSION = $(shell grep -m1 'required-version' pyproject.toml | sed -E 's/.*= *"([^<>=," ]+).*/\1/')

USUAL_PYTEST_MARKERS := "(dry_runnable or not (inference or llm or img_gen or extract)) and not (needs_output or pipelex_api)"

define PRINT_TITLE
    $(eval PROJECT_PART := [$(PROJECT_NAME)])
    $(eval TARGET_PART := ($@))
    $(eval MESSAGE_PART := $(1))
    $(if $(MESSAGE_PART),\
        $(eval FULL_TITLE := === $(PROJECT_PART) ===== $(TARGET_PART) ====== $(MESSAGE_PART) ),\
        $(eval FULL_TITLE := === $(PROJECT_PART) ===== $(TARGET_PART) ====== )\
    )
    $(eval TITLE_LENGTH := $(shell echo -n "$(FULL_TITLE)" | wc -c | tr -d ' '))
    $(eval PADDING_LENGTH := $(shell echo $$((126 - $(TITLE_LENGTH)))))
    $(eval PADDING := $(shell printf '%*s' $(PADDING_LENGTH) '' | tr ' ' '='))
    $(eval PADDED_TITLE := $(FULL_TITLE)$(PADDING))
    @echo ""
    @echo "$(PADDED_TITLE)"
endef

define HELP
Manage $(PROJECT_NAME) located in $(CURDIR).
Usage:

make env                      - Create python virtual env
make lock                     - Refresh uv.lock without updating anything
make install                  - Create local virtualenv & install all dependencies
make update                   - Upgrade dependencies via uv
make validate                 - Run the setup sequence to validate the config and libraries
make build                    - Build the wheels

make mcp-check                - Check if MCP server can start successfully
make mcp-test                 - Test MCP server initialization
make run                      - Run MCP server manually (for debugging)

make format                   - format with ruff format
make lint                     - lint with ruff check
make pyright                  - Check types with pyright
make mypy                     - Check types with mypy

make config-template          - Update config template from .pipelex/
make cft                      - Shorthand -> config-template

make cleanenv                 - Remove virtual env and lock files
make cleanderived             - Remove extraneous compiled files, caches, logs, etc.
make cleanall                 - Remove all -> cleanenv + cleanderived

make merge-check-ruff-lint    - Run ruff merge check without updating files
make merge-check-ruff-format  - Run ruff merge check without updating files
make merge-check-mypy         - Run mypy merge check without updating files
make merge-check-pyright	  - Run pyright merge check without updating files

make v                        - Shorthand -> validate
make codex-tests              - Run tests for Codex (exit on first failure) (no inference, no codex_disabled)
make gha-tests		          - Run tests for github actions (exit on first failure) (no inference, no gha_disabled)
make test                     - Run unit tests (no inference)
make test-xdist               - Run unit tests with xdist (no inference)
make t                        - Shorthand -> test-xdist
make test-quiet               - Run unit tests without prints (no inference)
make tq                       - Shorthand -> test-quiet
make test-with-prints         - Run tests with prints (no inference)
make tp                       - Shorthand -> test-with-prints
make tb                       - Shorthand -> `make test-with-prints TEST=test_boot`
make test-inference           - Run unit tests only for inference (with prints)
make ti                       - Shorthand -> test-inference
make tip                      - Shorthand -> test-inference-with-prints (parallelized inference tests)
make test-llm			      - Run unit tests only for llm (with prints)
make tl                       - Shorthand -> test-llm
make test-extract             - Run unit tests only for extract (with prints)
make te                       - Shorthand -> test-extract
make test-img-gen             - Run unit tests only for img_gen (with prints)
make test-g					  - Shorthand -> test-img-gen

make check-unused-imports     - Check for unused imports without fixing
make fix-unused-imports       - Fix unused imports with ruff
make fui                      - Shorthand -> fix-unused-imports
make check-TODOs              - Check for TODOs

make docs                     - Serve documentation locally with mkdocs
make docs-check               - Check documentation build with mkdocs
make docs-deploy              - Deploy documentation with mkdocs

make check                    - Shorthand -> format lint mypy
make c                        - Shorthand -> check
make cc                       - Shorthand -> cleanderived check
make li                       - Shorthand -> lock install

make test-count              - Count the number of tests
make check-test-badge        - Check if the test count matches the badge value

endef
export HELP

.PHONY: \
	all help env lock install update build \
	format lint pyright mypy pylint \
	cleanderived cleanenv cleanall \
	test test-xdist t test-quiet tq test-with-prints tp test-inference ti \
	test-llm tl test-img-gen tg test-extract te codex-tests gha-tests \
	run-all-tests run-manual-trigger-gha-tests run-gha_disabled-tests \
	validate v check c cc \
	merge-check-ruff-lint merge-check-ruff-format merge-check-mypy merge-check-pyright \
	li check-unused-imports fix-unused-imports check-uv check-TODOs docs docs-check docs-deploy \
	config-template cft \
	test-count check-test-badge \
	mcp-check mcp-test run

all help:
	@echo "$$HELP"


##########################################################################################
### SETUP
##########################################################################################

check-uv:
	$(call PRINT_TITLE,"Ensuring uv ≥ $(UV_MIN_VERSION)")
	@command -v uv >/dev/null 2>&1 || { \
		echo "uv not found – installing latest …"; \
		curl -LsSf https://astral.sh/uv/install.sh | sh; \
	}
	@uv self update >/dev/null 2>&1 || true


env: check-uv
	$(call PRINT_TITLE,"Creating virtual environment")
	@if [ ! -d "$(VIRTUAL_ENV)" ]; then \
		echo "Creating Python virtual env in \`${VIRTUAL_ENV}\`"; \
		uv venv "$(VIRTUAL_ENV)" --python $(PYTHON_VERSION); \
	else \
		echo "Python virtual env already exists in \`${VIRTUAL_ENV}\`"; \
	fi
	@echo "Using Python: $$($(VENV_PYTHON) --version) from $$(readlink $(VENV_PYTHON) 2>/dev/null || echo $(VENV_PYTHON))"

install: env
	$(call PRINT_TITLE,"Installing dependencies")
	@. "$(VIRTUAL_ENV)/bin/activate" && \
	uv sync --all-extras && \
	echo "Installed Pipelex dependencies in ${VIRTUAL_ENV} with all extras.";

lock: env
	$(call PRINT_TITLE,"Resolving dependencies without update")
	@uv lock && \
	echo uv lock without update;

update: env
	$(call PRINT_TITLE,"Updating all dependencies")
	@uv lock --upgrade && \
	uv sync --all-extras && \
	echo "Updated dependencies in ${VIRTUAL_ENV}";

validate: env
	$(call PRINT_TITLE,"Running setup sequence")
	$(VENV_PIPELEX) validate all

build: env
	$(call PRINT_TITLE,"Building the wheels")
	@uv build

config-template:
	$(call PRINT_TITLE,"Updating config template from .pipelex/")
	@rsync -av --exclude='inference/backends.toml' --delete .pipelex/ pipelex/config_template/

cft: config-template
	@echo "> done: cft = config-template"

##############################################################################################
############################      Cleaning                        ############################
##############################################################################################

cleanderived:
	$(call PRINT_TITLE,"Erasing derived files and directories")
	@find . -name '.coverage' -delete && \
	find . -wholename '**/*.pyc' -delete && \
	find . -type d -wholename '__pycache__' -exec rm -rf {} + && \
	find . -type d -wholename './.cache' -exec rm -rf {} + && \
	find . -type d -wholename './.mypy_cache' -exec rm -rf {} + && \
	find . -type d -wholename './.ruff_cache' -exec rm -rf {} + && \
	find . -type d -wholename '.pytest_cache' -exec rm -rf {} + && \
	find . -type d -wholename '**/.pytest_cache' -exec rm -rf {} + && \
	find . -type d -wholename './logs/*.log' -exec rm -rf {} + && \
	find . -type d -wholename './.reports/*' -exec rm -rf {} + && \
	echo "Cleaned up derived files and directories";

cleanenv:
	$(call PRINT_TITLE,"Erasing virtual environment")
	find . -name 'uv.lock' -delete && \
	find . -type d -wholename './.venv' -exec rm -rf {} + && \
	echo "Cleaned up virtual env and dependency lock files";

cleanconfig:
	$(call PRINT_TITLE,"Erasing config files and directories")
	@find . -type d -wholename './.pipelex' -exec rm -rf {} + && \
	echo "Cleaned up .pipelex";

cleanall: cleanderived cleanenv cleanconfig
	@echo "Cleaned up all derived files and directories";

##########################################################################################
### TESTING
##########################################################################################

test: env
	$(call PRINT_TITLE,"Unit testing without prints but displaying logs via pytest for WARNING level and above")
	@echo "• Running unit tests"
	@if [ -n "$(TEST)" ]; then \
		$(VENV_PYTEST) -s -m $(USUAL_PYTEST_MARKERS) -o log_cli=true -o log_level=WARNING -k "$(TEST)" $(if $(filter 1,$(VERBOSE)),-v,$(if $(filter 2,$(VERBOSE)),-vv,$(if $(filter 3,$(VERBOSE)),-vvv,))); \
	else \
		$(VENV_PYTEST) -s -m $(USUAL_PYTEST_MARKERS) -o log_cli=true -o log_level=WARNING $(if $(filter 1,$(VERBOSE)),-v,$(if $(filter 2,$(VERBOSE)),-vv,$(if $(filter 3,$(VERBOSE)),-vvv,))); \
	fi

test-xdist: env
	$(call PRINT_TITLE,"Unit testing without prints but displaying logs via pytest for WARNING level and above")
	@echo "• Running unit tests"
	@if [ -n "$(TEST)" ]; then \
		$(VENV_PYTEST) -n auto -m $(USUAL_PYTEST_MARKERS) -o log_level=WARNING -k "$(TEST)" $(if $(filter 1,$(VERBOSE)),-v,$(if $(filter 2,$(VERBOSE)),-vv,$(if $(filter 3,$(VERBOSE)),-vvv,))); \
	else \
		$(VENV_PYTEST) -n auto -m $(USUAL_PYTEST_MARKERS) -o log_level=WARNING $(if $(filter 1,$(VERBOSE)),-v,$(if $(filter 2,$(VERBOSE)),-vv,$(if $(filter 3,$(VERBOSE)),-vvv,))); \
	fi

t: test-xdist
	@echo "> done: t = test-xdist"

test-quiet: env
	$(call PRINT_TITLE,"Unit testing without prints but displaying logs via pytest for WARNING level and above")
	@echo "• Running unit tests"
	@if [ -n "$(TEST)" ]; then \
		$(VENV_PYTEST) -m $(USUAL_PYTEST_MARKERS) -o log_cli=true -o log_level=WARNING -k "$(TEST)" $(if $(filter 1,$(VERBOSE)),-v,$(if $(filter 2,$(VERBOSE)),-vv,$(if $(filter 3,$(VERBOSE)),-vvv,))); \
	else \
		$(VENV_PYTEST) -m $(USUAL_PYTEST_MARKERS) -o log_cli=true -o log_level=WARNING $(if $(filter 1,$(VERBOSE)),-v,$(if $(filter 2,$(VERBOSE)),-vv,$(if $(filter 3,$(VERBOSE)),-vvv,))); \
	fi

tq: test-quiet
	@echo "> done: tq = test-quiet"

test-with-prints: env
	$(call PRINT_TITLE,"Unit testing with prints and our rich logs")
	@echo "• Running unit tests"
	@if [ -n "$(TEST)" ]; then \
		$(VENV_PYTEST) -s -m $(USUAL_PYTEST_MARKERS) -k "$(TEST)" $(if $(filter 1,$(VERBOSE)),-v,$(if $(filter 2,$(VERBOSE)),-vv,$(if $(filter 3,$(VERBOSE)),-vvv,))); \
	else \
		$(VENV_PYTEST) -s -m $(USUAL_PYTEST_MARKERS) $(if $(filter 1,$(VERBOSE)),-v,$(if $(filter 2,$(VERBOSE)),-vv,$(if $(filter 3,$(VERBOSE)),-vvv,))); \
	fi

tp: test-with-prints
	@echo "> done: tp = test-with-prints"

############################################################################################
############################               Linting              ############################
############################################################################################

format: env
	$(call PRINT_TITLE,"Formatting with ruff")
	$(VENV_RUFF) format . --config pyproject.toml

lint: env
	$(call PRINT_TITLE,"Linting with ruff")
	$(VENV_RUFF) check . --fix --config pyproject.toml

pyright: env
	$(call PRINT_TITLE,"Typechecking with pyright")
	$(VENV_PYRIGHT) --pythonpath $(VENV_PYTHON) --project pyproject.toml

mypy: env
	$(call PRINT_TITLE,"Typechecking with mypy")
	$(VENV_MYPY) --config-file pyproject.toml

pylint: env
	$(call PRINT_TITLE,"Linting with pylint")
	$(VENV_PYLINT) --rcfile pyproject.toml pipelex tests


##########################################################################################
### MERGE CHECKS
##########################################################################################

merge-check-ruff-format: env
	$(call PRINT_TITLE,"Formatting with ruff")
	$(VENV_RUFF) format --check . --config pyproject.toml

merge-check-ruff-lint: env check-unused-imports
	$(call PRINT_TITLE,"Linting with ruff without fixing files")
	$(VENV_RUFF) check . --config pyproject.toml

merge-check-pyright: env
	$(call PRINT_TITLE,"Typechecking with pyright")
	$(VENV_PYRIGHT) --pythonpath $(VENV_PYTHON)

merge-check-mypy: env
	$(call PRINT_TITLE,"Typechecking with mypy")
	$(VENV_MYPY) --config-file pyproject.toml

merge-check-pylint: env
	$(call PRINT_TITLE,"Linting with pylint")
	$(VENV_PYLINT) --rcfile pyproject.toml .

##########################################################################################
### MISCELLANEOUS
##########################################################################################

check-unused-imports: env
	$(call PRINT_TITLE,"Checking for unused imports without fixing")
	$(VENV_RUFF) check --select=F401 --no-fix .

fix-unused-imports: env
	$(call PRINT_TITLE,"Fixing unused imports")
	$(VENV_RUFF) check --select=F401 --fix .

fui: fix-unused-imports
	@echo "> done: fui = fix-unused-imports"

check-TODOs: env
	$(call PRINT_TITLE,"Checking for TODOs")
	@$(VENV_RUFF) check --select=TD -v .

##########################################################################################
### SHORTHANDS
##########################################################################################

c: format lint pyright mypy
	@echo "> done: c = check"

cc: cleanderived c
	@echo "> done: cc = cleanderived format lint pyright mypy"

check: cc check-unused-imports pylint
	@echo "> done: check"

v: validate
	@echo "> done: v = validate"

li: lock install
	@echo "> done: lock install"

##########################################################################################
### MCP SERVER TESTING
##########################################################################################

mcp-check: env
	$(call PRINT_TITLE,"Checking MCP server initialization")
	@echo "Testing if Pipelex can initialize..."
	@$(VENV_PYTHON) -c "from pipelex.pipelex import Pipelex; Pipelex.make(); print('✅ Pipelex initialized successfully')" 2>&1 || { \
		echo ""; \
		echo "❌ Pipelex initialization failed!"; \
		echo ""; \
		echo "Common issues:"; \
		echo "  1. Missing API keys - Check .env file or environment variables"; \
		echo "  2. Check .pipelex/inference/backends.toml to enable/disable backends"; \
		echo ""; \
		echo "To fix:"; \
		echo "  - Copy .env.example to .env and add your API keys"; \
		echo "  - OR disable backends that require keys you don't have"; \
		echo "  - OR add keys directly to .cursor/mcp.json in the 'env' section"; \
		exit 1; \
	}
	@echo ""
	@echo "Testing if MCP server can import..."
	@$(VENV_PYTHON) -c "from server.main import mcp; print('✅ MCP server imports successfully')" 2>&1 || { \
		echo "❌ MCP server import failed!"; \
		exit 1; \
	}
	@echo ""
	@echo "✅ All checks passed! Your MCP server should work in Cursor."
	@echo ""
	@echo "Next steps:"
	@echo "  1. Make sure .cursor/mcp.json has your API keys in the 'env' section"
	@echo "  2. Restart Cursor completely (Cmd+Q then reopen)"
	@echo "  3. Check the MCP servers list in Cursor settings"

mcp-test: mcp-check
	@echo "> done: mcp-test = mcp-check"

run: env
	$(call PRINT_TITLE,Running MCP server manually)
	@echo "Starting MCP server..."
	@echo "This will wait for stdin (MCP protocol messages)"
	@echo "Press Ctrl+C to stop"
	@echo ""
	uv run python -m server.main
	

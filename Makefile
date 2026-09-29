# Trading Lab Research tasks. `make` (or `make help`) lists them.
# The live checkout (~/trading) changes only through `make deploy` (added with the runtime safety net);
# develop in a worktree under ~/trading-wt/ with its own .venv.

SHELL := /bin/bash
PY ?= .venv/bin/python
export PYTHONPATH := src
export PYTHONDONTWRITEBYTECODE := 1

# Modules held to `mypy --strict`. New safety and ops modules join this list in the PR that adds them.
TYPED_MODULES :=

.DEFAULT_GOAL := help
.PHONY: help bootstrap lint typecheck test ci hooks

help: ## List the tasks
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | sed -E 's/:.*## /\t/' | sort

bootstrap: ## Create .venv from the lockfile (Python 3.12)
	uv venv --python 3.12 .venv
	uv pip install --python $(PY) -r requirements.lock.txt
	@if [ -f requirements-dev.lock.txt ]; then uv pip install --python $(PY) -r requirements-dev.lock.txt; fi

lint: ## Ruff, bug-class rules (see pyproject.toml)
	$(PY) -m ruff check .

typecheck: ## mypy --strict on the typed modules
	@if [ -z "$(strip $(TYPED_MODULES))" ]; then echo "typecheck: no typed modules yet"; \
	else $(PY) -m mypy --strict $(TYPED_MODULES); fi

test: ## Unit tests
	$(PY) -m pytest

ci: lint typecheck test ## Everything CI runs

hooks: ## Install the pre-commit hooks (gitleaks, restricted paths, ruff)
	pre-commit install

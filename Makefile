# Trading Lab Research tasks. `make` (or `make help`) lists them.
# The live checkout (~/trading) changes only through `make deploy` (added with the runtime safety net);
# develop in a worktree under ~/trading-wt/ with its own .venv.

SHELL := /bin/bash
PY ?= .venv/bin/python
export PYTHONPATH := src
export PYTHONDONTWRITEBYTECODE := 1

# Modules held to `mypy --strict`. New safety and ops modules join this list in the PR that adds them.
TYPED_MODULES := src/wt/ops/alerts.py src/wt/ops/schedule.py src/wt/ops/locks.py src/wt/ops/window.py \
                 src/wt/ops/heartbeat.py src/wt/ops/preflight.py src/wt/ops/jobs.py src/wt/ops/migrate.py \
                 src/wt/ops/agents.py src/wt/ops/deploy.py src/wt/ops/ci.py src/wt/core/safety.py src/wt/core/ids.py \
                 src/wt/brokers/base.py src/wt/brokers/sim.py src/wt/brokers/alpaca_paper.py src/wt/risk/pretrade.py \
                 src/wt/oms/manager.py src/wt/risk/virtual_account.py src/wt/ops/publish.py src/wt/brokers/alpaca_read.py src/wt/ops/evidence.py \
                 src/wt/research/manifest.py src/wt/research/method.py src/wt/research/trials.py \
                 src/wt/ops/thresholds.py src/wt/analytics/g2.py src/wt/risk/mandate.py \
                 src/wt/ops/dashguard.py src/wt/ops/drill.py src/wt/brokers/cancel_only.py src/wt/ops/host.py \
                 src/wt/ops/units.py src/wt/ops/hc.py src/wt/core/ledger.py src/wt/ops/r2.py src/wt/ops/lease.py \
                 src/wt/ops/backup.py src/wt/brokers/shadow.py src/wt/analytics/performance.py \
                 src/wt/analytics/risk_view.py src/wt/analytics/ops_view.py src/wt/ops/audit.py src/wt/ops/control.py \
                 src/wt/core/desk.py src/wt/crypto/data.py src/wt/crypto/indicators.py src/wt/crypto/quality.py \
                 src/wt/crypto/strategy.py src/wt/crypto/book.py src/wt/crypto/risk.py src/wt/crypto/features.py \
                 src/wt/crypto/labels.py src/wt/crypto/cycle.py src/wt/crypto/snapshot.py src/wt/crypto/control.py \
                 src/wt/crypto/rules.py src/wt/crypto/sleeves.py src/wt/crypto/backtest.py
JOB_PATH := /opt/homebrew/bin:$(HOME)/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin

.DEFAULT_GOAL := help
.PHONY: seed-vm help bootstrap lint typecheck test ci hooks status gate deploy rollback migrate-state preflight publish-verify \
        uninstall-agents lease-break \
        watchdog-drill dashboard-deploy vm-deploy \
        agents-diff install-trading-agents install-dashboard-agent publish schema kill unkill reset-latch evidence

help: ## List the tasks
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | sed -E 's/:.*## /\t/' | sort

bootstrap: ## Create .venv from the lockfile (Python 3.12)
	uv venv --python 3.12 .venv
	uv pip install --require-hashes --python $(PY) -r requirements.lock.txt
	@if [ -f requirements-dev.lock.txt ]; then uv pip install --require-hashes --python $(PY) -r requirements-dev.lock.txt; fi

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

# ---- operations on the live checkout (~/trading). Every command that changes it goes through the deploy gate. ----

status: ## What's going on: kill switch, last job runs, firing alerts, preflight
	$(PY) -m wt.ops.jobs status

gate: ## Is it safe to change the live checkout right now? (no job running, outside the trading night)
	$(PY) -m wt.ops.deploy gate

deploy: ## Gate; main's tip (or SHA=...) if green; fast-forward, migrate, sync venv, smoke (rolls back on failure). STAGE=1: full tests first
	$(PY) -m wt.ops.deploy deploy $(if $(SHA),--sha $(SHA),) $(if $(STAGE),--stage,)

rollback: ## Back to a runtime-* tag: make rollback TAG=runtime-YYYYMMDD-N
	@test -n "$(TAG)" || (echo "usage: make rollback TAG=runtime-YYYYMMDD-N" && exit 2)
	$(PY) -m wt.ops.deploy rollback $(TAG)

migrate-state: ## Move runtime files from tracked paths into var/ (gated, lossless)
	$(PY) -m wt.ops.deploy migrate

preflight: ## Run every job's preflight as its scheduler would (launchd's minimal environment; the unit's on Linux)
	@if [ "$$(uname)" = Linux ]; then for j in routine paper-b forward weekly; do echo "== $$j"; \
	  WT_HOST=systemd PYTHONPATH=src $(PY) -m wt.ops.jobs run $$j --preflight-only || status=1; done; exit $${status:-0}; \
	else for j in routine paper-b forward weekly; do echo "== $$j"; \
	  env -i HOME="$(HOME)" PATH="$(JOB_PATH)" /bin/zsh deploy/run_job.sh $$j --preflight-only || status=1; done; \
	  exit $${status:-0}; fi

uninstall-agents: ## OWNER: stop and remove every com.wt.* launchd agent (the Mac stops running jobs; cutover, plan v7)
	$(PY) -m wt.ops.agents uninstall

lease-break: ## OWNER: expire the paper-B primary lease now (after a host that held it is gone for good)
	$(PY) -m wt.ops.lease break

agents-diff: ## Which installed launchd agents differ from the code
	$(PY) -m wt.ops.agents diff

install-trading-agents: ## OWNER: (re)install the com.wt.* trading agents (gated; outside the trading window)
	$(PY) -m wt.ops.agents install --trading

install-dashboard-agent: ## Install the 15-minute dashboard publisher (com.wt.dashboard; not a trading job)
	$(PY) -m wt.ops.agents install --dashboard

publish: ## Collect, sanitize and publish the dashboard snapshot now (DRY_RUN=1 to only build it)
	$(PY) -m wt.ops.publish $(if $(DRY_RUN),--dry-run,)

publish-verify: ## Publish now, then read /api/health back and check it serves this snapshot
	$(PY) -m wt.ops.publish --verify

seed-vm: ## From the Mac: copy runtime state to the GCP host and verify it (APPLY=1 also swaps it in; cutover v2)
	APPLY=$(APPLY) SRC=$(or $(SRC),$(HOME)/trading) deploy/gcp/bin/wt-seed-vm

watchdog-drill: ## Two real DRILL pages through the production watchdog path (late, then recovered); no state touched
	$(PY) -m wt.ops.drill

dashboard-deploy: ## OWNER: deploy origin/main's dashboard to production from a clean worktree, stamped with its commit
	@set -e; git fetch --quiet origin main; sha=$$(git rev-parse origin/main); tmp=$$(mktemp -d); \
	git worktree add --quiet --detach "$$tmp/wt" "$$sha"; \
	trap 'git worktree remove --force "$$tmp/wt" >/dev/null 2>&1 || true; rm -rf "$$tmp"' EXIT; \
	mkdir -p "$$tmp/wt/dashboard/.vercel" && cp dashboard/.vercel/project.json "$$tmp/wt/dashboard/.vercel/"; \
	cd "$$tmp/wt/dashboard" && vercel deploy --prod --yes --build-env BUILD_SHA="$$sha" && \
	short=$$(printf %.12s "$$sha"); echo "deployed $$short; /api/health should now report version $$short"

schema: ## Regenerate the dashboard contract: snapshot.schema.json (from ALLOW), thresholds.gen.ts, and the TS types
	$(PY) -c "import json; from wt.ops.publish import to_schema, SCHEMA_PATH; SCHEMA_PATH.parent.mkdir(parents=True, exist_ok=True); SCHEMA_PATH.write_text(json.dumps(to_schema(), indent=2) + '\\n')"
	$(PY) -c "import json; from wt.crypto.snapshot import to_schema, SCHEMA_PATH; SCHEMA_PATH.write_text(json.dumps(to_schema(), indent=2) + '\\n')"
	$(PY) scripts/gen_thresholds_ts.py
	@if [ -d dashboard/node_modules ]; then cd dashboard && pnpm -s gen:types; else echo "dashboard/node_modules missing: run pnpm install, then make schema again for the TS types"; fi

# The Mac's cloudflared client pin: 2026.6.0+ ignores Access service tokens (cloudflare/cloudflared#1673).
VM_CLOUDFLARED_VERSION := 2026.5.1

vm-deploy: ## Deploy on the OCI host through its Access tunnel: make vm-deploy [VERB=gate|status|preflight|deploy|units-diff]
	@v=$$($${CLOUDFLARED:-cloudflared} --version 2>/dev/null | awk '{print $$3}'); \
	if [ "$$v" != "$(VM_CLOUDFLARED_VERSION)" ]; then \
	  echo "cloudflared $$v on this Mac; vm-deploy needs $(VM_CLOUDFLARED_VERSION) (set CLOUDFLARED=/path/to/it; see docs/runbooks/oci-host.md)"; exit 2; fi; \
	set -a; . ./.env; set +a; \
	: "$${VM_SSH_HOST:?VM_SSH_HOST missing from .env}" "$${CF_ACCESS_CLIENT_ID:?}" "$${CF_ACCESS_CLIENT_SECRET:?}"; \
	ssh -o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=30 -i "$${VM_DEPLOY_KEY:-$$HOME/.ssh/wt-deploy}" \
	  -o ProxyCommand="$${CLOUDFLARED:-cloudflared} access ssh --hostname %h --id $$CF_ACCESS_CLIENT_ID --secret $$CF_ACCESS_CLIENT_SECRET" \
	  "wt@$$VM_SSH_HOST" "$${VERB:-status}"

kill: ## Stop new entries on a desk (exits keep being managed): make kill [DESK=crypto] REASON="..."
	@if [ "$(DESK)" = "crypto" ]; then f="$$($(PY) -c 'from wt.core.desk import DESKS; print(DESKS["crypto"].kill_file)')"; \
	  mkdir -p "$$(dirname "$$f")"; printf '%s\n' "$${REASON:-paused by make kill} ($$(date '+%Y-%m-%d %H:%M %Z'))" > "$$f" && echo "crypto KILL switch ON" && cat "$$f"; \
	else printf '%s\n' "$${REASON:-paused by make kill} ($$(date '+%Y-%m-%d %H:%M %Z'))" > KILL && echo "KILL switch ON" && cat KILL; \
	  $(PY) -m wt.ops.audit kill_on || true; fi

unkill: ## Allow entries again: paper B (refused while it is running), or make unkill DESK=crypto
	@if [ "$(DESK)" = "crypto" ]; then $(PY) -m wt.crypto.control unkill; else $(PY) -m wt.ops.control unkill; fi

reset-crypto-latch: ## OWNER: clear the crypto desk's daily-loss latch
	@$(PY) -m wt.crypto.control reset-latch

reset-latch: ## OWNER: clear the virtual account's loss latch: make reset-latch REASON="why it is safe" (refused while paper B runs)
	@$(PY) -m wt.ops.control reset-latch "$(REASON)"

evidence: ## Show what the weekly evidence PR would commit (DRY_RUN is the default here)
	$(PY) -m wt.ops.evidence --dry-run

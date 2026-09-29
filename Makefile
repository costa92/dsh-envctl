.PHONY: help install build typecheck test test-watch check clean demo-prepare check-harness-source demo-init demo-status demo-plan demo-doctor demo-capture demo-apply demo-list demo-rollback demo-gc smoke-dsh e2e-dsh

SHELL := /bin/bash
DSH_WORKSPACE ?= $(HOME)/code/dsh
DEMO_HOME ?= $(DSH_WORKSPACE)/dsh-demo
HARNESS_SOURCE ?= $(DSH_WORKSPACE)/deepseek-harness

# Default target
help:
	@echo "Available targets for dshenv:"
	@echo "  make install      - Install project dependencies using pnpm"
	@echo "  make build        - Compile TypeScript codebase into lib/"
	@echo "  make typecheck    - Run TypeScript type checks (tsc --noEmit)"
	@echo "  make test         - Run full automated test suite with Vitest"
	@echo "  make test-watch   - Run Vitest in interactive watch mode"
	@echo "  make check        - Run full quality gating (typecheck + build + test)"
	@echo "  make clean        - Remove build artifacts (lib/, coverage, caches)"
	@echo ""
	@echo "Demo targets (uses $(DEMO_HOME) as DSH_HOME):"
	@echo "  make demo-init    - Initialize dshenv in demo directory"
	@echo "  make demo-status  - Check environment status in demo directory"
	@echo "  make demo-plan    - Plan drift in demo directory"
	@echo "  make demo-doctor  - Probe DSH runtime in demo directory"
	@echo "  make demo-capture - Capture existing profiles into a candidate manifest"
	@echo "  make demo-apply   - Apply plan to demo directory (dry-run)"
	@echo "  make demo-list    - List declared plugins in demo directory"
	@echo "  make demo-rollback - Preview restoring the latest envctl snapshot"
	@echo "  make demo-gc      - Preview expired trash cleanup"
	@echo ""
	@echo "  make smoke-dsh DSH_VERSION=<v> - Install npm DSH <v> in a temp dir and run doctor/apply/plan against it"
	@echo "  make e2e-dsh DSH_VERSION=<v>   - Run the end-to-end test (main chain, scaffolds, Git sources, overlays, purge/gc, profile patches, team remote) against npm DSH <v>"
	@echo ""
	@echo "Demo paths (override with make TARGET VARIABLE=/path):"
	@echo "  DSH_WORKSPACE=$(DSH_WORKSPACE)"
	@echo "  DEMO_HOME=$(DEMO_HOME)"
	@echo "  HARNESS_SOURCE=$(HARNESS_SOURCE)"

install:
	pnpm install

build:
	pnpm run build

typecheck:
	pnpm run typecheck

test:
	pnpm run test

test-watch:
	pnpm exec vitest

check: typecheck build test

clean:
	rm -rf lib tsconfig.tsbuildinfo .vitest

demo-prepare:
	@mkdir -p "$(DSH_WORKSPACE)" "$(DEMO_HOME)"

check-harness-source:
	@if [ ! -d "$(HARNESS_SOURCE)" ]; then \
		echo "Harness source directory not found: $(HARNESS_SOURCE)" >&2; \
		echo "Set HARNESS_SOURCE=/path/to/deepseek-harness or DSH_WORKSPACE=/path/to/dsh." >&2; \
		exit 2; \
	fi

demo-init: build demo-prepare
	DSH_HOME="$(DEMO_HOME)" node bin/dshenv.js init

demo-status: build demo-prepare
	@DSH_HOME="$(DEMO_HOME)" node bin/dshenv.js status; \
	status=$$?; \
	if [ $$status -eq 0 ] || [ $$status -eq 2 ]; then exit 0; else exit $$status; fi

demo-plan: build demo-prepare
	-DSH_HOME="$(DEMO_HOME)" node bin/dshenv.js plan

demo-doctor: build demo-prepare check-harness-source
	DSH_HOME="$(DEMO_HOME)" node bin/dshenv.js --harness-source "$(HARNESS_SOURCE)" doctor

demo-capture: build demo-prepare
	DSH_HOME="$(DEMO_HOME)" node bin/dshenv.js capture

demo-apply: build demo-prepare
	-DSH_HOME="$(DEMO_HOME)" node bin/dshenv.js apply --dry-run

demo-list: build demo-prepare
	DSH_HOME="$(DEMO_HOME)" node bin/dshenv.js list

demo-rollback: build demo-prepare
	-DSH_HOME="$(DEMO_HOME)" node bin/dshenv.js rollback --dry-run

demo-gc: build demo-prepare
	-DSH_HOME="$(DEMO_HOME)" node bin/dshenv.js gc --dry-run

smoke-dsh: build
	@if [ -z "$(DSH_VERSION)" ]; then \
		echo "Set DSH_VERSION, e.g. make smoke-dsh DSH_VERSION=0.1.7-rc.2" >&2; \
		exit 2; \
	fi
	scripts/smoke-dsh.sh "$(DSH_VERSION)"

e2e-dsh: build
	@if [ -z "$(DSH_VERSION)" ]; then \
		echo "Set DSH_VERSION, e.g. make e2e-dsh DSH_VERSION=0.1.7-rc.2" >&2; \
		exit 2; \
	fi
	scripts/e2e-dsh.sh "$(DSH_VERSION)"

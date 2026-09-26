.PHONY: help install build typecheck test test-watch check clean demo-init demo-status demo-plan demo-doctor demo-apply

SHELL := /bin/bash
DEMO_HOME ?= /Users/costalong/code/dsh/dsh-demo
HARNESS_SOURCE ?= /Users/costalong/code/dsh/deepseek-harness

# Default target
help:
	@echo "Available targets for dsh-envctl:"
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
	@echo "  make demo-apply   - Apply plan to demo directory (dry-run)"

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

demo-init: build
	DSH_HOME=$(DEMO_HOME) node bin/dshenv.js init

demo-status: build
	@DSH_HOME=$(DEMO_HOME) node bin/dshenv.js status; \
	status=$$?; \
	if [ $$status -eq 0 ] || [ $$status -eq 2 ]; then exit 0; else exit $$status; fi

demo-plan: build
	-DSH_HOME=$(DEMO_HOME) node bin/dshenv.js plan

demo-doctor: build
	DSH_HOME=$(DEMO_HOME) node bin/dshenv.js --harness-source $(HARNESS_SOURCE) doctor

demo-apply: build
	DSH_HOME=$(DEMO_HOME) node bin/dshenv.js apply --dry-run

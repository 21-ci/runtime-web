.DEFAULT_GOAL := help

.PHONY: help ci ci-local ci-security clean web web-test web-lint web-audit e2e budget server-deps server-assets server-ci server-test server-deploy server-install coverage

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-15s %s\n", $$1, $$2}'

ci: web web-lint web-test budget server-ci ## Run the CI chain (web build/lint/test/budgets, server typecheck/lint/tests; e2e is separate)

ci-local: ## Everything CI and the security workflow check, locally, with a pass/fail summary (scripts/ci-local.sh)
	scripts/ci-local.sh

ci-security: ## Only npm audit, Trivy and CodeQL (scripts/ci-local.sh --security)
	scripts/ci-local.sh --security

web: ## Install web deps (npm ci) and build the console (web/dist)
	cd web && npm ci && npm run build

web-test: ## Run web tests (Vitest)
	cd web && npm test

web-lint: ## Lint the web console (ESLint) and check locale files against English (i18n:check)
	cd web && npm run lint
	cd web && npm run i18n:check

web-audit: ## Install web deps and fail on high-severity npm advisories
	cd web && npm ci && npm audit --audit-level=high

coverage: ## Web + server tests with v8 coverage and thresholds (reports in */coverage)
	cd web && npm run coverage
	cd server && npm run coverage

budget: ## Check the web gzip budgets of web/dist; with RTWEB_URL also the service health
	node --test scripts/budget-measure.test.js
	scripts/budget.sh

e2e: ## Run the Playwright smoke suite against a runtime-hosted console (needs RTWEB_URL)
	cd e2e && npm ci && npx playwright install --with-deps chromium && npx playwright test

clean: ## Remove build output
	rm -rf e2e/test-results e2e/playwright-report server/src/gen

server-deps: ## Install server deps (npm ci in server/)
	cd server && npm ci

server-assets: web ## Build web/dist and embed it as server/src/gen (gitignored)
	cd server && node scripts/gen-assets.mjs

server-test: server-deps ## Run server unit tests (Vitest)
	cd server && npm test

server-ci: server-deps ## Server typecheck + lint + unit tests
	cd server && node scripts/gen-assets.mjs && npm run ci

server-deploy: server-deps ## Dev deploy of server/ to the local runtime (needs RT_ROOT_TOKEN)
	cd server && node scripts/gen-assets.mjs && node scripts/deploy.mjs

server-install: server-assets ## Idempotent install onto a runtime node (needs RT_ROOT_TOKEN)
	cd server && node scripts/install.mjs

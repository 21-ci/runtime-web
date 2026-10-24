VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
COMMIT  ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo none)
DATE    ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ)
LDFLAGS := -s -w -X main.version=$(VERSION) -X main.commit=$(COMMIT) -X main.date=$(DATE)

.DEFAULT_GOAL := help

.PHONY: help build test vet vuln fmt fmt-check ci ci-full clean web web-test web-lint web-audit web-embed e2e budget docker compose-up compose-down server-deps server-assets server-ci server-test server-deploy server-install

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-12s %s\n", $$1, $$2}'

build: web-embed ## Build the rtweb binary into bin/ (embeds web/dist)
	CGO_ENABLED=0 go build -trimpath -ldflags "$(LDFLAGS)" -o bin/rtweb ./cmd/rtweb

test: ## Run Go tests
	go test ./...

vet: ## Run go vet
	go vet ./...

GOVULNCHECK ?= golang.org/x/vuln/cmd/govulncheck@v1.1.4

vuln: web-audit ## Scan Go (govulncheck) and web (npm audit) for known vulnerabilities
	go run $(GOVULNCHECK) ./...

fmt: ## Format Go code
	gofmt -w .

fmt-check: ## Fail if any Go file is not gofmt-clean
	@test -z "$$(gofmt -l .)" || { gofmt -l .; echo "gofmt: files above need formatting"; exit 1; }

ci: fmt-check vet test vuln web-lint web-test build budget server-ci ## Run the CI chain (no docker; e2e is separate)

ci-full: ci e2e ## Run ci plus the docker compose Playwright smoke (needs docker)

web: ## Install web deps (npm ci) and build the console (web/dist)
	cd web && npm ci && npm run build

web-test: ## Run web tests (Vitest)
	cd web && npm test

web-lint: ## Lint and typecheck the web console (ESLint)
	cd web && npm run lint

web-audit: ## Install web deps and fail on high-severity npm advisories
	cd web && npm ci && npm audit --audit-level=high

web-embed: web ## Copy web/dist into internal/api/dist for go:embed
	rm -rf internal/api/dist
	mkdir -p internal/api
	cp -R web/dist internal/api/dist

budget: build ## Check binary size, idle RSS and web gzip budgets (docs/02 section 7)
	node --test scripts/budget-measure.test.js
	scripts/budget.sh

docker: ## Build the rtweb and rtrouter images (rtweb:dev, rtrouter:dev)
	docker build -t rtweb:dev -f Dockerfile .
	docker build -t rtrouter:dev -f Dockerfile.router .

compose-up: ## Start runtime-copy + rtweb + rtrouter and wait until healthy
	docker compose up -d --build --wait

compose-down: ## Stop the compose stack (keeps volumes)
	docker compose down

e2e: compose-up ## Run the Playwright smoke suite against docker compose
	cd e2e && npm ci && npx playwright install --with-deps chromium && npx playwright test

clean: ## Remove build output
	rm -rf bin e2e/test-results e2e/playwright-report

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

VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
COMMIT  ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo none)
DATE    ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ)
LDFLAGS := -s -w -X main.version=$(VERSION) -X main.commit=$(COMMIT) -X main.date=$(DATE)

.DEFAULT_GOAL := help

.PHONY: help build test vet fmt fmt-check ci clean web web-test web-lint web-embed

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-12s %s\n", $$1, $$2}'

build: ## Build the rtweb binary into bin/
	CGO_ENABLED=0 go build -trimpath -ldflags "$(LDFLAGS)" -o bin/rtweb ./cmd/rtweb

test: ## Run Go tests
	go test ./...

vet: ## Run go vet
	go vet ./...

fmt: ## Format Go code
	gofmt -w .

fmt-check: ## Fail if any Go file is not gofmt-clean
	@test -z "$$(gofmt -l .)" || { gofmt -l .; echo "gofmt: files above need formatting"; exit 1; }

ci: fmt-check vet test build ## Run the full Go CI chain

web: ## Install web deps and build the console (web/dist)
	cd web && npm ci && npm run build

web-test: ## Run web tests (Vitest)
	cd web && npm test

web-lint: ## Lint and typecheck the web console (ESLint)
	cd web && npm run lint

web-embed: web ## Copy web/dist into internal/api/dist for go:embed
	rm -rf internal/api/dist
	mkdir -p internal/api
	cp -R web/dist internal/api/dist

clean: ## Remove build output
	rm -rf bin

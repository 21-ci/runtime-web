# Runtime Web

Go BFF plus React console for 21 Cloud Runtime. Module `github.com/21cloud/runtime-web`.

## Module map

| Dir | Responsibility |
|-----|----------------|
| `cmd/rtweb/` | Server entry point; loads config, sets up logging |
| `internal/config/` | Env-var configuration and validation (secret key, same-site rule) |
| `internal/seal/` | AES-256-GCM sealing of secrets at rest |
| `internal/apperr/` | Shared domain errors; API layer maps them to HTTP codes |
| `docs/contributing/code-style.md` | Binding code style (read before writing code) |
| `docs/` | User, admin, security and API docs (MkDocs site, `mkdocs.yml`); contributor guides in `docs/contributing/` |
| `AGENTS.md` | Guide for AI coding agents working on this repo |

## Commands

- `make help`: list targets
- `make ci`: gofmt check, vet, test, build
- `make test`: `go test ./...`
- `make build`: build `bin/rtweb`

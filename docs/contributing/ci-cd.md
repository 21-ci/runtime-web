# CI/CD and releasing

## Workflows (`.github/workflows/`)

| Workflow | Trigger | What it gates |
|----------|---------|---------------|
| `ci.yml` | PR, push to `main` | web: lint, Vitest + v8 coverage thresholds, build, gzip budget; server: lint, `tsc`, Vitest + coverage; shellcheck + `install.sh --dry-run`; `mkdocs build --strict` |
| `security.yml` | PR, push to `main`, weekly | Trivy fs (vuln, secret, misconfig; HIGH/CRITICAL fail; SARIF to code scanning), `npm audit` (runtime deps and all deps incl. dev; high/critical fail), CodeQL (javascript-typescript), gitleaks (full git history, `fetch-depth: 0`; reviewed false positives in `.gitleaksignore`), semgrep (`p/typescript`, `p/javascript`, `p/react`, `p/nodejsscan`, `p/secrets`, `p/github-actions`; blocks on ERROR; test files excluded in `.semgrepignore`), osv-scanner (`web/package-lock.json` and `server/package-lock.json`; any known vulnerability fails), OpenSSF Scorecard, zizmor + actionlint on the workflows |
| `pr-title.yml` | PR opened or edited | the PR title is a Conventional Commit (it becomes the squash commit subject and the changelog line) |
| `release-please.yml` | push to `main` | keeps the `chore: release X.Y.Z` PR open; merging it creates the tag and the GitHub Release |
| `release.yml` | tag `vX.Y.Z[-pre]` | tarball, SBOM, Trivy scan of the artifact, SHA256SUMS, cosign keyless signature, SLSA provenance, GitHub Release, post-publish verification |
| `docker.yml` | PR, push to `main`, tag `vX.Y.Z[-pre]` | hadolint; the container image (`Dockerfile`, flavors `distroless` and `slim`) for `linux/amd64` + `linux/arm64`, including the `rtweb-entry` Go tests. PRs build without pushing and gate the amd64 image on Trivy. `main` and tags push `ghcr.io/21-ci/runtime-web` by digest, gate both platforms on Trivy (fixable HIGH/CRITICAL fail; SARIF to code scanning), then tag (`edge` on `main`, `X.Y.Z` and `X.Y` on tags, `-slim` for slim), cosign-sign (keyless) and attest provenance and SBOM |

Every action is pinned by full commit SHA with a version comment; Dependabot (`.github/dependabot.yml`) bumps them
weekly together with the npm dependencies of `web/`, `server/` and `e2e/` and the pip requirements of the docs, each
ecosystem grouped into one PR with a Conventional Commit prefix (`build(deps)`, `ci(deps)`, `test(deps)`, `docs(deps)`). Workflows start from `permissions: {}` and grant
each job only what it needs. Accepted Trivy findings go in `.trivyignore` with a reason and an expiry.

## Branch and tag rules

Rulesets live in `.github/rulesets/` and are applied with `scripts/apply-rulesets.sh` (`gh api`, admin only). `main`
takes changes only through PRs with signed commits and linear history (squash or rebase), never a force-push or a
deletion, and requires these checks: `web`, `server`, `shell`, `docs`, `pr title`, `zizmor + actionlint`,
`npm audit (web)`, `npm audit (server)`, `trivy fs`, `codeql`, `gitleaks`, `semgrep`, `osv-scanner`. Renaming a job means updating `main.json` and re-running
the script. `v*` tags can be created only by the bypass list (repository admins and the release App) and never moved or
deleted. `scripts/ci-local.sh` runs the same checks as `security.yml` and `ci.yml` when the tools are installed (`brew install actionlint zizmor gitleaks semgrep osv-scanner`); `--security` runs only the security section.

## Coverage

`make coverage` runs both suites with v8 coverage (reports in `web/coverage/` and `server/coverage/`). Thresholds
live in `web/vitest.config.ts` and `server/vitest.config.ts`, set at the current level rounded down. Raise them when
coverage improves; never lower them to make a PR pass.

## Cutting a release

The full flow, with the one-time setup, is in [RELEASING.md](https://github.com/21-ci/runtime-web/blob/main/RELEASING.md).
In short:

1. PRs merge into `main` with Conventional Commit titles. release-please (`release-please.yml`, run with a GitHub App
   token) keeps a `chore: release X.Y.Z` PR open that bumps `server/package.json`, `web/package.json` and
   `.release-please-manifest.json` and writes the `CHANGELOG.md` section (config in `release-please-config.json`).
2. Merging it tags `vX.Y.Z` and creates the GitHub Release. A maintainer can also tag by hand
   (`git tag -s vX.Y.Z && git push origin vX.Y.Z`) when the package versions already match. A `-rc.N` suffix publishes
   a pre-release.
3. `release.yml` publishes these assets:
   - `runtime-web-X.Y.Z.tar.gz`: `server/` (`src/`, `sdk/rtctl/`, `scripts/install.mjs` + `gen-assets.mjs`, `rt.json`,
     `package*.json`), `web/dist/`,
     `deploy/Caddyfile`, `deploy/rt.rtweb.toml`, `install.sh`, `VERSION`
   - `runtime-web-X.Y.Z.spdx.json` (SBOM), `install.sh`
   - `SHA256SUMS`, `SHA256SUMS.sigstore.json`
4. The same tag starts `docker.yml`, which publishes `ghcr.io/21-ci/runtime-web:X.Y.Z` (and `X.Y`, plus the `-slim`
   tags). A pre-release tag gets only `X.Y.Z-rc.N`.
5. The `verify` job re-downloads the release and checks the checksums, signature and attestation. If it fails,
   delete the release and the tag, fix the cause, and tag again.

Verify a release by hand:

```sh
cosign verify-blob --bundle SHA256SUMS.sigstore.json \
  --certificate-identity-regexp '^https://github\.com/21-ci/runtime-web/\.github/workflows/release\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com SHA256SUMS
sha256sum --check --ignore-missing SHA256SUMS
gh attestation verify runtime-web-X.Y.Z.tar.gz -R 21-ci/runtime-web
```

Verify an image:

```sh
cosign verify ghcr.io/21-ci/runtime-web:X.Y.Z \
  --certificate-identity-regexp '^https://github\.com/21-ci/runtime-web/\.github/workflows/docker\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
gh attestation verify oci://ghcr.io/21-ci/runtime-web:X.Y.Z -R 21-ci/runtime-web
```

The image pins `ghcr.io/21-ci/rt` by digest (`RT_IMAGE` in `Dockerfile`). When `install.sh` moves to a new runtime
release (`RT_PINNED_VERSION`), bump `RT_IMAGE` in the same change. `docker/entry/bootstrap.go` repeats the steps of
`server/scripts/install.mjs`: change both together.

## Installing

`install.sh` (repository root, also attached to each release) installs a release on a Linux host:

```sh
curl -fsSL https://raw.githubusercontent.com/21-ci/runtime-web/main/install.sh -o install.sh
sudo sh install.sh \
  --domain console.example.com --email ops@acme-corp.dev
```

It verifies the Sigstore signature on `SHA256SUMS` (cosign required; `--insecure-skip-signature` skips it) and the
tarball against it, installs `rt` when missing from a pinned runtime release whose `SHA256SUMS` and tarball sha256 are
pinned in `install.sh`, generates `RTWEB_RELAY_SECRET` into `/etc/rtweb/rtweb.env` (0600) and sets it plus
`RTWEB_OP_TOKEN="Bearer <root token>"` in the rt environment file,
wires the plan and bindings (`deploy/rt.rtweb.toml`) into `/etc/rt/rt.toml`, installs the Caddy site and runs
`server/scripts/install.mjs` with `RT_ROOT_TOKEN` (from the rt environment file), `RTWEB_ORIGIN=https://<domain>`,
`RTWEB_HOST=<domain>`, `RTWEB_RUNTIME_PUBLIC_URL` (`--public-url`, default `https://<apps-domain>`, `--apps-domain` defaults to `apps.<domain>`), `RTWEB_DEFAULT_PLAN`
(`--default-plan`) and `RTWEB_VERSION`. Use `--dry-run` to see every step without changing anything and
`--uninstall` to remove it again. The Caddyfile reads `{$RTWEB_DOMAIN}`, `{$RTWEB_ACME_EMAIL}` and
`{$RTWEB_RELAY_SECRET}` from `/etc/rtweb/caddy.env` (0600), loaded by a systemd drop-in for `caddy.service`.

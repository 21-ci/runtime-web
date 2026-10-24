# CI/CD and releasing

## Workflows (`.github/workflows/`)

| Workflow | Trigger | What it gates |
|----------|---------|---------------|
| `ci.yml` | PR, push to `main` | web: lint, Vitest + v8 coverage thresholds, build, gzip budget; server: lint, `tsc`, Vitest + coverage; shellcheck + `install.sh --dry-run`; `mkdocs build --strict` |
| `security.yml` | PR, push to `main`, weekly | Trivy fs (vuln, secret, misconfig; HIGH/CRITICAL fail; SARIF to code scanning), `npm audit` (runtime deps and all deps incl. dev; high/critical fail), CodeQL (javascript-typescript), OpenSSF Scorecard |
| `release.yml` | tag `vX.Y.Z[-pre]` | tarball, SBOM, Trivy scan of the artifact, SHA256SUMS, cosign keyless signature, SLSA provenance, GitHub Release, post-publish verification |

Every action is pinned by full commit SHA with a version comment; Dependabot (`.github/dependabot.yml`) bumps them
weekly together with the npm dependencies of `web/` and `server/`. Workflows start from `permissions: {}` and grant
each job only what it needs. Accepted Trivy findings go in `.trivyignore` with a reason and an expiry.

## Coverage

`make coverage` runs both suites with v8 coverage (reports in `web/coverage/` and `server/coverage/`). Thresholds
live in `web/vitest.config.ts` and `server/vitest.config.ts`, set at the current level rounded down. Raise them when
coverage improves; never lower them to make a PR pass.

## Cutting a release

1. Set `"version": "X.Y.Z"` in `server/package.json` and `web/package.json` (the build job fails when they do
   not match the tag). Add a `## [X.Y.Z]` section to `CHANGELOG.md` (it becomes the release notes via `scripts/release-notes.sh`).
2. Make sure `main` is green, then tag and push: `git tag -s vX.Y.Z && git push origin vX.Y.Z`.
   A `-rc.N` suffix publishes a pre-release.
3. `release.yml` publishes these assets:
   - `runtime-web-X.Y.Z.tar.gz`: `server/` (`src/`, `sdk/rtctl/`, `scripts/install.mjs` + `gen-assets.mjs`, `rt.json`,
     `package*.json`), `web/dist/`,
     `deploy/Caddyfile`, `deploy/rt.rtweb.toml`, `install.sh`, `VERSION`
   - `runtime-web-X.Y.Z.spdx.json` (SBOM), `install.sh`
   - `SHA256SUMS`, `SHA256SUMS.sigstore.json`
4. The `verify` job re-downloads the release and checks the checksums, signature and attestation. If it fails,
   delete the release and the tag, fix the cause, and tag again.

Verify a release by hand:

```sh
cosign verify-blob --bundle SHA256SUMS.sigstore.json \
  --certificate-identity-regexp '^https://github\.com/21-ci/runtime-web/\.github/workflows/release\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com SHA256SUMS
sha256sum --check --ignore-missing SHA256SUMS
gh attestation verify runtime-web-X.Y.Z.tar.gz -R 21-ci/runtime-web
```

## Installing

`install.sh` (repository root, also attached to each release) installs a release on a Linux host:

```sh
curl -fsSL https://raw.githubusercontent.com/21-ci/runtime-web/main/install.sh -o install.sh
sudo sh install.sh \
  --domain console.example.com --email ops@example.com
```

It verifies the Sigstore signature on `SHA256SUMS` (cosign required; `--insecure-skip-signature` skips it) and the
tarball against it, installs `rt` when missing from a pinned runtime release whose `SHA256SUMS` and tarball sha256 are
pinned in `install.sh`, generates `RTWEB_RELAY_SECRET` into `/etc/rtweb/rtweb.env` (0600) and sets it plus
`RTWEB_OP_TOKEN="Bearer <root token>"` in the rt environment file,
wires the plan and bindings (`deploy/rt.rtweb.toml`) into `/etc/rt/rt.toml`, installs the Caddy site and runs
`server/scripts/install.mjs` with `RT_ROOT_TOKEN` (from the rt environment file), `RTWEB_ORIGIN=https://<domain>`,
`RTWEB_HOST=<domain>`, `RTWEB_RUNTIME_PUBLIC_URL` (`--public-url`, default `https://<domain>`), `RTWEB_DEFAULT_PLAN`
(`--default-plan`) and `RTWEB_VERSION`. Use `--dry-run` to see every step without changing anything and
`--uninstall` to remove it again. The Caddyfile reads `{$RTWEB_DOMAIN}`, `{$RTWEB_ACME_EMAIL}` and
`{$RTWEB_RELAY_SECRET}` from `/etc/rtweb/caddy.env` (0600), loaded by a systemd drop-in for `caddy.service`.

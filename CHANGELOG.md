# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Interactive installer: `install.sh` asks for the mode (bare systemd service or Docker Compose), the domain, the
  console host, the apps domain, certificates and the ACME e-mail, checks DNS (including the `*.<apps domain>`
  wildcard) and ports 80/443, waits for the console and prints the URLs, the one-time setup token, the next steps and
  where data and secrets live. Everything stays scriptable with flags and `--yes`; colors only on a terminal and never
  with `NO_COLOR`.
- Docker mode in `install.sh`: the signed `ghcr.io/21-ci/runtime-web` image (pinned by digest, verified with cosign)
  with a Caddy container for Let's Encrypt, secrets as Docker secrets, `--uninstall [--purge]`. Docker is installed
  only with consent (`--install-docker`).
- `--tls auto|staging|internal|none` and `--wildcard-cert` (one `*.<apps domain>` certificate over DNS-01 with a
  Cloudflare API token, stored as a systemd credential or Docker secret, never printed; Caddy with the pinned
  Cloudflare module).
- An `unlimited` runtime plan in `deploy/rt.rtweb.toml`, the default for new orgs in both install modes.
- `docs/design/data-protection.md`: what is stored at rest, the threat model and a phased encryption plan.

- Public documentation: README, security policy, contributing guide, governance, release process, the MkDocs site
  (user, admin, security and API reference) and agent guidance in `AGENTS.md`.
- Instance branding: the console name, logos, favicon, sign-in copy, sidebar brand and help links are set from a
  Branding section in admin settings, with a light and dark live preview. Colours apply before first paint.
- Contextual app sidebar: app pages show the App's own navigation, org pages show projects, and breadcrumbs include
  the App section.
- App pages with a live preview of the running App, a usage card, and a clear message when a preview is blocked
  instead of a broken frame.
- Instance admin pages render in the main console shell, with an Instance group in the sidebar and in the command menu
  (⌘K).

### Changed

- **Breaking:** every App is served on its own subdomain, `https://<app>.<apps domain>/` (the node's
  `routing.base_domain`), and never at `/s/<app>/`: the edge (Caddy and `rtweb-entry`) answers `404` for `/s/` on the
  apps domain, for the bare apps domain and for the console's slug under it. Add a wildcard DNS record
  `*.<apps domain>`. `RTWEB_RUNTIME_PUBLIC_URL` must be an origin without a path, and the console host must not be
  under it. The App preview's `frame-src` allows `https://*.<apps domain>`.
- `tls-ask` also approves `<app>.<apps domain>` for an existing App, so each App gets its certificate on demand.
- The container passes `rt` the root token and master key as `*_FILE` paths when they come from files (the master key
  is no longer in the node's environment), creates everything with `umask 077`, and points `TMPDIR` and
  `SQLITE_TMPDIR` at `/data/tmp`: a `/tmp` tmpfs is optional now. Its default plan for new orgs is `unlimited`.
- A new bare-mode node gets its master key as a systemd credential (`LoadCredential`), not an environment variable.

- Neutral design tokens and a quieter UI kit: white canvas, off-white chrome, a single blue accent, a new dark theme
  of three neutral grey steps, and 6px or 10px radii on buttons, inputs, cards and dialogs.
- Cards keep their text inside the card, and sibling cards in a row share one height.
- **Breaking:** Apps are served from their own apps host (`apps.<domain>` by default, set with `--apps-domain` in
  `install.sh`). The DNS zone needs an apps record before upgrading. The server refuses to serve Apps from the console
  origin, and refuses a `RTWEB_RUNTIME_PUBLIC_URL` that matches it.
- The App preview frame is allowed by the Content Security Policy (`frame-src`) when the apps host is set. It stays
  `'none'` otherwise.
- Usage shows only today's counters, in UTC, instead of one row per day the runtime returned.
- Console tenant plan limits raised to 300 requests per second and 64 concurrent requests, with no daily cap, so normal
  page loads no longer hit `rate_limited`.
- Project creation, update and deletion, and queue sends, are written to the org audit log.
- Documentation restructured around install, operate and contribute tasks, with the README, `SUPPORT`, `NOTICE` and
  `llms.txt` rewritten.

### Fixed

- A signed-out tab is sent to the login page once per burst of 401 responses instead of looping.
- Trigger pages honour the plan's allowed trigger types, so cron is disabled where the plan forbids it.
- The overview shows runtime request and latency stats (the runtime's stats keys are mapped correctly).
- The creating user is recorded as the author of a template App's first version.
- The first-run default org is created from the org list if setup could not create it while the runtime was not ready.
- Token and default-key audit rows are flagged as instance-admin actions.
- The App editor shows the stored source instead of a read-only bundle.
- The installer grants rtctl access correctly on a fresh node, and the console URL printed at the end is the real one.
- Usage preview stays readable in dark mode.

### Security

- Login is throttled per IP, per account and globally. The client IP comes only from the runtime. Argon2 runs are capped,
  and new password hashes use stronger parameters with old hashes rehashed on sign-in.
- OAuth never links an identity to an existing account by matching email. Linking requires a signed-in session. OAuth
  `next` targets are limited to printable same-origin paths.
- Sealed secrets (default keys, TOTP secrets and OAuth client secrets) are bound to their row with AES-GCM
  additional authenticated data.
- TOTP enrollment requires the current password.
- Internal routes accept only loopback callers.
- All responses send a Content Security Policy, framing, referrer and HSTS headers.
- The installer records and verifies a SHA-256 for each part of the release blob.

## [0.1.0] - TBD

First release of the Runtime Web console on top of 21 Cloud Runtime.

### Added

- Users, instance setup and first-run admin account, password policy, and session login with CSRF and Origin checks.
- Two-factor authentication (TOTP) and GitHub, Google and generic OIDC sign-in, with optional enforcement per instance.
- Orgs, projects, members with owner, admin and member roles, per-project roles (admin, developer and viewer), and invites.
- Apps: creation from templates, code editor with type checking, versions and rollback, settings for limits, scaling,
  ingress and egress, and access rules.
- Triggers: HTTP routes, interval and cron schedules, and the durable queue with a dead-letter queue.
- Environment variables and write-only secrets, sealed at rest.
- Scoped API tokens and default org keys, shown once on creation.
- Custom domains with DNS TXT verification and router-managed TLS.
- Live log stream over Server-Sent Events, and per-app usage stats.
- Org audit log and an instance admin console (users, orgs, runtime node, cache, settings, domains, audit).

[Unreleased]: https://github.com/21-ci/runtime-web/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/21-ci/runtime-web/releases/tag/v0.1.0

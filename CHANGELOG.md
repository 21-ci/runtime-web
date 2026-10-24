# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Public documentation: README, security policy, contributing guide, governance, release process, the MkDocs site
  (user, admin, security and API reference) and agent guidance in `AGENTS.md`.

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

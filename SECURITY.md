# Security Policy

Runtime Web is the console in front of a 21 Cloud Runtime node. It holds sessions, credentials, sealed secrets and
the keys that deploy and call apps, so a flaw here can reach every app in an org. We take reports seriously.

## Supported versions

Security fixes go to the latest release line. Before 1.0, only the most recent `0.x` release receives fixes.

| Version | Supported |
|---------|-----------|
| latest `0.x` | yes |
| older `0.x` | no, upgrade |
| `main` | best effort, for testing only |

## Reporting a vulnerability

Please do not open a public issue for security bugs. Report privately through GitHub's **Report a vulnerability**
(private security advisory) on this repository. Include:

- the affected version or commit,
- the steps to reproduce, or a proof of concept,
- the impact you expect, and which boundary it crosses (session, CSRF, tenant isolation, secrets, domains, admin).

We will acknowledge the report, agree a fix and disclosure timeline with you, and credit you unless you prefer
otherwise. Coordinated disclosure is expected: give us a reasonable window to ship a fix before you publish.

## Scope

In scope: the console (API and SPA), the router, the setup and login flows, OAuth and TOTP, sealing of secrets at
rest, custom domain verification, audit log integrity, and anything that lets one user or org act on another's
resources.

Out of scope: the 21 Cloud Runtime node itself (report to [21-ci/runtime](https://github.com/21-ci/runtime) and see
its own SECURITY.md), findings that need a malicious instance admin or a compromised host, missing best-practice
headers without a demonstrated impact, and social engineering.

## Operator responsibilities

The security model, including what is and is not protected, is in the
[security model](https://21-ci.github.io/runtime-web/security-model/) docs. Before you expose an instance, replace
every `dev-insecure-*` value, run with `RTWEB_DEV` unset, use HTTPS for public URLs, and set trusted proxies only to
addresses you control.

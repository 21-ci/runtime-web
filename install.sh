#!/bin/sh
# Install Runtime Web (the 21 Cloud console) on a Linux host: interactive, or fully scripted with flags.
#
#   curl -fsSL https://raw.githubusercontent.com/21-ci/runtime-web/main/install.sh | sudo sh
#   curl -fsSL .../install.sh | sudo sh -s -- --yes --mode docker --domain console.example.com --email you@your-company.com
#
# Without --yes and with a terminal (also under `curl | sh`: questions are read from /dev/tty), the installer asks for
# everything it needs. With --yes, or without a terminal, it uses the flags and the defaults and never asks.
#
# Modes:
#   bare     (default without a terminal) rt as a systemd service, Runtime Web as an App on it, Caddy on the host
#   docker   the ghcr.io/21-ci/runtime-web image with docker compose, plus a Caddy container for TLS
#
# Options:
#   --mode bare|docker     how to install (asked when interactive; default bare)
#   --base-domain DOMAIN   sets --domain console.DOMAIN and --apps-domain apps.DOMAIN (when not given)
#   --domain HOST          console host name (required, or --base-domain)
#   --apps-domain HOST     every App is served at https://<app>.<apps-domain>/, its own origin, never the console's
#                          (default: apps.<domain>; needs a wildcard DNS record *.<apps-domain>)
#   --email ADDR           ACME account e-mail for Let's Encrypt (required unless --tls internal|none)
#   --tls MODE             certificates: auto (Let's Encrypt, default), staging (Let's Encrypt staging, for tests),
#                          internal (Caddy's own CA, for tests and LANs), none (docker only: no Caddy, bring your
#                          own TLS proxy in front of 127.0.0.1:<http-port>)
#   --version X.Y.Z        Runtime Web release (default: the latest)
#   --yes, -y              never ask; use the flags and the defaults
#   --dry-run              print every step instead of changing the host (needs no root, no network)
#   --uninstall            remove Runtime Web (mode from --mode or detected); data volumes stay unless --purge
#   --purge                with --uninstall --mode docker: also delete the data volumes and the secrets
#   --wildcard-cert        one wildcard certificate for *.<apps-domain> (Let's Encrypt DNS-01) instead of one
#                          certificate per App issued on demand (HTTP-01): for many Apps or Let's Encrypt rate
#                          limits. Needs a DNS provider API token
#   --dns-provider NAME    DNS provider for --wildcard-cert: cloudflare (the only one, and the default)
#   --dns-token-file PATH  file with the provider's API token (asked for, hidden, when interactive). The token is
#                          stored as a 0600 secret (systemd credential / Docker secret); never pass it on the command
#                          line, it is never printed
#   --skip-dns-check       do not check that the domains point at this host (the check asks api.ipify.org for
#                          this host's public address)
#   -h, --help
# Bare mode only:
#   --public-url URL       public base of app URLs, RTWEB_APPS_URL (default: https://<apps-domain>)
#   --default-plan NAME    runtime plan for new org tenants, RTWEB_DEFAULT_PLAN (default: unlimited, the plan in
#                          deploy/rt.rtweb.toml with no quotas; define your own [plans.NAME] in rt.toml to limit)
#   --runtime-version X    21 Cloud Runtime release to install when `rt` is missing (default: the pinned
#                          RT_PINNED_VERSION below; any other version needs cosign)
#   --caddy-sha256 HEX     with --wildcard-cert: expected sha256 of the Caddy build with the DNS module (caddyserver.com
#                          download API, pinned versions); the installer prints the digest it got
#   --tarball PATH         install from a local runtime-web-X.Y.Z.tar.gz (release layout) instead of downloading
#                          one: for testing a local build or air-gapped hosts. The tarball is NOT signature-checked;
#                          pass --insecure-skip-signature to confirm (with --sha256 HEX it is checked against HEX)
# Docker mode only:
#   --image REF            run this image instead of ghcr.io/21-ci/runtime-web:<version> (not signature-checked:
#                          needs --insecure-skip-signature)
#   --install-docker       install Docker Engine with Docker's script (get.docker.com) when it is missing;
#                          interactive runs ask instead
#   --http-port N          host port for HTTP (default 80; with --tls none: 8080 on 127.0.0.1)
#   --https-port N         host port for HTTPS (default 443)
#   --docker-subnet CIDR   subnet of the compose network, trusted for X-Forwarded-For (default 172.31.221.0/24)
# Both:
#   --insecure-skip-signature
#                          install without verifying the Sigstore signature (checksums only). Without this flag
#                          the installer refuses to run when cosign is not on PATH.
#
# What bare mode does (docs/contributing/architecture.md section 5):
#   1. checks root, Linux, x86_64/aarch64, curl, tar, sha256sum|shasum, node >= 22.5, DNS and ports 80/443
#   2. downloads runtime-web-<ver>.tar.gz + SHA256SUMS + Sigstore bundle, verifies the signature on SHA256SUMS
#      (release workflow identity) and the tarball against it, unpacks to /opt/runtime-web
#   3. installs the runtime node (rt) when it is not on PATH: the release tarball of a pinned version, checked against
#      a SHA256SUMS whose own sha256 is pinned in this file (and its Sigstore signature when cosign is on PATH).
#      A new node gets its master key as a systemd credential (LoadCredential), never in its environment.
#      Nothing is ever fetched from a branch or a raw file at a git ref.
#   4. generates RTWEB_RELAY_SECRET (0600, never printed), derives RTWEB_OP_TOKEN ("Bearer <root token>"), adds
#      the rtweb plan + bindings (deploy/rt.rtweb.toml) and ingress.trusted_proxies to /etc/rt/rt.toml, restarts rt
#   5. installs the Caddy site (deploy/Caddyfile: relay + console host + on-demand TLS gated by an `ask` endpoint)
#      and puts its import first in /etc/caddy/Caddyfile (the site file holds the global options)
#   6. runs server/scripts/install.mjs with the node's root token read from the rt environment file
#   7. waits for the console, prints its URLs, the one-time setup token and the next steps
#
# What docker mode does: verifies the image signature (cosign), writes /opt/runtime-web/docker/{compose.yaml,
# Caddyfile,secrets/} (secrets as Docker secrets, 0400, never printed), starts the compose project
# `runtime-web`, waits for the healthcheck and prints the setup token from /data/rtweb/secrets/setup-token.
#
# Environment: RTWEB_SLUG (console service slug, default rtweb), RTWEB_INSTALL_REPO (default 21-ci/runtime-web),
# RTWEB_INSTALL_BASE_URL (release download mirror; the signature still has to come from the release workflow),
# RTWEB_DOCKER_DIR (default /opt/runtime-web/docker), RTWEB_COMPOSE_PROJECT (default runtime-web),
# GITHUB_TOKEN (optional, for the latest-version lookup), NO_COLOR (plain output).
set -eu

# The whole script runs from main(), called on the last line: a truncated `curl | sh` download runs nothing.
main() {

REPO=${RTWEB_INSTALL_REPO:-21-ci/runtime-web}
BASE_URL=${RTWEB_INSTALL_BASE_URL:-https://github.com/$REPO/releases/download}
CERT_IDENTITY_REGEXP="^https://github\.com/$REPO/\.github/workflows/release\.yml@refs/tags/v"
IMAGE_IDENTITY_REGEXP="^https://github\.com/$REPO/\.github/workflows/docker\.yml@refs/tags/v"
CERT_OIDC_ISSUER=https://token.actions.githubusercontent.com
IMAGE_REPO=ghcr.io/21-ci/runtime-web
# Caddy for docker mode, pinned by digest (multi-arch index).
CADDY_IMAGE=caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d
LE_STAGING=https://acme-staging-v02.api.letsencrypt.org/directory

# 21 Cloud Runtime: fixed repository and a pinned release. To bump: download SHA256SUMS of the new release,
# verify it with cosign (RT_CERT_IDENTITY_REGEXP), and paste `sha256sum SHA256SUMS` and the two rt tarball sums here.
RT_REPO=21-ci/runtime
RT_BASE_URL=https://github.com/$RT_REPO/releases/download
RT_CERT_IDENTITY_REGEXP='^https://github\.com/21-ci/runtime/\.github/workflows/release\.yml@refs/tags/v'
RT_PINNED_VERSION=0.1.1
RT_PINNED_SUMS_SHA256=c0758bc73b989020fd892789c1349dc289e99f8934338fd644f2fd036994bc0f
RT_PINNED_X86_64_SHA256=d688db474959907e80ab3d63575c5a2f8be9882cc99f2f38f34271abfcc65531
RT_PINNED_AARCH64_SHA256=a37008c25605286b952e2a5c0e7d4430b2a499f2c2000b715edbb367f95a4375

PREFIX=/opt/runtime-web
ETC=/etc/rtweb
RT_TOML=/etc/rt/rt.toml
RT_CRED_DIR=/etc/rt/credentials
RT_CRED_DROPIN=/etc/systemd/system/rt.service.d/rtweb-credentials.conf
CADDY_SITE=/etc/caddy/Caddyfile.d/rtweb.caddy
# Sorts after rtweb.caddy (global options and the rtweb_upstream snippet come first).
# Written by an earlier version of this installer; removed on install and uninstall.
CADDY_WILDCARD_SITE=/etc/caddy/Caddyfile.d/rtweb.wildcard.caddy
CADDY_DNS_BIN=/usr/local/bin/caddy-rtweb
# Caddy with a DNS provider module (--wildcard-cert). Both versions pinned; bump them together with CADDY_IMAGE.
CADDY_VERSION=2.10.2
CADDY_BUILDER_IMAGE=caddy:2.10.2-builder-alpine@sha256:4cff3ae272ea05842adb4546e35961e4947aeea65f80fa1eb62a35b960e84971
CADDY_DROPIN=/etc/systemd/system/caddy.service.d/rtweb.conf
CADDY_MAIN=/etc/caddy/Caddyfile
CADDY_IMPORT='import /etc/caddy/Caddyfile.d/*.caddy'
CADDY_IMPORT_MARK='# runtime-web install.sh: this import must stay first (rtweb.caddy holds the global options)'
DOCKER_DIR=${RTWEB_DOCKER_DIR:-$PREFIX/docker}
PROJECT=${RTWEB_COMPOSE_PROJECT:-runtime-web}
NODE_MIN_MAJOR=22
NODE_MIN_MINOR=5
BLOCK_BEGIN='# >>> runtime-web (managed by install.sh; do not edit inside) >>>'
BLOCK_END='# <<< runtime-web <<<'
LEGACY_MARK='# --- added by runtime-web install.sh ---'

MODE=""
TLS=""
VERSION=""
RT_VERSION=""
DOMAIN=""
APPS_DOMAIN=""
EMAIL=""
PUBLIC_URL=""
DEFAULT_PLAN=unlimited
TARBALL=""
TARBALL_SHA256=""
IMAGE=""
HTTP_PORT=""
HTTPS_PORT=""
SUBNET=""
SLUG=${RTWEB_SLUG:-rtweb}
DRY_RUN=0
UNINSTALL=0
PURGE=0
SKIP_SIG=0
ASSUME_YES=0
INSTALL_DOCKER=0
SKIP_DNS=0
SETUP_TOKEN=""
WILDCARD=""
DNS_PROVIDER=""
DNS_TOKEN_FILE=""
CADDY_SHA256=""
DNS_TOKEN=""
BASE_DOMAIN=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --mode) need_arg "$@"; MODE=$2; shift 2 ;;
    --tls) need_arg "$@"; TLS=$2; shift 2 ;;
    --version) need_arg "$@"; VERSION=${2#v}; shift 2 ;;
    --runtime-version) need_arg "$@"; RT_VERSION=${2#v}; shift 2 ;;
    --domain) need_arg "$@"; DOMAIN=$2; shift 2 ;;
    --apps-domain) need_arg "$@"; APPS_DOMAIN=$2; shift 2 ;;
    --email) need_arg "$@"; EMAIL=$2; shift 2 ;;
    --public-url) need_arg "$@"; PUBLIC_URL=$2; shift 2 ;;
    --default-plan) need_arg "$@"; DEFAULT_PLAN=$2; shift 2 ;;
    --tarball) need_arg "$@"; TARBALL=$2; shift 2 ;;
    --sha256) need_arg "$@"; TARBALL_SHA256=$2; shift 2 ;;
    --image) need_arg "$@"; IMAGE=$2; shift 2 ;;
    --http-port) need_arg "$@"; HTTP_PORT=$2; shift 2 ;;
    --https-port) need_arg "$@"; HTTPS_PORT=$2; shift 2 ;;
    --docker-subnet) need_arg "$@"; SUBNET=$2; shift 2 ;;
    # Kept for old command lines: verification is now always required.
    --verify-signature) shift ;;
    --insecure-skip-signature) SKIP_SIG=1; shift ;;
    --install-docker) INSTALL_DOCKER=1; shift ;;
    --skip-dns-check) SKIP_DNS=1; shift ;;
    --wildcard-cert) WILDCARD=1; shift ;;
    --dns-provider) need_arg "$@"; DNS_PROVIDER=$2; WILDCARD=1; shift 2 ;;
    --base-domain) need_arg "$@"; BASE_DOMAIN=$2; shift 2 ;;
    --dns-token-file) need_arg "$@"; DNS_TOKEN_FILE=$2; shift 2 ;;
    --caddy-sha256) need_arg "$@"; CADDY_SHA256=$2; shift 2 ;;
    --yes | -y) ASSUME_YES=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --purge) PURGE=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

init_ui
init_tty

# --- uninstall -----------------------------------------------------------------------------------------------------
if [ "$UNINSTALL" = 1 ]; then
  if [ -z "$MODE" ]; then
    if [ -f "$DOCKER_DIR/compose.yaml" ]; then MODE=docker; else MODE=bare; fi
  fi
  check_mode
  platform_checks
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT INT TERM
  if [ "$MODE" = docker ]; then uninstall_docker; else uninstall_bare; fi
  exit 0
fi

banner

# --- questions (interactive only; flags always win) ----------------------------------------------------------------
if [ -n "$TTY" ]; then
  if [ -z "$MODE" ]; then
    say "How should Runtime Web run on this host?"
    say "  1) bare    rt as a systemd service, Caddy on the host (needs node >= $NODE_MIN_MAJOR.$NODE_MIN_MINOR)"
    say "  2) docker  the runtime-web container image with docker compose and a Caddy container"
    choose "Mode" 1 "bare docker"
    MODE=$REPLY
  fi
  while [ -z "$DOMAIN" ] && [ -z "$BASE_DOMAIN" ]; do
    ask "Your domain (for example example.com)" ""
    BASE_DOMAIN=$REPLY
    valid_host "$BASE_DOMAIN" || { warn "'$BASE_DOMAIN' is not a fully qualified host name"; BASE_DOMAIN=""; }
  done
  if [ -z "$DOMAIN" ]; then
    ask "Console host" "console.$BASE_DOMAIN"
    DOMAIN=$REPLY
  fi
  if [ -z "$APPS_DOMAIN" ]; then
    ask "Apps domain: every App at <app>.<apps domain>" "apps.${BASE_DOMAIN:-$DOMAIN}"
    APPS_DOMAIN=$REPLY
  fi
  if [ -z "$TLS" ]; then
    say "HTTPS certificates:"
    say "  1) auto      Let's Encrypt, issued and renewed automatically (recommended)"
    say "  2) staging   Let's Encrypt staging: untrusted certificates, for trying the installer"
    say "  3) internal  Caddy's own CA: untrusted certificates, for tests and private networks"
    if [ "$MODE" = docker ]; then
      say "  4) none      no Caddy: I put my own TLS proxy in front of 127.0.0.1:8080"
      choose "Certificates" 1 "auto staging internal none"
    else
      choose "Certificates" 1 "auto staging internal"
    fi
    TLS=$REPLY
  fi
  if [ -z "$WILDCARD" ] && { [ "$TLS" = auto ] || [ "$TLS" = staging ]; }; then
    say "Every App is served at https://<app>.$APPS_DOMAIN/ (DNS: a wildcard record *.$APPS_DOMAIN -> this host)."
    say "  By default each App gets its own certificate on its first visit (no extra setup). One wildcard"
    say "  certificate instead suits many Apps or Let's Encrypt rate limits; it needs your DNS provider's API token."
    if confirm "Use one wildcard certificate (DNS-01, Cloudflare DNS only)?" n; then WILDCARD=1; else WILDCARD=0; fi
  fi
  if [ "$WILDCARD" = 1 ] && [ -z "$DNS_TOKEN_FILE" ] && [ "$DRY_RUN" = 0 ]; then
    say "  The zone of $APPS_DOMAIN must be on Cloudflare; the token needs Zone:Read and DNS:Edit for it."
    ask_secret "Cloudflare API token (hidden)"
  fi
  if [ -z "$EMAIL" ] && { [ "$TLS" = auto ] || [ "$TLS" = staging ] || [ "$MODE" = bare ]; }; then
    while [ -z "$EMAIL" ]; do
      ask "E-mail for Let's Encrypt (expiry notices; a real mailbox)" ""
      EMAIL=$REPLY
    done
  fi
fi
[ -n "$MODE" ] || MODE=bare
[ -n "$TLS" ] || TLS=auto
[ "$WILDCARD" = 1 ] || WILDCARD=0
check_mode

# --- input validation (values end up in config files, so keep them to safe characters) ---------------------------
case "$TLS" in
  auto | staging | internal) ;;
  none) [ "$MODE" = docker ] || die "--tls none is for --mode docker (bare mode always runs Caddy)" ;;
  *) die "bad --tls '$TLS' (auto, staging, internal or none)" ;;
esac
[ -z "$VERSION" ] || valid_version "$VERSION" || die "bad --version '$VERSION'"
[ -z "$RT_VERSION" ] || valid_version "$RT_VERSION" || die "bad --runtime-version '$RT_VERSION'"
[ -n "$RT_VERSION" ] || RT_VERSION=$RT_PINNED_VERSION
if [ -n "$BASE_DOMAIN" ]; then
  valid_host "$BASE_DOMAIN" || die "bad --base-domain '$BASE_DOMAIN'"
  [ -n "$DOMAIN" ] || DOMAIN="console.$BASE_DOMAIN"
  [ -n "$APPS_DOMAIN" ] || APPS_DOMAIN="apps.$BASE_DOMAIN"
fi
[ -n "$DOMAIN" ] || die "--domain (or --base-domain) is required (see --help)"
valid_host "$DOMAIN" || die "bad --domain '$DOMAIN' (a fully qualified host name)"
[ -n "$APPS_DOMAIN" ] || APPS_DOMAIN="apps.$DOMAIN"
valid_host "$APPS_DOMAIN" || die "bad --apps-domain '$APPS_DOMAIN' (a fully qualified host name)"
[ "$(lower "$APPS_DOMAIN")" != "$(lower "$DOMAIN")" ] ||
  die "--apps-domain must differ from --domain: Apps must never share the console origin"
if [ -z "$EMAIL" ]; then
  case "$TLS" in
    auto | staging) die "--email is required: Let's Encrypt needs an ACME account e-mail (see --help)" ;;
  esac
  # deploy/Caddyfile always sets the ACME account e-mail.
  [ "$MODE" = docker ] || die "--email is required in bare mode (Caddy's ACME account e-mail)"
else
  printf '%s' "$EMAIL" | grep -Eq '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]+$' || die "bad --email '$EMAIL'"
  # Let's Encrypt refuses ACME accounts on reserved domains, and Caddy would only fail later, at the first certificate.
  email_domain=$(lower "${EMAIL##*@}")
  case "$email_domain" in
    example.com | example.net | example.org | *.example.com | *.example.net | *.example.org | \
      *.example | *.test | *.invalid | *.localhost | localhost | *.local)
      die "--email $EMAIL: Let's Encrypt refuses addresses at $email_domain (a reserved domain); use a real mailbox you read" ;;
  esac
fi
if [ "$WILDCARD" = 1 ]; then
  case "$TLS" in
    auto | staging) ;;
    *) die "--wildcard-cert is for --tls auto or staging (Let's Encrypt)" ;;
  esac
  [ -n "$DNS_PROVIDER" ] || DNS_PROVIDER=cloudflare
  dns_module >/dev/null || die "bad --dns-provider '$DNS_PROVIDER' (only cloudflare)"
  if [ -z "$DNS_TOKEN" ]; then
    [ -n "$DNS_TOKEN_FILE" ] || [ "$DRY_RUN" = 1 ] || die "--wildcard-cert needs --dns-token-file PATH (the $DNS_PROVIDER API token)"
    if [ -n "$DNS_TOKEN_FILE" ] && [ "$DRY_RUN" = 0 ]; then
      [ -r "$DNS_TOKEN_FILE" ] || die "--dns-token-file $DNS_TOKEN_FILE: not readable"
      DNS_TOKEN=$(tr -d '\r\n' <"$DNS_TOKEN_FILE")
    fi
  fi
  [ "$DRY_RUN" = 1 ] || printf '%s' "$DNS_TOKEN" | grep -Eq '^[A-Za-z0-9._~+/=:-]{8,}$' ||
    die "the DNS API token is empty or has unexpected characters"
  [ -z "$CADDY_SHA256" ] || printf '%s' "$CADDY_SHA256" | grep -Eq '^[0-9a-f]{64}$' || die "bad --caddy-sha256"
elif [ -n "$DNS_PROVIDER$DNS_TOKEN_FILE" ]; then
  die "--dns-provider and --dns-token-file go with --wildcard-cert"
fi
# An App at <slug>.<apps-domain> must never be the console.
case "$(lower "$DOMAIN")" in
  *".$(lower "$APPS_DOMAIN")") die "the console $DOMAIN must not be under the apps domain $APPS_DOMAIN (Apps are <app>.$APPS_DOMAIN)" ;;
esac
if [ -n "$PUBLIC_URL" ]; then
  printf '%s' "$PUBLIC_URL" | grep -Eq '^https?://[A-Za-z0-9.:-]+/?$' || die "bad --public-url '$PUBLIC_URL' (an origin: Apps are <app>.<host>)"
fi
if [ -n "$DEFAULT_PLAN" ]; then
  printf '%s' "$DEFAULT_PLAN" | grep -Eq '^[a-z0-9][a-z0-9_-]*$' || die "bad --default-plan '$DEFAULT_PLAN'"
fi
printf '%s' "$SLUG" | grep -Eq '^[a-z0-9][a-z0-9-]*$' || die "bad RTWEB_SLUG '$SLUG'"
printf '%s' "$PROJECT" | grep -Eq '^[a-z0-9][a-z0-9_-]*$' || die "bad RTWEB_COMPOSE_PROJECT '$PROJECT'"
if [ "$MODE" = docker ]; then
  [ -z "$TARBALL" ] || die "--tarball is for --mode bare (docker mode runs an image; see --image)"
  if [ -z "$HTTP_PORT" ]; then
    if [ "$TLS" = none ]; then HTTP_PORT=8080; else HTTP_PORT=80; fi
  fi
  [ -n "$HTTPS_PORT" ] || HTTPS_PORT=443
  valid_port "$HTTP_PORT" || die "bad --http-port '$HTTP_PORT'"
  valid_port "$HTTPS_PORT" || die "bad --https-port '$HTTPS_PORT'"
  [ -n "$SUBNET" ] || SUBNET=172.31.221.0/24
  printf '%s' "$SUBNET" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}$' || die "bad --docker-subnet '$SUBNET'"
  if [ -n "$IMAGE" ]; then
    printf '%s' "$IMAGE" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._/:@-]*$' || die "bad --image '$IMAGE'"
    [ "$SKIP_SIG" = 1 ] || die "--image is not signature-checked: pass --insecure-skip-signature to run it anyway"
  fi
else
  [ -z "$IMAGE" ] || die "--image is for --mode docker"
  [ -z "$HTTP_PORT$HTTPS_PORT" ] || die "--http-port/--https-port are for --mode docker (bare mode: Caddy on 80/443)"
  HTTP_PORT=80
  HTTPS_PORT=443
fi
if [ -n "$TARBALL" ]; then
  tb=$(basename "$TARBALL")
  tv=${tb#runtime-web-}
  tv=${tv%.tar.gz}
  { [ "$tb" = "runtime-web-$tv.tar.gz" ] && valid_version "$tv"; } || die "--tarball must be named runtime-web-X.Y.Z.tar.gz (got $tb)"
  [ -z "$VERSION" ] || [ "$VERSION" = "$tv" ] || die "--version $VERSION does not match --tarball $tb"
  VERSION=$tv
  [ -f "$TARBALL" ] || [ "$DRY_RUN" = 1 ] || die "--tarball $TARBALL: no such file"
  [ -z "$TARBALL_SHA256" ] || printf '%s' "$TARBALL_SHA256" | grep -Eq '^[0-9a-f]{64}$' || die "bad --sha256 (64 hex chars)"
  [ -n "$TARBALL_SHA256" ] || [ "$SKIP_SIG" = 1 ] ||
    die "--tarball is not signature-checked: pass --sha256 HEX or --insecure-skip-signature to install it anyway"
fi
[ -n "$PUBLIC_URL" ] || PUBLIC_URL="https://$APPS_DOMAIN"
# Fail closed: App code served on the console origin could call /api with an admin's cookies.
lc_domain=$(lower "$DOMAIN")
case "$(lower "$PUBLIC_URL")" in
  "https://$lc_domain" | "https://$lc_domain/"* | "https://$lc_domain:443" | "https://$lc_domain:443/"*)
    die "--public-url must not be the console origin https://$DOMAIN (Apps need their own origin)" ;;
esac

CONSOLE_URL="https://$DOMAIN"
APPS_URL="https://$APPS_DOMAIN"
if [ "$MODE" = docker ] && [ "$TLS" != none ] && [ "$HTTPS_PORT" != 443 ]; then
  CONSOLE_URL="https://$DOMAIN:$HTTPS_PORT"
  APPS_URL="https://$APPS_DOMAIN:$HTTPS_PORT"
fi

# --- summary and the last chance to stop ---------------------------------------------------------------------------
section "Plan"
kv "Mode" "$MODE"
kv "Console" "$CONSOLE_URL"
kv "Apps" "$(app_url_pattern)"
kv "Certificates" "$(tls_label)"
[ "$WILDCARD" = 0 ] || kv "Apps cert" "one wildcard certificate *.$APPS_DOMAIN (DNS-01 with $DNS_PROVIDER)"
[ -z "$EMAIL" ] || kv "ACME e-mail" "$EMAIL"
if [ -n "$IMAGE" ]; then kv "Image" "$IMAGE"; else kv "Version" "${VERSION:-latest}"; fi
[ "$MODE" = bare ] || kv "Files" "$DOCKER_DIR (compose project $PROJECT)"
[ "$DRY_RUN" = 0 ] || kv "Dry run" "nothing on this host is changed"
if [ -n "$TTY" ]; then
  confirm "Install now?" y || die "stopped; nothing was changed"
fi

platform_checks

umask 077

# Environment file of the rt unit (holds RT_ROOT_TOKEN and the rtweb binding secrets).
RT_ENV=/etc/default/rt
[ -d /etc/sysconfig ] && [ ! -d /etc/default ] && RT_ENV=/etc/sysconfig/rt

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

section "Preflight"
dependencies
check_dns
check_ports

if [ "$MODE" = docker ]; then install_docker; else install_bare; fi
finish
}

# ===================================================================================================================
# helpers (defined before main runs; they read main's variables at call time)

# --- output --------------------------------------------------------------------------------------------------------
init_ui() {
  B="" D="" R="" G="" Y="" C="" N=""
  if [ -t 2 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != dumb ]; then
    esc=$(printf '\033')
    B="${esc}[1m" D="${esc}[2m" R="${esc}[31m" G="${esc}[32m" Y="${esc}[33m" C="${esc}[36m" N="${esc}[0m"
  fi
}
say() { printf '%s\n' "$*" >&2; }
step() { printf '  %s-%s %s\n' "$D" "$N" "$*" >&2; }
ok() { printf '  %sok%s %s\n' "$G" "$N" "$*" >&2; }
warn() { printf '  %swarning:%s %s\n' "$Y" "$N" "$*" >&2; }
die() {
  printf '%serror:%s %s\n' "${R:-}" "${N:-}" "$*" >&2
  exit 1
}
section() { printf '\n%s%s==>%s %s%s%s\n' "$C" "$B" "$N" "$B" "$*" "$N" >&2; }
kv() { printf '  %-14s %s\n' "$1" "$2" >&2; }
banner() {
  printf '\n%sRuntime Web installer%s %s(21 Cloud console)%s\n' "$B" "$N" "$D" "$N" >&2
}

# --- prompts: from the terminal, also under `curl | sh` (stdin is the script there) ---------------------------------
init_tty() {
  TTY=""
  [ "$ASSUME_YES" = 0 ] || return 0
  if [ -t 0 ]; then
    TTY=/dev/stdin
  elif (: </dev/tty) 2>/dev/null; then
    TTY=/dev/tty
  fi
}
# ask PROMPT DEFAULT -> REPLY
ask() {
  printf '%s?%s %s%s: ' "$C" "$N" "$1" "${2:+ ${D}[$2]$N}" >&2
  IFS= read -r REPLY <"$TTY" || die "no answer (the terminal closed); run again, or use --yes with flags"
  [ -n "$REPLY" ] || REPLY=$2
}
# choose PROMPT DEFAULT_INDEX "a b c" -> REPLY (the word, by number or name)
choose() {
  while :; do
    ask "$1" "$2"
    i=0
    for w in $3; do
      i=$((i + 1))
      if [ "$REPLY" = "$i" ] || [ "$REPLY" = "$w" ]; then REPLY=$w; return 0; fi
    done
    warn "pick one of: $3"
  done
}
# confirm PROMPT y|n: 0 for yes. Without a terminal it answers the default.
confirm() {
  if [ -z "$TTY" ]; then [ "$2" = y ]; return; fi
  if [ "$2" = y ]; then hint="Y/n"; else hint="y/N"; fi
  while :; do
    printf '%s?%s %s %s[%s]%s ' "$C" "$N" "$1" "$D" "$hint" "$N" >&2
    IFS= read -r a <"$TTY" || die "no answer (the terminal closed); run again, or use --yes with flags"
    case "$(lower "$a")" in
      y | yes) return 0 ;;
      n | no) return 1 ;;
      "") [ "$2" = y ]; return ;;
    esac
  done
}

# ask_secret PROMPT -> DNS_TOKEN, read without echo.
ask_secret() {
  while [ -z "$DNS_TOKEN" ]; do
    printf '%s?%s %s: ' "$C" "$N" "$1" >&2
    stty -echo <"$TTY" 2>/dev/null || true
    IFS= read -r DNS_TOKEN <"$TTY" || { stty echo <"$TTY" 2>/dev/null; die "no answer (the terminal closed)"; }
    stty echo <"$TTY" 2>/dev/null || true
    printf '\n' >&2
  done
}

# DNS provider for the wildcard certificate: Cloudflare only (its caddy-dns module, pinned).
dns_module() {
  case "$DNS_PROVIDER" in
    cloudflare) echo github.com/caddy-dns/cloudflare@v0.2.4 ;;
    *) return 1 ;;
  esac
}
# dns_directive TOKEN_PLACEHOLDER: the `tls` subdirective for the provider.
dns_directive() { printf 'dns %s %s' "$DNS_PROVIDER" "$1"; }

# mask_token: stdin to stdout with the DNS API token replaced (Caddy quotes a token it rejects).
mask_token() {
  if [ -n "$DNS_TOKEN" ]; then
    T="$DNS_TOKEN" awk '{ while ((i = index($0, ENVIRON["T"])) > 0) $0 = substr($0, 1, i - 1) "<dns token>" substr($0, i + length(ENVIRON["T"])); print }'
  else
    cat
  fi
}

need_arg() { [ "$#" -ge 2 ] || die "$1 needs a value (see --help)"; }
have() { command -v "$1" >/dev/null 2>&1; }
need() { have "$1" || die "this installer needs '$1' on PATH"; }
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# run CMD...: execute, or print in --dry-run. Never pass secrets as arguments (they would be printed here).
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '  %s[dry-run]%s %s\n' "$D" "$N" "$*" >&2
  else
    "$@"
  fi
}

usage() {
  cat <<'EOF'
usage: install.sh [--mode bare|docker] [--domain HOST] [--apps-domain HOST] [--email ADDR]
                  [--tls auto|staging|internal|none] [--version X.Y.Z] [--yes] [--dry-run] [--skip-dns-check]
         bare:    [--public-url URL] [--default-plan NAME] [--runtime-version X.Y.Z] [--tarball PATH [--sha256 HEX]]
         docker:  [--image REF] [--install-docker] [--http-port N] [--https-port N] [--docker-subnet CIDR]
                  [--insecure-skip-signature]
       install.sh --uninstall [--mode bare|docker] [--purge] [--dry-run]

Installs Runtime Web, the 21 Cloud console, with HTTPS from Let's Encrypt: as a systemd service with Caddy on the
host (bare) or as containers with docker compose (docker). With a terminal it asks for what is missing; with --yes
or without a terminal it never asks. Release signatures are verified with cosign (Sigstore).
EOF
}

valid_version() { printf '%s' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; }
valid_secret() { printf '%s' "$1" | grep -Eq '^[0-9a-f]{64}$'; }
valid_host() {
  printf '%s' "$1" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$'
}
valid_port() { printf '%s' "$1" | grep -Eq '^[0-9]{1,5}$' && [ "$1" -ge 1 ] && [ "$1" -le 65535 ]; }

check_mode() {
  case "$MODE" in
    bare | docker) ;;
    *) die "bad --mode '$MODE' (bare or docker)" ;;
  esac
}

app_url_pattern() {
  if [ "$TLS" = none ] || [ "$HTTPS_PORT" = 443 ]; then
    printf 'https://<app>.%s/' "$APPS_DOMAIN"
  else
    printf 'https://<app>.%s:%s/' "$APPS_DOMAIN" "$HTTPS_PORT"
  fi
}

tls_label() {
  case "$TLS" in
    auto) printf "Let's Encrypt (automatic)" ;;
    staging) printf "Let's Encrypt staging (untrusted, for tests)" ;;
    internal) printf "Caddy internal CA (untrusted, for tests)" ;;
    none) printf "none: your own TLS proxy in front of 127.0.0.1:%s" "$HTTP_PORT" ;;
  esac
}

# caddy_tls_option: the one global Caddy option for --tls (RTWEB_CADDY_TLS in deploy/Caddyfile).
caddy_tls_option() {
  case "$TLS" in
    staging) printf 'acme_ca %s' "$LE_STAGING" ;;
    internal) printf 'local_certs' ;;
  esac
}

# random_hex N: N random bytes as hex, from the kernel CSPRNG.
random_hex() {
  if have openssl; then
    openssl rand -hex "$1"
  else
    od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'
  fi
}

platform_checks() {
  os=$(uname -s)
  arch=$(uname -m)
  if [ "$(id -u)" -ne 0 ]; then
    if [ "$DRY_RUN" = 1 ]; then warn "not root (a real install must run as root)"; else die "run as root (sudo sh install.sh ...)"; fi
  fi
  case "$os" in
    Linux) ;;
    *)
      if [ "$DRY_RUN" = 1 ]; then warn "$os is not supported (Linux only); continuing the dry run"; else die "Linux only (got $os)"; fi
      ;;
  esac
  case "$arch" in
    x86_64 | amd64) arch=x86_64 ;;
    aarch64 | arm64) arch=aarch64 ;;
    *) die "unsupported architecture $arch (x86_64 or aarch64)" ;;
  esac
}

dependencies() {
  need awk
  need sed
  if [ "$DRY_RUN" = 0 ] || have curl; then need curl; fi
  if have sha256sum; then
    sha256() { sha256sum "$1" | awk '{print $1}'; }
  elif have shasum; then
    sha256() { shasum -a 256 "$1" | awk '{print $1}'; }
  else
    die "this installer needs sha256sum or shasum to verify downloads"
  fi
  HAVE_COSIGN=0
  have cosign && HAVE_COSIGN=1
  if [ "$MODE" = docker ]; then
    ensure_docker
    if [ "$HAVE_COSIGN" = 0 ] && [ "$SKIP_SIG" = 0 ]; then
      if [ "$DRY_RUN" = 1 ]; then
        warn "cosign not found (a real install refuses to run without it, unless --insecure-skip-signature)"
      else
        die "cosign is required to verify the image signature (https://docs.sigstore.dev/cosign/system_config/installation/); pass --insecure-skip-signature to run the image unverified"
      fi
    fi
    ok "docker: $(docker_version)"
    return 0
  fi
  need tar
  if have node; then
    nv=$(node -p 'process.versions.node' 2>/dev/null || echo 0.0.0)
    major=${nv%%.*}
    rest=${nv#*.}
    minor=${rest%%.*}
    if [ "$major" -lt "$NODE_MIN_MAJOR" ] || { [ "$major" -eq "$NODE_MIN_MAJOR" ] && [ "$minor" -lt "$NODE_MIN_MINOR" ]; }; then
      die "node $nv is too old: need >= $NODE_MIN_MAJOR.$NODE_MIN_MINOR (install it from your distribution or nodejs.org)"
    fi
    ok "node $nv"
  elif [ "$DRY_RUN" = 1 ]; then
    warn "node not found (a real install needs node >= $NODE_MIN_MAJOR.$NODE_MIN_MINOR)"
  else
    die "node >= $NODE_MIN_MAJOR.$NODE_MIN_MINOR is required to run install.mjs (distribution package or nodejs.org)"
  fi
  if have caddy; then
    ok "caddy $(caddy version 2>/dev/null | awk '{print $1}')"
  else
    warn "caddy not found: the console will not be reachable over HTTPS until you install it (apt/dnf install caddy, or caddyserver.com packages) and re-run"
  fi
  if [ "$HAVE_COSIGN" = 0 ] && [ "$SKIP_SIG" = 0 ] && [ -z "$TARBALL" ]; then
    if [ "$DRY_RUN" = 1 ]; then
      warn "cosign not found (a real install refuses to run without it, unless --insecure-skip-signature)"
    else
      die "cosign is required to verify the release signature (https://docs.sigstore.dev/cosign/system_config/installation/); pass --insecure-skip-signature to install on checksums alone"
    fi
  fi
}

docker_version() { docker version --format '{{.Server.Version}}' 2>/dev/null || echo unknown; }

# ensure_docker: Docker Engine and the compose plugin; installs Docker only with consent.
ensure_docker() {
  if ! have docker; then
    if [ "$DRY_RUN" = 1 ]; then
      warn "docker not found (a real install asks before installing it, or needs --install-docker)"
      return 0
    fi
    if [ "$INSTALL_DOCKER" = 1 ] || confirm "Docker is not installed. Install Docker Engine now with Docker's official script (get.docker.com)?" n; then
      section "Docker"
      fetch https://get.docker.com "$tmp/get-docker.sh"
      sh "$tmp/get-docker.sh" >"$tmp/get-docker.log" 2>&1 || {
        sed 's/^/    /' "$tmp/get-docker.log" >&2
        die "the Docker install script failed"
      }
      have systemctl && systemctl enable --now docker >/dev/null 2>&1 || true
      ok "installed Docker $(docker_version)"
    else
      die "docker mode needs Docker Engine with the compose plugin: install it (https://docs.docker.com/engine/install/) or re-run with --install-docker"
    fi
  fi
  [ "$DRY_RUN" = 1 ] && return 0
  docker info >/dev/null 2>&1 || die "the Docker daemon is not reachable (systemctl start docker?)"
  docker compose version >/dev/null 2>&1 || die "docker compose (v2 plugin) is missing: install docker-compose-plugin"
}

# --- downloads and verification ------------------------------------------------------------------------------------
latest() { # latest OWNER/REPO -> X.Y.Z (GITHUB_TOKEN goes in a 0600 header file, never on curl's argv)
  hdr="$tmp/gh-auth.hdr"
  : >"$hdr"
  [ -n "${GITHUB_TOKEN:-}" ] && printf 'Authorization: Bearer %s\n' "$GITHUB_TOKEN" >"$hdr"
  v=$(curl --proto '=https' --tlsv1.2 -fsSL -H @"$hdr" "https://api.github.com/repos/$1/releases/latest" |
    sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -n1)
  rm -f "$hdr"
  valid_version "$v" || die "could not find the latest release of $1 (pass --version)"
  printf '%s' "$v"
}

# fetch URL FILE: download over https only, retries, fail on HTTP errors.
fetch() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '  %s[dry-run]%s curl %s -> %s\n' "$D" "$N" "$1" "$2" >&2
    return 0
  fi
  curl --proto '=https' --tlsv1.2 -fsSL --retry 3 -o "$2" "$1"
}

# verify_sums SUMS IDENTITY_REGEXP: cosign keyless check of SUMS against SUMS.sigstore.json.
verify_sums() {
  run cosign verify-blob --bundle "$1.sigstore.json" \
    --certificate-identity-regexp "$2" --certificate-oidc-issuer "$CERT_OIDC_ISSUER" "$1" >/dev/null
}

# check_sum SUMS FILE NAME: FILE must hash to NAME's entry in SUMS.
check_sum() {
  if [ "$DRY_RUN" = 1 ]; then
    step "would verify sha256($3) against SHA256SUMS"
    return 0
  fi
  want=$(awk -v f="$3" '$2 == f || $2 == "*"f {print $1}' "$1")
  [ -n "$want" ] || die "$3 is not listed in SHA256SUMS"
  got=$(sha256 "$2")
  [ "$want" = "$got" ] || die "checksum mismatch for $3: refusing to install"
  ok "checksum $3"
}

# --- DNS and ports -------------------------------------------------------------------------------------------------
# host_addresses: this host's addresses, local interfaces plus the public ones (NAT, cloud floating IPs).
host_addresses() {
  if have ip; then
    ip -o addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1
  elif have hostname; then
    hostname -I 2>/dev/null | tr ' ' '\n'
  fi
  curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null && echo
  curl -6 -fsS --max-time 5 https://api6.ipify.org 2>/dev/null && echo
  return 0
}

resolve() { getent ahosts "$1" 2>/dev/null | awk '{print $1}' | sort -u; }

check_dns() {
  if [ "$SKIP_DNS" = 1 ] || [ "$TLS" = none ]; then
    step "DNS check skipped"
    return 0
  fi
  if [ "$DRY_RUN" = 1 ]; then
    step "would check that $DOMAIN and $APPS_DOMAIN resolve (A/AAAA) to this host"
    return 0
  fi
  have getent || { warn "getent not found: DNS check skipped"; return 0; }
  mine=$(host_addresses | grep -v '^$' | sort -u)
  bad=0
  hosts="$DOMAIN $APPS_DOMAIN"
  # A random label proves the wildcard record (*.apps) rather than one App's own record.
  hosts="$hosts rtw-check-$(random_hex 4).$APPS_DOMAIN"
  for h in $hosts; do
    ips=$(resolve "$h")
    if [ -z "$ips" ]; then
      warn "$h has no A/AAAA record yet"
      bad=1
      continue
    fi
    match=0
    for a in $ips; do
      printf '%s\n' "$mine" | grep -qxF "$a" && match=1
    done
    if [ "$match" = 1 ]; then
      ok "DNS $h -> $(printf '%s' "$ips" | tr '\n' ' ')"
    else
      warn "$h points at $(printf '%s' "$ips" | tr '\n' ' ')but this host is $(printf '%s' "$mine" | grep -v -e '^127\.' -e '^::1$' -e '^fe80' | tr '\n' ' ')"
      bad=1
    fi
  done
  [ "$bad" = 0 ] && return 0
  case "$TLS" in
    auto | staging) say "    Let's Encrypt validates over HTTP: certificates fail until the names point at this host." ;;
  esac
  say "    Add A and/or AAAA records for $DOMAIN, $APPS_DOMAIN and *.$APPS_DOMAIN, or continue and fix DNS later."
  if [ -n "$TTY" ]; then
    confirm "Continue anyway?" n || die "stopped; nothing was changed. Fix DNS, then run the installer again"
  else
    warn "continuing without a terminal; Caddy retries certificate issuance once DNS is right"
  fi
}

# port_owner PORT: the listening socket on PORT (with its process when known), or nothing.
port_owner() {
  if have ss; then
    ss -Hltnp "sport = :$1" 2>/dev/null | head -n1
  elif have netstat; then
    netstat -ltnp 2>/dev/null | awk -v p=":$1" '$4 ~ p"$" {print; exit}'
  fi
}

check_ports() {
  [ "$TLS" = none ] && return 0
  if [ "$DRY_RUN" = 1 ]; then
    step "would check that ports $HTTP_PORT and $HTTPS_PORT are free (or already ours)"
    return 0
  fi
  have ss || have netstat || { warn "neither ss nor netstat found: port check skipped"; return 0; }
  ours_running=0
  if [ "$MODE" = docker ] && [ -f "$DOCKER_DIR/compose.yaml" ] &&
    [ -n "$(compose ps -q --status running caddy 2>/dev/null)" ]; then
    ours_running=1
  fi
  busy=0
  for p in "$HTTP_PORT" "$HTTPS_PORT"; do
    o=$(port_owner "$p")
    [ -n "$o" ] || { ok "port $p is free"; continue; }
    case "$MODE:$o" in
      bare:*'"caddy'*) ok "port $p: Caddy (will be reconfigured)"; continue ;;
      docker:*docker-proxy*) [ "$ours_running" = 0 ] || { ok "port $p: this install's Caddy container"; continue; } ;;
    esac
    warn "port $p is in use: $(printf '%s' "$o" | awk '{print $4, $6}')"
    busy=1
  done
  [ "$busy" = 0 ] && return 0
  say "    Caddy needs ports $HTTP_PORT and $HTTPS_PORT for HTTPS and the Let's Encrypt challenges."
  if [ -n "$TTY" ]; then
    confirm "Continue anyway?" n || die "stopped; nothing was changed. Free the ports, then run the installer again"
  else
    warn "continuing without a terminal; Caddy cannot start until the ports are free"
  fi
}

# ===================================================================================================================
# bare mode
install_bare() {
  section "Runtime Web release"
  if [ -z "$VERSION" ]; then
    if [ "$DRY_RUN" = 1 ]; then VERSION=latest; else VERSION=$(latest "$REPO"); fi
  fi
  tarball="runtime-web-$VERSION.tar.gz"
  step "Runtime Web $VERSION"
  if [ -n "$TARBALL" ]; then
    warn "--tarball $TARBALL: a local file, not a signed release"
    run cp "$TARBALL" "$tmp/$tarball"
    if [ -n "$TARBALL_SHA256" ]; then
      printf '%s  %s\n' "$TARBALL_SHA256" "$tarball" >"$tmp/SHA256SUMS"
      check_sum "$tmp/SHA256SUMS" "$tmp/$tarball" "$tarball"
    fi
  else
    fetch "$BASE_URL/v$VERSION/SHA256SUMS" "$tmp/SHA256SUMS"
    fetch "$BASE_URL/v$VERSION/$tarball" "$tmp/$tarball"
    if [ "$HAVE_COSIGN" = 1 ] || [ "$DRY_RUN" = 1 ]; then
      fetch "$BASE_URL/v$VERSION/SHA256SUMS.sigstore.json" "$tmp/SHA256SUMS.sigstore.json"
      verify_sums "$tmp/SHA256SUMS" "$CERT_IDENTITY_REGEXP" || die "cosign could not verify SHA256SUMS: refusing to install"
      [ "$DRY_RUN" = 1 ] || ok "SHA256SUMS signature (Sigstore, $REPO release workflow identity)"
    else
      warn "--insecure-skip-signature: SHA256SUMS is NOT signature-checked; it only detects corruption"
    fi
    check_sum "$tmp/SHA256SUMS" "$tmp/$tarball" "$tarball"
  fi

  dest="$PREFIX/$VERSION"
  run install -d -m 0755 "$PREFIX"
  run rm -rf "$dest.new"
  run install -d -m 0755 "$dest.new"
  run tar -xzf "$tmp/$tarball" -C "$dest.new" --strip-components=1 --no-same-owner
  run rm -rf "$dest"
  run mv "$dest.new" "$dest"
  run ln -sfn "$dest" "$PREFIX/current"
  APP="$PREFIX/current"

  section "Runtime node (rt)"
  if have rt; then
    ok "found $(rt --version 2>/dev/null || echo rt)"
  else
    install_rt
  fi

  if [ "$DRY_RUN" = 1 ]; then
    step "would ensure $RT_ENV (0600) holds RT_ROOT_TOKEN (generated if absent)"
  elif [ ! -f "$RT_ENV" ] || ! grep -Eq '^RT_ROOT_TOKEN(_FILE)?=' "$RT_ENV"; then
    touch "$RT_ENV"
    chmod 0600 "$RT_ENV"
    printf 'RT_ROOT_TOKEN=%s\n' "$(random_hex 32)" >>"$RT_ENV"
    ok "generated a root token in $RT_ENV (0600; not printed)"
  fi
  master_key_credential

  # --- secrets (0600, root only, never printed) --------------------------------------------------------------------
  run install -d -m 0700 "$ETC"
  if [ "$DRY_RUN" = 1 ]; then
    step "would create $ETC/rtweb.env (0600) with RTWEB_RELAY_SECRET (32 random bytes)"
  else
    relay=$(read_env RTWEB_RELAY_SECRET "$ETC/rtweb.env")
    if ! valid_secret "$relay"; then
      relay=$(random_hex 32)
      valid_secret "$relay" || die "could not generate RTWEB_RELAY_SECRET"
      printf 'RTWEB_RELAY_SECRET=%s\n' "$relay" >"$ETC/rtweb.env"
      chmod 0600 "$ETC/rtweb.env"
      ok "generated $ETC/rtweb.env (0600)"
    fi
    if [ -n "$DNS_TOKEN" ]; then
      # Caddy gets it as a systemd credential (LoadCredential), not through its environment.
      (umask 077 && printf '%s' "$DNS_TOKEN" >"$ETC/dns-token")
      chmod 0600 "$ETC/dns-token"
      ok "stored the $DNS_PROVIDER API token in $ETC/dns-token (0600; not printed)"
    fi
    # Older installs kept a random, never-registered RTWEB_OP_TOKEN here; the op token is now derived below.
    drop_env_keys "$ETC/rtweb.env" RTWEB_OP_TOKEN
  fi

  # --- runtime node config: rtweb plan + bindings, trusted proxy, secrets in the rt environment --------------------
  if [ "$DRY_RUN" = 1 ]; then
    step "would put $APP/deploy/rt.rtweb.toml into $RT_TOML between runtime-web markers (backup $RT_TOML.pre-rtweb)"
    step "would ensure [ingress] trusted_proxies = [\"127.0.0.1/32\", \"::1/128\"] in $RT_TOML (Caddy on loopback)"
    step "would set RTWEB_OP_TOKEN=\"Bearer <root token>\" and RTWEB_RELAY_SECRET in $RT_ENV and restart rt"
  else
    [ -f "$RT_TOML" ] && [ ! -f "$RT_TOML.pre-rtweb" ] && cp -p "$RT_TOML" "$RT_TOML.pre-rtweb"
    [ -f "$RT_TOML" ] && strip_block "$RT_TOML"
    { printf '\n%s\n' "$BLOCK_BEGIN"; cat "$APP/deploy/rt.rtweb.toml"; printf '%s\n' "$BLOCK_END"; } >>"$RT_TOML"
    chmod 0644 "$RT_TOML"
    ok "rtweb plan and bindings in $RT_TOML"
    ensure_trusted_proxies "$RT_TOML"
    set_base_domain "$RT_TOML" "$APPS_DOMAIN"
    # The runtime has one operator credential, the root token; inject_headers sends the value verbatim.
    op="Bearer $(root_token)"
    set_env_key "$RT_ENV" RTWEB_OP_TOKEN "\"$op\""
    set_env_key "$RT_ENV" RTWEB_RELAY_SECRET "$relay"
    unset op
    chmod 0600 "$RT_ENV"
  fi
  if have systemctl; then
    run systemctl daemon-reload
    run systemctl enable --quiet rt
    run systemctl restart rt
  fi
  if [ "$DRY_RUN" = 0 ]; then
    wait_for "rt to become ready" 60 curl -fsS http://127.0.0.1:9090/readyz || die "rt did not become ready (journalctl -u rt)"
    ok "rt is ready"
  fi

  # --- Caddy: relay + console host + on-demand TLS restricted by the ask endpoint ----------------------------------
  section "Caddy (HTTPS)"
  CADDY_BIN=caddy
  [ "$WILDCARD" = 0 ] || install_caddy_dns
  if have caddy; then
    run install -d -m 0755 /etc/caddy/Caddyfile.d
    run install -m 0644 "$APP/deploy/Caddyfile" "$CADDY_SITE"
    run rm -f "$CADDY_WILDCARD_SITE"
    caddy_tls=$(caddy_tls_option)
    apps_tls=$(apps_tls_option run)
    if [ "$DRY_RUN" = 1 ]; then
      step "would write $ETC/caddy.env (0600: RTWEB_DOMAIN=$DOMAIN, RTWEB_APPS_DOMAIN=$APPS_DOMAIN, RTWEB_ACME_EMAIL, RTWEB_SLUG=$SLUG, RTWEB_CADDY_TLS=$caddy_tls, RTWEB_APPS_TLS=$apps_tls, RTWEB_RELAY_SECRET) for caddy and import $CADDY_SITE"
    else
      caddy_import "$CADDY_MAIN"
      # deploy/Caddyfile reads these; systemd loads the 0600 file as root before dropping to the caddy user.
      printf 'RTWEB_DOMAIN=%s\nRTWEB_APPS_DOMAIN=%s\nRTWEB_ACME_EMAIL=%s\nRTWEB_SLUG=%s\nRTWEB_CADDY_TLS=%s\nRTWEB_APPS_TLS=%s\nRTWEB_RELAY_SECRET=%s\n' \
        "$DOMAIN" "$APPS_DOMAIN" "$EMAIL" "$SLUG" "$caddy_tls" "$apps_tls" "$relay" >"$ETC/caddy.env"
      chmod 0600 "$ETC/caddy.env"
      install -d -m 0755 /etc/systemd/system/caddy.service.d
      caddy_dropin >"$CADDY_DROPIN"
      chmod 0644 "$CADDY_DROPIN"
      # Validate with the same environment Caddy will run with; a broken site must not be (re)started.
      validate_apps_tls=$(apps_tls_option validate)
      (
        export RTWEB_DOMAIN="$DOMAIN" RTWEB_APPS_DOMAIN="$APPS_DOMAIN" RTWEB_ACME_EMAIL="$EMAIL" RTWEB_SLUG="$SLUG" \
          RTWEB_CADDY_TLS="$caddy_tls" RTWEB_APPS_TLS="$validate_apps_tls" RTWEB_RELAY_SECRET="$relay"
        "$CADDY_BIN" validate --config /etc/caddy/Caddyfile --adapter caddyfile >"$tmp/caddy-validate.log" 2>&1
      ) || {
        mask_token <"$tmp/caddy-validate.log" | sed 's/^/    /' >&2
        die "caddy validate failed for $CADDY_SITE: Caddy was not restarted"
      }
      ok "site $CADDY_SITE validated"
    fi
    if have systemctl; then
      run systemctl daemon-reload
      run systemctl enable --quiet caddy
      run systemctl restart caddy
    fi
  else
    warn "caddy not found: install it from your distribution (apt/dnf install caddy, or caddyserver.com packages),"
    warn "then re-run this script; the site file is $APP/deploy/Caddyfile"
  fi
  unset relay

  # --- deploy the rtweb service (install.mjs is idempotent) --------------------------------------------------------
  section "Console service"
  if [ "$DRY_RUN" = 1 ]; then
    step "would run: node $APP/server/scripts/install.mjs (RT_ROOT_TOKEN from $RT_ENV via the environment, RTWEB_ORIGIN=https://$DOMAIN, RTWEB_HOST=$DOMAIN, RTWEB_APPS_URL=$PUBLIC_URL${DEFAULT_PLAN:+, RTWEB_DEFAULT_PLAN=$DEFAULT_PLAN})"
    return 0
  fi
  # The token goes through the environment of one child process only: never argv, never the terminal. The output
  # goes to a 0600 file in the private temp dir so the setup token can be shown once, in the summary.
  if (
    RT_ROOT_TOKEN=$(root_token)
    export RT_ROOT_TOKEN
    RTWEB_SLUG="$SLUG" RTWEB_ORIGIN="https://$DOMAIN" RTWEB_HOST="$DOMAIN" RTWEB_APPS_URL="$PUBLIC_URL" \
      RTWEB_DEFAULT_PLAN="$DEFAULT_PLAN" RTWEB_VERSION="$VERSION" \
      node "$APP/server/scripts/install.mjs"
  ) >"$tmp/install.log" 2>&1; then
    grep -v 'Setup token' "$tmp/install.log" | sed 's/^/    /' >&2
    SETUP_TOKEN=$(sed -n 's/^Setup token (shown once): //p' "$tmp/install.log" | tail -n1)
  else
    sed 's/^/    /' "$tmp/install.log" >&2
    die "install.mjs failed (re-run is safe: it is idempotent)"
  fi
  rm -f "$tmp/install.log"

  wait_for "the console" 60 curl -fsS -H "Host: $DOMAIN" http://127.0.0.1:8080/api/healthz || die "the console does not answer on the node (journalctl -u rt)"
  ok "console answers on the node"
}

# master_key_credential: a NEW node gets its master key as a systemd credential (LoadCredential), so the key is in
# a root-only file and in rt's private credentials directory, never in its environment. An existing key (in the
# environment file, the data dir or a credential already) is never moved: that would change which key opens the
# sealed secrets.
master_key_credential() {
  if [ "$DRY_RUN" = 1 ]; then
    step "would give a new node its master key as a systemd credential ($RT_CRED_DIR/rt-master-key, LoadCredential)"
    return 0
  fi
  [ -f "$RT_CRED_DROPIN" ] && { ok "master key: $RT_CRED_DIR/rt-master-key ($RT_CRED_DROPIN)"; return 0; }
  if grep -Eq '^RT_MASTER_KEY(_FILE)?=' "$RT_ENV" 2>/dev/null || [ -f /var/lib/rt/master.key ] ||
    grep -Eq '^[[:space:]]*master_key_file[[:space:]]*=[[:space:]]*"[^"]' "$RT_TOML" 2>/dev/null; then
    step "master key: kept where it is (see docs/design/data-protection.md to move it to a systemd credential)"
    return 0
  fi
  sdv=$(systemctl --version 2>/dev/null | awk 'NR==1 {print $2}')
  case "$sdv" in
    '' | *[!0-9]*) step "master key: rt generates /var/lib/rt/master.key (no systemd)"; return 0 ;;
  esac
  if [ "$sdv" -lt 250 ]; then
    step "master key: rt generates /var/lib/rt/master.key (systemd $sdv < 250 has no %d credentials path)"
    return 0
  fi
  install -d -m 0700 "$RT_CRED_DIR"
  random_hex 32 >"$RT_CRED_DIR/rt-master-key"
  chmod 0600 "$RT_CRED_DIR/rt-master-key"
  install -d -m 0755 "$(dirname "$RT_CRED_DROPIN")"
  # Some hosts (containers, old kernels) cannot mount a unit's credentials directory: probe it first. The fallback
  # still keeps the key out of the environment: a root:rt 0640 file read through RT_MASTER_KEY_FILE.
  if systemd_creds_ok "$RT_CRED_DIR/rt-master-key"; then
    printf '%s\n' '# runtime-web install.sh: the master key as a credential, not an environment variable.' \
      '[Service]' "LoadCredential=rt-master-key:$RT_CRED_DIR/rt-master-key" \
      'Environment=RT_MASTER_KEY_FILE=%d/rt-master-key' >"$RT_CRED_DROPIN"
    ok "master key: new systemd credential $RT_CRED_DIR/rt-master-key (0600; back it up, apart from the data)"
  else
    chmod 0711 "$RT_CRED_DIR"
    chgrp rt "$RT_CRED_DIR/rt-master-key"
    chmod 0640 "$RT_CRED_DIR/rt-master-key"
    printf '%s\n' '# runtime-web install.sh: the master key in a file, not an environment variable (no credentials here).' \
      '[Service]' "Environment=RT_MASTER_KEY_FILE=$RT_CRED_DIR/rt-master-key" >"$RT_CRED_DROPIN"
    ok "master key: new file $RT_CRED_DIR/rt-master-key (root:rt 0640; this host cannot mount systemd credentials)"
  fi
  chmod 0644 "$RT_CRED_DROPIN"
}

# install_rt: the rt binary from its GitHub release tarball, the production rt.toml from the same tarball, and the
# unit from this (already verified) Runtime Web release. Never runs a script downloaded from the runtime repository.
install_rt() {
  target="$arch-unknown-linux-gnu"
  name="rt-$RT_VERSION-$target"
  url="$RT_BASE_URL/v$RT_VERSION"
  step "installing rt $RT_VERSION ($target) from $RT_REPO release assets"
  mkdir -p "$tmp/rt"
  fetch "$url/SHA256SUMS" "$tmp/rt/SHA256SUMS"
  fetch "$url/$name.tar.gz" "$tmp/rt/$name.tar.gz"
  if [ "$RT_VERSION" = "$RT_PINNED_VERSION" ]; then
    if [ "$DRY_RUN" = 1 ]; then
      step "would check sha256(SHA256SUMS) == pinned $RT_PINNED_SUMS_SHA256"
    else
      [ "$(sha256 "$tmp/rt/SHA256SUMS")" = "$RT_PINNED_SUMS_SHA256" ] ||
        die "runtime SHA256SUMS does not match the checksum pinned in install.sh: refusing to install"
      case "$arch" in
        x86_64) pinned=$RT_PINNED_X86_64_SHA256 ;;
        *) pinned=$RT_PINNED_AARCH64_SHA256 ;;
      esac
      [ "$(sha256 "$tmp/rt/$name.tar.gz")" = "$pinned" ] || die "checksum mismatch for $name.tar.gz: refusing to install"
      ok "runtime SHA256SUMS matches the pinned checksum"
    fi
  elif [ "$HAVE_COSIGN" = 0 ] && [ "$DRY_RUN" = 0 ]; then
    die "--runtime-version $RT_VERSION is not the pinned $RT_PINNED_VERSION: verifying it needs cosign"
  fi
  if [ "$HAVE_COSIGN" = 1 ] || [ "$DRY_RUN" = 1 ]; then
    fetch "$url/SHA256SUMS.sigstore.json" "$tmp/rt/SHA256SUMS.sigstore.json"
    verify_sums "$tmp/rt/SHA256SUMS" "$RT_CERT_IDENTITY_REGEXP" || die "cosign could not verify the runtime SHA256SUMS"
    [ "$DRY_RUN" = 1 ] || ok "runtime SHA256SUMS signature (Sigstore, $RT_REPO release workflow identity)"
  fi
  check_sum "$tmp/rt/SHA256SUMS" "$tmp/rt/$name.tar.gz" "$name.tar.gz"
  run tar -xzf "$tmp/rt/$name.tar.gz" -C "$tmp/rt" --no-same-owner
  run install -m 0755 "$tmp/rt/$name/rt" /usr/bin/rt
  if [ "$DRY_RUN" = 0 ] && ! id rt >/dev/null 2>&1; then
    useradd --system --user-group --home-dir /var/lib/rt --no-create-home --shell /usr/sbin/nologin rt
  fi
  run install -d -m 0755 /etc/rt
  run install -d -m 0750 /var/lib/rt
  run chown rt:rt /var/lib/rt
  if [ ! -f "$RT_TOML" ]; then run install -m 0644 "$tmp/rt/$name/defconfigs/production.toml" "$RT_TOML"; fi
  run install -m 0644 "$APP/deploy/rt.service" /etc/systemd/system/rt.service
}

# install_caddy_dns: Caddy with the DNS provider module, from Caddy's official build server, pinned Caddy and module
# versions. The build is not reproducible byte for byte, so its sha256 is printed (pin it with --caddy-sha256) and
# kept in $ETC/caddy-rtweb.sha256. It runs from the distribution's caddy.service through a drop-in.
install_caddy_dns() {
  mod=$(dns_module)
  case "$arch" in x86_64) carch=amd64 ;; *) carch=arm64 ;; esac
  url="https://caddyserver.com/api/download?os=linux&arch=$carch&version=v$CADDY_VERSION&p=$(printf '%s' "${mod%@*}" | sed 's|/|%2F|g')%40${mod#*@}"
  step "Caddy $CADDY_VERSION with $mod"
  fetch "$url" "$tmp/caddy-rtweb"
  got=""
  if [ "$DRY_RUN" = 0 ]; then
    got=$(sha256 "$tmp/caddy-rtweb")
    if [ -n "$CADDY_SHA256" ]; then
      [ "$got" = "$CADDY_SHA256" ] || die "caddy build sha256 $got does not match --caddy-sha256"
      ok "caddy build matches --caddy-sha256"
    else
      step "caddy build sha256 $got (pin it with --caddy-sha256 on other hosts)"
    fi
    chmod 0755 "$tmp/caddy-rtweb"
    "$tmp/caddy-rtweb" list-modules 2>/dev/null | grep -qx "dns.providers.$DNS_PROVIDER" ||
      die "the downloaded Caddy has no dns.providers.$DNS_PROVIDER module"
  fi
  run install -m 0755 "$tmp/caddy-rtweb" "$CADDY_DNS_BIN"
  [ "$DRY_RUN" = 1 ] || printf '%s  %s\n' "$got" "$CADDY_DNS_BIN" >"$ETC/caddy-rtweb.sha256"
  CADDY_BIN=$CADDY_DNS_BIN
}

# systemd_creds_ok FILE: whether a unit here can load FILE as a credential (cached).
systemd_creds_ok() {
  if [ -z "${CREDS_OK:-}" ]; then
    CREDS_OK=no
    # shellcheck disable=SC2016 # expanded by the probe's shell
    if have systemd-run && systemd-run --wait --quiet --collect -p "LoadCredential=probe:$1" \
      /bin/sh -c 'test -r "$CREDENTIALS_DIRECTORY/probe"' >/dev/null 2>&1; then
      CREDS_OK=yes
    fi
  fi
  [ "$CREDS_OK" = yes ]
}

# caddy_dropin: environment for deploy/Caddyfile; with --wildcard-cert also the DNS token credential and the Caddy build
# with the DNS module (ExecStart without --environ, which would log the environment).
caddy_dropin() {
  printf '# runtime-web install.sh\n[Service]\nEnvironmentFile=%s\n' "$ETC/caddy.env"
  if [ "$WILDCARD" = 1 ]; then
    if systemd_creds_ok "$ETC/dns-token"; then
      printf 'LoadCredential=dns-token:%s\n' "$ETC/dns-token"
    else
      # No credentials on this host: the caddy group reads the 0640 token file in place.
      chgrp caddy "$ETC/dns-token" && chmod 0640 "$ETC/dns-token" && chmod 0711 "$ETC"
    fi
    printf 'ExecStart=\nExecStart=%s run --config /etc/caddy/Caddyfile --adapter caddyfile\n' "$CADDY_DNS_BIN"
    printf 'ExecReload=\nExecReload=%s reload --config /etc/caddy/Caddyfile --adapter caddyfile --force\n' "$CADDY_DNS_BIN"
  fi
}

# apps_tls_option run|validate: the one line inside the tls block of the *.<apps domain> site (RTWEB_APPS_TLS in
# deploy/Caddyfile): on_demand (one certificate per App, approved by the console's tls-ask), or the DNS-01 directive
# with the token file: the systemd credential at run time (or the root-only file without credentials), the file in
# $ETC for the installer's own validate run.
apps_tls_option() {
  if [ "$WILDCARD" = 0 ]; then
    printf 'on_demand'
  elif [ "$1" = validate ] || ! systemd_creds_ok "$ETC/dns-token"; then
    dns_directive "{file.$ETC/dns-token}"
  else
    dns_directive "{file./run/credentials/caddy.service/dns-token}"
  fi
}

uninstall_bare() {
  section "Uninstall (bare)"
  RT_ENV=/etc/default/rt
  [ -d /etc/sysconfig ] && [ ! -d /etc/default ] && RT_ENV=/etc/sysconfig/rt
  step "removing $PREFIX, $ETC (secrets, caddy.env), $CADDY_SITE and $CADDY_DROPIN"
  run rm -rf "$PREFIX" "$ETC"
  run rm -f "$CADDY_SITE" "$CADDY_WILDCARD_SITE" "$CADDY_DROPIN" "$CADDY_DNS_BIN"
  [ "$DRY_RUN" = 1 ] || rmdir /etc/systemd/system/caddy.service.d 2>/dev/null || true
  if [ "$DRY_RUN" = 1 ]; then
    step "would remove RTWEB_OP_TOKEN / RTWEB_RELAY_SECRET from $RT_ENV, the runtime-web block from $RT_TOML and the import install.sh added to $CADDY_MAIN"
  else
    [ -f "$RT_ENV" ] && drop_env_keys "$RT_ENV" RTWEB_OP_TOKEN RTWEB_RELAY_SECRET
    [ -f "$RT_TOML" ] && strip_block "$RT_TOML" && set_base_domain "$RT_TOML" ""
    [ -f "$CADDY_MAIN" ] && drop_caddy_import "$CADDY_MAIN"
  fi
  if have systemctl; then
    run systemctl daemon-reload
    # Restart, not reload: a --wildcard-cert install ran its own Caddy build, which is gone now.
    run systemctl restart caddy || true
    run systemctl restart rt || true
  fi
  cat >&2 <<EOF

Runtime Web files, secrets, the rtweb plan + bindings and the Caddy site are removed. Left in place:
  - the runtime node (rt), its data (/var/lib/rt), RT_ROOT_TOKEN, its master key ($RT_CRED_DIR or $RT_ENV)
    and the rest of $RT_TOML (backup: $RT_TOML.pre-rtweb)
  - Caddy's certificates and $CADDY_MAIN without the Caddyfile.d import install.sh added (backup: $CADDY_MAIN.pre-rtweb)
  - the runtime tenant 'runtime-web' and service 'rtweb' (delete them with the control API:
    DELETE /v1/tenants/<id> using the root token)
EOF
}

# ===================================================================================================================
# docker mode
compose() { docker compose -p "$PROJECT" -f "$DOCKER_DIR/compose.yaml" "$@"; }

install_docker() {
  section "Image"
  if [ -n "$IMAGE" ]; then
    warn "--image $IMAGE: not signature-checked"
  else
    if [ -z "$VERSION" ]; then
      if [ "$DRY_RUN" = 1 ]; then VERSION=latest; else VERSION=$(latest "$REPO"); fi
    fi
    IMAGE="$IMAGE_REPO:$VERSION"
    run docker pull -q "$IMAGE" >/dev/null
    if [ "$DRY_RUN" = 0 ]; then
      # Pin what was verified: the digest, not the tag.
      digest=$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$IMAGE" | grep "^$IMAGE_REPO@" | head -n1)
      [ -n "$digest" ] || die "no registry digest for $IMAGE"
      IMAGE="$IMAGE_REPO:$VERSION@${digest#*@}"
    fi
    if [ "$DRY_RUN" = 1 ]; then
      step "would verify the image signature: cosign verify $IMAGE (identity $IMAGE_IDENTITY_REGEXP)"
    elif [ "$HAVE_COSIGN" = 1 ]; then
      cosign verify "$IMAGE" --certificate-identity-regexp "$IMAGE_IDENTITY_REGEXP" \
        --certificate-oidc-issuer "$CERT_OIDC_ISSUER" >/dev/null 2>"$tmp/cosign.log" || {
        sed 's/^/    /' "$tmp/cosign.log" >&2
        die "cosign could not verify $IMAGE: refusing to run it"
      }
      ok "image signature (Sigstore, $REPO docker workflow identity)"
    else
      warn "--insecure-skip-signature: $IMAGE is NOT signature-checked"
    fi
  fi
  step "image $IMAGE"

  section "Compose project $PROJECT ($DOCKER_DIR)"
  run install -d -m 0700 "$DOCKER_DIR"
  docker_secrets
  if [ "$DRY_RUN" = 1 ]; then
    step "would write $DOCKER_DIR/compose.yaml and $DOCKER_DIR/Caddyfile, then: docker compose -p $PROJECT up -d"
    return 0
  fi
  CADDY_RUN_IMAGE=$CADDY_IMAGE
  if [ "$WILDCARD" = 1 ]; then
    build_caddy_dns
  else
    rm -rf "$DOCKER_DIR/caddy" "$DOCKER_DIR/secrets/dns_token"
  fi
  write_compose >"$DOCKER_DIR/compose.yaml.new"
  [ "$TLS" = none ] || write_docker_caddyfile >"$DOCKER_DIR/Caddyfile"
  chmod 0600 "$DOCKER_DIR/compose.yaml.new"
  [ ! -f "$DOCKER_DIR/Caddyfile" ] || chmod 0644 "$DOCKER_DIR/Caddyfile"
  docker compose -p "$PROJECT" -f "$DOCKER_DIR/compose.yaml.new" config -q 2>"$tmp/compose.log" || {
    sed 's/^/    /' "$tmp/compose.log" >&2
    die "the generated compose file is invalid ($DOCKER_DIR/compose.yaml.new)"
  }
  mv "$DOCKER_DIR/compose.yaml.new" "$DOCKER_DIR/compose.yaml"
  if [ "$TLS" != none ]; then
    dns_mount=""
    [ ! -f "$DOCKER_DIR/secrets/dns_token" ] || dns_mount="$DOCKER_DIR/secrets/dns_token:/run/secrets/dns_token:ro"
    docker run --rm -v "$DOCKER_DIR/Caddyfile:/etc/caddy/Caddyfile:ro" ${dns_mount:+-v "$dns_mount"} "$CADDY_RUN_IMAGE" \
      caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >"$tmp/caddy-validate.log" 2>&1 || {
      mask_token <"$tmp/caddy-validate.log" | sed 's/^/    /' >&2
      die "caddy validate failed for $DOCKER_DIR/Caddyfile"
    }
  fi
  ok "wrote compose.yaml$([ "$TLS" = none ] || printf ' and Caddyfile')"
  compose up -d --remove-orphans --quiet-pull >"$tmp/up.log" 2>&1 || {
    sed 's/^/    /' "$tmp/up.log" >&2
    die "docker compose up failed"
  }
  ok "containers started"

  cid=$(compose ps -q rtweb)
  [ -n "$cid" ] || die "no rtweb container (docker compose -p $PROJECT ps)"
  wait_for "the console container to become healthy" 180 sh -c "[ \"\$(docker inspect -f '{{.State.Health.Status}}' $cid)\" = healthy ]" ||
    die "rtweb did not become healthy: docker compose -p $PROJECT logs rtweb"
  ok "rtweb is healthy"
  # The file exists until setup is done (rtweb-entry deletes it on the next start after setup).
  SETUP_TOKEN=$(docker cp "$cid:/data/rtweb/secrets/setup-token" - 2>/dev/null | tar -xO 2>/dev/null | tr -d '\n' || true)
  if [ -z "$SETUP_TOKEN" ]; then
    SETUP_TOKEN=$(compose logs --no-log-prefix rtweb 2>/dev/null | sed -n 's/.*Setup token ([^)]*): //p' | tail -n1)
  fi
}

# docker_secrets: root token, master key and relay secret as Docker secrets (files bind-mounted read-only at
# /run/secrets, 0400, owned by the container user 10001): not in the image, the compose file, the environment
# or the data volume. A data volume that already exists keeps the secrets it generated itself, since a new master
# key could not open its sealed secrets.
docker_secrets() {
  sdir="$DOCKER_DIR/secrets"
  if [ "$DRY_RUN" = 1 ]; then
    step "would create $sdir/{rt_root_token,rt_master_key,rtweb_relay_secret} (0400, uid 10001) for Docker secrets"
    FILE_SECRETS=1
    return 0
  fi
  FILE_SECRETS=1
  if [ ! -f "$sdir/rt_master_key" ] && docker volume inspect "${PROJECT}_rtweb-data" >/dev/null 2>&1; then
    FILE_SECRETS=0
    warn "volume ${PROJECT}_rtweb-data exists without $sdir: keeping the secrets it holds (/data/rtweb/secrets)"
    return 0
  fi
  install -d -m 0700 "$sdir"
  for s in rt_root_token rt_master_key rtweb_relay_secret; do
    if [ ! -s "$sdir/$s" ]; then
      random_hex 32 >"$sdir/$s"
      ok "generated $sdir/$s (not printed)"
    fi
    chown 10001:10001 "$sdir/$s"
    chmod 0400 "$sdir/$s"
  done
}

# build_caddy_dns: a local Caddy image with the DNS provider module, built with xcaddy from the pinned official
# builder image; Go verifies every module against go.sum and the checksum database (sum.golang.org).
build_caddy_dns() {
  mod=$(dns_module)
  CADDY_RUN_IMAGE="runtime-web-caddy:$CADDY_VERSION-$DNS_PROVIDER"
  install -d -m 0755 "$DOCKER_DIR/caddy"
  printf '%s\n' "# Generated by runtime-web install.sh: Caddy $CADDY_VERSION with $mod." \
    "FROM $CADDY_BUILDER_IMAGE AS build" \
    "RUN GOFLAGS=-mod=mod GOSUMDB=sum.golang.org xcaddy build v$CADDY_VERSION --with $mod" \
    "FROM $CADDY_IMAGE" \
    "COPY --from=build /usr/bin/caddy /usr/bin/caddy" >"$DOCKER_DIR/caddy/Dockerfile"
  step "building $CADDY_RUN_IMAGE (xcaddy, $mod)"
  docker build -q -t "$CADDY_RUN_IMAGE" "$DOCKER_DIR/caddy" >"$tmp/caddy-build.log" 2>&1 || {
    sed 's/^/    /' "$tmp/caddy-build.log" >&2
    die "building $CADDY_RUN_IMAGE failed"
  }
  docker run --rm "$CADDY_RUN_IMAGE" caddy list-modules 2>/dev/null | grep -qx "dns.providers.$DNS_PROVIDER" ||
    die "$CADDY_RUN_IMAGE has no dns.providers.$DNS_PROVIDER module"
  ok "built $CADDY_RUN_IMAGE"
  install -d -m 0700 "$DOCKER_DIR/secrets"
  (umask 077 && printf '%s' "$DNS_TOKEN" >"$DOCKER_DIR/secrets/dns_token")
  chmod 0400 "$DOCKER_DIR/secrets/dns_token"
  ok "stored the $DNS_PROVIDER API token as the Docker secret dns_token (0400; not printed)"
}

write_compose() {
  cat <<EOF
# Generated by runtime-web install.sh (docker mode). Re-run the installer to change it; manual edits are replaced.
#   docker compose -p $PROJECT -f $DOCKER_DIR/compose.yaml ps|logs|pull|up -d
name: $PROJECT

services:
  rtweb:
    image: $IMAGE
    restart: unless-stopped
    init: true
    read_only: true
    environment:
      RTWEB_CONSOLE_URL: $CONSOLE_URL
      RTWEB_APPS_URL: $APPS_URL
      # The compose network: Caddy's X-Forwarded-For / X-Forwarded-Proto are trusted from here only.
      RTWEB_TRUSTED_PROXIES: $SUBNET
EOF
  [ "$TLS" = none ] || printf '      # On-demand TLS check for custom domains, asked by Caddy over the compose network (never published).\n      RTWEB_TLS_ASK_LISTEN: ":8079"\n'
  [ -z "$DEFAULT_PLAN" ] || printf '      RTWEB_DEFAULT_PLAN: %s\n' "$DEFAULT_PLAN"
  if [ "$FILE_SECRETS" = 1 ]; then
    cat <<'EOF'
      RT_ROOT_TOKEN_FILE: /run/secrets/rt_root_token
      RT_MASTER_KEY_FILE: /run/secrets/rt_master_key
      RTWEB_RELAY_SECRET_FILE: /run/secrets/rtweb_relay_secret
    secrets:
      - rt_root_token
      - rt_master_key
      - rtweb_relay_secret
EOF
  fi
  cat <<'EOF'
    volumes:
      - rtweb-data:/data
    # rt and rtweb-entry write only /data (SQLite temp files go to /data/tmp); this small tmpfs is a safety net.
    tmpfs:
      - /tmp:size=16m,mode=1777,noexec,nosuid,nodev
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    ulimits:
      nofile:
        soft: 65536
        hard: 65536
    stop_grace_period: 30s
    networks:
      - edge
EOF
  if [ "$TLS" = none ]; then
    printf '    ports:\n      - "127.0.0.1:%s:8080"\n' "$HTTP_PORT"
  else
    cat <<EOF

  caddy:
    image: $CADDY_RUN_IMAGE
    restart: unless-stopped
    read_only: true
    depends_on:
      - rtweb
    ports:
      - "$HTTP_PORT:80"
      - "$HTTPS_PORT:443"
      - "$HTTPS_PORT:443/udp"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
    tmpfs:
      - /tmp:size=16m,noexec,nosuid,nodev
EOF
    [ ! -f "$DOCKER_DIR/secrets/dns_token" ] || printf '    secrets:\n      - dns_token\n'
    cat <<EOF
    cap_drop:
      - ALL
    cap_add:
      - NET_BIND_SERVICE
    security_opt:
      - no-new-privileges:true
    networks:
      - edge
EOF
  fi
  cat <<EOF

networks:
  edge:
    ipam:
      config:
        - subnet: $SUBNET

volumes:
  rtweb-data:
EOF
  [ "$TLS" = none ] || printf '  caddy-data:\n  caddy-config:\n'
  names=""
  [ "$FILE_SECRETS" = 0 ] || names="rt_root_token rt_master_key rtweb_relay_secret"
  [ ! -f "$DOCKER_DIR/secrets/dns_token" ] || names="$names dns_token"
  if [ -n "$names" ]; then
    printf '\nsecrets:\n'
    for s in $names; do
      printf '  %s:\n    file: ./secrets/%s\n' "$s" "$s"
    done
  fi
}

write_docker_caddyfile() {
  tls_opt=$(caddy_tls_option)
  if [ "$WILDCARD" = 1 ]; then
    apps_tls=$(dns_directive '{file./run/secrets/dns_token}')
  else
    apps_tls=on_demand
  fi
  cat <<EOF
# Generated by runtime-web install.sh (docker mode). The rtweb container applies the console rules itself (internal
# routes 404, the console never on the apps domain, /s/ blocked on App hosts, HSTS, X-Forwarded-For from trusted
# proxies only).
{
${EMAIL:+	email $EMAIL
}${tls_opt:+	$tls_opt
}	on_demand_tls {
		# 200 only for an existing App (<app>.$APPS_DOMAIN) or an active custom domain.
		ask http://rtweb:8079/tls-ask
	}
}

$DOMAIN, $APPS_DOMAIN {
	reverse_proxy rtweb:8080
}

# Every App at https://<app>.$APPS_DOMAIN/.
*.$APPS_DOMAIN {
	tls {
		$apps_tls
	}
	reverse_proxy rtweb:8080
}

# App custom domains: a certificate is requested only after the ask endpoint says yes.
https:// {
	tls {
		on_demand
	}
	reverse_proxy rtweb:8080
}
EOF
}

uninstall_docker() {
  section "Uninstall (docker)"
  if [ "$DRY_RUN" = 1 ]; then
    step "would run: docker compose -p $PROJECT down$([ "$PURGE" = 0 ] || printf ' --volumes') and remove $DOCKER_DIR$([ "$PURGE" = 1 ] || printf ' (except secrets/)')"
    return 0
  fi
  have docker || die "docker not found"
  if [ -f "$DOCKER_DIR/compose.yaml" ]; then
    if [ "$PURGE" = 1 ]; then
      compose down --volumes --remove-orphans >"$tmp/down.log" 2>&1 || { sed 's/^/    /' "$tmp/down.log" >&2; die "docker compose down failed"; }
    else
      compose down --remove-orphans >"$tmp/down.log" 2>&1 || { sed 's/^/    /' "$tmp/down.log" >&2; die "docker compose down failed"; }
    fi
    ok "containers removed"
  else
    warn "no $DOCKER_DIR/compose.yaml: nothing to stop"
  fi
  if [ "$PURGE" = 1 ]; then
    rm -rf "$DOCKER_DIR"
    rmdir "$PREFIX" 2>/dev/null || true
    ok "removed $DOCKER_DIR, the data volumes and the secrets"
  else
    rm -f "$DOCKER_DIR/compose.yaml" "$DOCKER_DIR/Caddyfile"
    cat >&2 <<EOF

Containers are removed. Left in place (delete them with --uninstall --mode docker --purge):
  - volumes ${PROJECT}_rtweb-data (database, Apps, logs) and ${PROJECT}_caddy-data (certificates)
  - $DOCKER_DIR/secrets (root token, master key, relay secret; the data volume needs the same master key)
EOF
  fi
}

# ===================================================================================================================
# wait_for WHAT SECONDS CMD...: retry CMD once a second.
wait_for() {
  what=$1
  max=$2
  shift 2
  i=0
  until "$@" >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -le "$max" ] || return 1
    [ "$i" != 3 ] || step "waiting for $what (up to ${max}s)"
    sleep 1
  done
}

finish() {
  if [ "$DRY_RUN" = 1 ]; then
    section "Dry run done"
    say "  Runtime Web ${VERSION:-latest} would be installed ($MODE mode). Run again without --dry-run to install."
    return 0
  fi
  # HTTPS through Caddy, from this host (certificates can take a minute, and staging/internal ones are untrusted).
  if [ "$TLS" != none ]; then
    if wait_for "HTTPS on $DOMAIN" 45 curl -fsSk --max-time 5 --resolve "$DOMAIN:$HTTPS_PORT:127.0.0.1" "https://$DOMAIN:$HTTPS_PORT/healthz"; then
      ok "HTTPS answers for $DOMAIN"
    else
      warn "no HTTPS answer for $DOMAIN yet: Caddy may still be getting the certificate (logs below in Next steps)"
    fi
  fi

  if [ "$MODE" = docker ]; then
    logs_cmd="docker compose -p $PROJECT logs -f"
    data_line="volume ${PROJECT}_rtweb-data (/data in the container); certificates: ${PROJECT}_caddy-data"
    secrets_line="$DOCKER_DIR/secrets/ (Docker secrets, 0400)"
    [ "${FILE_SECRETS:-1}" = 1 ] || secrets_line="/data/rtweb/secrets in the data volume"
    uninstall_cmd="sh install.sh --uninstall --mode docker   (add --purge to delete data and secrets)"
  else
    logs_cmd="journalctl -u rt -u caddy -f"
    data_line="/var/lib/rt (rt: databases, Apps, logs); /opt/runtime-web (release files)"
    secrets_line="$RT_ENV, $ETC/ (0600)$([ ! -f "$RT_CRED_DROPIN" ] || printf ', master key %s/rt-master-key' "$RT_CRED_DIR")"
    uninstall_cmd="sh install.sh --uninstall   (the rt node and its data stay)"
  fi

  section "Runtime Web${VERSION:+ $VERSION} is installed"
  kv "Console" "$CONSOLE_URL"
  kv "Apps" "$(app_url_pattern)"
  kv "Setup page" "$CONSOLE_URL/setup"
  if [ -n "$SETUP_TOKEN" ]; then
    printf '  %-14s %s%s%s\n' "Setup token" "$B$G" "$SETUP_TOKEN" "$N" >&2
    say "                 works once; copy it now (it is not shown again)"
  else
    kv "Setup token" "none issued by this run: setup is already done, or a token from an earlier run is still valid"
    say "                 (lost it? docs/getting-started/first-run.md#lost-setup-token)"
  fi
  [ "$TLS" = auto ] || warn "certificates are untrusted ($(tls_label)); re-run with --tls auto for production"

  section "Next steps"
  say "  1. DNS: $DOMAIN, $APPS_DOMAIN and *.$APPS_DOMAIN must point at this host (A/AAAA)."
  say "  2. Open $CONSOLE_URL/setup, paste the setup token and create the instance admin."
  say "  3. Firewall: allow inbound 80/tcp and 443/tcp only (ufw allow 80,443/tcp). Keep 8080, 8081 and 9090 private."
  say "  4. Back up the data and, apart from it, the secrets (below). Logs: $logs_cmd"
  say ""
  kv "Data" "$data_line"
  kv "Secrets" "$secrets_line"
  kv "Uninstall" "$uninstall_cmd"
  say ""
}

# --- bare mode file helpers ----------------------------------------------------------------------------------------
# read_env KEY FILE: value of KEY=... without sourcing the file (no code execution, no echo).
read_env() {
  sed -n "s/^$1=//p" "$2" 2>/dev/null | tail -n1 | sed 's/^"\(.*\)"$/\1/; s/^'"'"'\(.*\)'"'"'$/\1/'
}

root_token() {
  t=$(read_env RT_ROOT_TOKEN "$RT_ENV")
  if [ -z "$t" ]; then
    f=$(read_env RT_ROOT_TOKEN_FILE "$RT_ENV")
    [ -n "$f" ] && [ -r "$f" ] && t=$(tr -d '\n' <"$f")
  fi
  [ -n "$t" ] || die "no RT_ROOT_TOKEN or RT_ROOT_TOKEN_FILE in $RT_ENV"
  printf '%s' "$t"
}

# drop_env_keys FILE KEY...: remove KEY=... lines, keeping mode 0600 (the value never reaches argv).
drop_env_keys() {
  f=$1
  shift
  cp -p "$f" "$f.rtweb-tmp"
  for k in "$@"; do
    grep -v "^$k=" "$f.rtweb-tmp" >"$f.rtweb-tmp2" || true
    mv "$f.rtweb-tmp2" "$f.rtweb-tmp"
  done
  chmod 0600 "$f.rtweb-tmp"
  mv "$f.rtweb-tmp" "$f"
}

# set_env_key FILE KEY VALUE: replace or add KEY=VALUE. VALUE is passed through printf only (a shell builtin).
set_env_key() {
  drop_env_keys "$1" "$2"
  printf '%s=%s\n' "$2" "$3" >>"$1"
}

# strip_block FILE: remove the managed runtime-web block (and a legacy appended fragment, which ran to the end).
# Blank lines just before the block are dropped too: the merge writes a leading blank line before the block, so
# keeping them would add one blank line on every run.
strip_block() {
  awk -v b="$BLOCK_BEGIN" -v e="$BLOCK_END" -v l="$LEGACY_MARK" '
    $0 == b { skip = 1; held = 0; next }
    $0 == e { skip = 0; next }
    $0 == l { legacy = 1 }
    skip || legacy { next }
    $0 == "" { held++; next }
    { while (held > 0) { print ""; held-- } print }
    END { while (held > 0) { print ""; held-- } }
  ' "$1" >"$1.rtweb-tmp"
  chmod 0644 "$1.rtweb-tmp"
  mv "$1.rtweb-tmp" "$1"
}

# caddy_import FILE: put the Caddyfile.d import first in the main Caddyfile. rtweb.caddy starts with the global
# options block (email, on_demand_tls), which Caddy accepts only before every site block: distribution Caddyfiles
# end with this import after their own `:80` site, which fails with "server block without any key is global
# configuration, and if used, it must be first". An existing bare import line moves to the top (site order does not
# matter); a main Caddyfile with its own global options block cannot take a second one.
caddy_import() {
  if [ ! -f "$1" ]; then
    printf '%s\n%s\n' "$CADDY_IMPORT_MARK" "$CADDY_IMPORT" >"$1"
    chmod 0644 "$1"
    return 0
  fi
  [ -f "$1.pre-rtweb" ] || cp -p "$1" "$1.pre-rtweb"
  first=$(awk -v m="$CADDY_IMPORT_MARK" -v i="$CADDY_IMPORT" '
    { sub(/^[ \t]+/, ""); sub(/[ \t]+$/, "") }
    $0 == "" || $0 ~ /^#/ || $0 == i { next }
    { print; exit }' "$1")
  case "$first" in
    "{"*) die "$1 has its own global options block: move its options into the block at the top of $CADDY_SITE (or the reverse), put '$CADDY_IMPORT' at the top of $1, and re-run" ;;
  esac
  # Remember whether the import was there before us (moved, so uninstall keeps it) or added by us.
  mark=$CADDY_IMPORT_MARK
  if grep -qxF "$CADDY_IMPORT_MARK (moved)" "$1" || { ! grep -qxF "$CADDY_IMPORT_MARK" "$1" && grep -qxF "$CADDY_IMPORT" "$1"; }; then
    mark="$CADDY_IMPORT_MARK (moved)"
  fi
  {
    printf '%s\n%s\n' "$mark" "$CADDY_IMPORT"
    awk -v m="$CADDY_IMPORT_MARK" -v i="$CADDY_IMPORT" '$0 == m || $0 == m " (moved)" || $0 == i { next } { print }' "$1"
  } >"$1.rtweb-tmp"
  chmod 0644 "$1.rtweb-tmp"
  mv "$1.rtweb-tmp" "$1"
}

# drop_caddy_import FILE: undo caddy_import (the original is kept as FILE.pre-rtweb).
drop_caddy_import() {
  if grep -qxF "$CADDY_IMPORT_MARK (moved)" "$1"; then
    grep -vxF "$CADDY_IMPORT_MARK (moved)" "$1" >"$1.rtweb-tmp" || true
    chmod 0644 "$1.rtweb-tmp"
    mv "$1.rtweb-tmp" "$1"
    return 0
  fi
  grep -qxF "$CADDY_IMPORT_MARK" "$1" || return 0
  awk -v m="$CADDY_IMPORT_MARK" -v i="$CADDY_IMPORT" '$0 == m { drop = 1; next } drop && $0 == i { drop = 0; next } { drop = 0; print }' \
    "$1" >"$1.rtweb-tmp"
  chmod 0644 "$1.rtweb-tmp"
  mv "$1.rtweb-tmp" "$1"
}

# set_base_domain FILE DOMAIN: routing.base_domain, so rt routes Host <slug>.<base_domain> to the App.
# Only a value install.sh set (marked) or an empty one is changed; DOMAIN "" clears what install.sh set.
BASE_DOMAIN_MARK='# runtime-web install.sh (Apps at <slug>.<apps domain>)'
set_base_domain() {
  line=$(grep -E '^[[:space:]]*base_domain[[:space:]]*=' "$1" | head -n1 || true)
  if [ -z "$2" ]; then
    case "$line" in *"$BASE_DOMAIN_MARK"*) ;; *) return 0 ;; esac
    new='base_domain = ""'
  else
    new="base_domain = \"$2\"   $BASE_DOMAIN_MARK"
  fi
  if [ -n "$line" ]; then
    case "$line" in
      *"$BASE_DOMAIN_MARK"* | *'base_domain = ""'* | *"base_domain = \"$2\""*) ;;
      *) die "$1 sets routing.base_domain already: set it to \"$2\" (or remove it) and re-run" ;;
    esac
    awk -v n="$new" '!done && /^[[:space:]]*base_domain[[:space:]]*=/ { print n; done = 1; next } { print }' "$1" >"$1.rtweb-tmp"
  elif [ -z "$2" ]; then
    return 0
  elif grep -q '^\[routing\]' "$1"; then
    awk -v n="$new" '{ print } $0 == "[routing]" { print n }' "$1" >"$1.rtweb-tmp"
  else
    { cat "$1"; printf '\n[routing]\n%s\n' "$new"; } >"$1.rtweb-tmp"
  fi
  chmod 0644 "$1.rtweb-tmp"
  mv "$1.rtweb-tmp" "$1"
  [ -z "$2" ] || ok "routing.base_domain = $2 (Apps at <slug>.$2)"
}

# ensure_trusted_proxies FILE: the node must trust Caddy on loopback, or every client IP reads 127.0.0.1.
ensure_trusted_proxies() {
  if grep -Eq '^[[:space:]]*trusted_proxies[[:space:]]*=' "$1"; then
    grep -E '^[[:space:]]*trusted_proxies[[:space:]]*=' "$1" | grep -q '127\.0\.0\.1' ||
      die "$1 sets ingress.trusted_proxies without 127.0.0.1: add \"127.0.0.1/32\", \"::1/128\" (Caddy on this host)"
  elif grep -q '^\[ingress\]' "$1"; then
    awk '{ print } $0 == "[ingress]" { print "trusted_proxies = [\"127.0.0.1/32\", \"::1/128\"]   # Caddy (runtime-web install.sh)" }' \
      "$1" >"$1.rtweb-tmp"
    chmod 0644 "$1.rtweb-tmp"
    mv "$1.rtweb-tmp" "$1"
  else
    printf '\n[ingress]\ntrusted_proxies = ["127.0.0.1/32", "::1/128"]   # Caddy (runtime-web install.sh)\n' >>"$1"
  fi
  ok "ingress.trusted_proxies covers loopback (client IPs come from Caddy's X-Forwarded-For)"
}

main "$@"

#!/bin/sh
# Install Runtime Web (the 21 Cloud console) on a Linux host, as an App on a 21 Cloud Runtime node.
#
#   curl -fsSL https://raw.githubusercontent.com/21-ci/runtime-web/main/install.sh | sudo sh -s -- --domain console.example.com --email ops@example.com
#
# Options:
#   --version X.Y.Z        Runtime Web release (default: the latest)
#   --domain HOST          console host name, served by Caddy with automatic TLS (required to install)
#   --email ADDR           ACME account e-mail for Caddy (required to install)
#   --apps-domain HOST     host that serves Apps at /s/<app>/, its own origin so App code never runs on the
#                          console origin (default: apps.<domain>; needs its own DNS record)
#   --public-url URL       public base of app URLs, RTWEB_RUNTIME_PUBLIC_URL (default: https://<apps-domain>)
#   --default-plan NAME    runtime plan for new org tenants, RTWEB_DEFAULT_PLAN (default: the server's "free")
#   --runtime-version X    21 Cloud Runtime release to install when `rt` is missing (default: the pinned
#                          RT_PINNED_VERSION below; any other version needs cosign)
#   --insecure-skip-signature
#                          install a Runtime Web release without verifying its Sigstore signature (checksums only).
#                          Without this flag the installer refuses to run when cosign is not on PATH.
#   --tarball PATH         install from a local runtime-web-X.Y.Z.tar.gz (release layout) instead of downloading
#                          one: for testing a local build or air-gapped hosts. The tarball is NOT signature-checked;
#                          pass --insecure-skip-signature to confirm (with --sha256 HEX it is checked against HEX)
#   --dry-run              print every step instead of changing the host (needs no root, no network)
#   --uninstall            remove Runtime Web files, secrets, bindings and the Caddy site (the runtime node stays)
#   -h, --help
#
# What it does (docs/contributing/architecture.md section 5):
#   1. checks root, Linux, x86_64/aarch64, curl, tar, sha256sum|shasum, node >= 22.5
#   2. downloads runtime-web-<ver>.tar.gz + SHA256SUMS + Sigstore bundle, verifies the signature on SHA256SUMS
#      (release workflow identity) and the tarball against it, unpacks to /opt/runtime-web
#   3. installs the runtime node (rt) when it is not on PATH: the release tarball of a pinned version, checked against
#      a SHA256SUMS whose own sha256 is pinned in this file (and its Sigstore signature when cosign is on PATH).
#      Nothing is ever fetched from a branch or a raw file at a git ref.
#   4. generates RTWEB_RELAY_SECRET (0600, never printed), derives RTWEB_OP_TOKEN ("Bearer <root token>"), adds
#      the rtweb plan + bindings (deploy/rt.rtweb.toml) and ingress.trusted_proxies to /etc/rt/rt.toml, restarts rt
#   5. installs the Caddy site (deploy/Caddyfile: relay + console host + on-demand TLS gated by an `ask` endpoint)
#      and puts its import first in /etc/caddy/Caddyfile (the site file holds the global options)
#   6. runs server/scripts/install.mjs with the node's root token read from the rt environment file
#   7. prints the first-run setup URL and firewall hints
#
# Environment: RTWEB_SLUG (console service slug, default rtweb; install.mjs and the Caddy site use the same value),
# RTWEB_INSTALL_REPO (default 21-ci/runtime-web), RTWEB_INSTALL_BASE_URL (release download mirror;
# the signature still has to come from the release workflow), GITHUB_TOKEN (optional, for the latest-version lookup).
set -eu

# The whole script runs from main(), called on the last line: a truncated `curl | sh` download runs nothing.
main() {

REPO=${RTWEB_INSTALL_REPO:-21-ci/runtime-web}
BASE_URL=${RTWEB_INSTALL_BASE_URL:-https://github.com/$REPO/releases/download}
CERT_IDENTITY_REGEXP="^https://github\.com/$REPO/\.github/workflows/release\.yml@refs/tags/v"
CERT_OIDC_ISSUER=https://token.actions.githubusercontent.com

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
CADDY_SITE=/etc/caddy/Caddyfile.d/rtweb.caddy
CADDY_DROPIN=/etc/systemd/system/caddy.service.d/rtweb.conf
CADDY_MAIN=/etc/caddy/Caddyfile
CADDY_IMPORT='import /etc/caddy/Caddyfile.d/*.caddy'
CADDY_IMPORT_MARK='# runtime-web install.sh: this import must stay first (rtweb.caddy holds the global options)'
NODE_MIN_MAJOR=22
NODE_MIN_MINOR=5
BLOCK_BEGIN='# >>> runtime-web (managed by install.sh; do not edit inside) >>>'
BLOCK_END='# <<< runtime-web <<<'
LEGACY_MARK='# --- added by runtime-web install.sh ---'

VERSION=""
RT_VERSION=""
DOMAIN=""
APPS_DOMAIN=""
EMAIL=""
PUBLIC_URL=""
DEFAULT_PLAN=""
TARBALL=""
TARBALL_SHA256=""
SLUG=${RTWEB_SLUG:-rtweb}
DRY_RUN=0
UNINSTALL=0
SKIP_SIG=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || die "--version needs X.Y.Z"
      VERSION=${2#v}
      shift 2
      ;;
    --runtime-version)
      [ "$#" -ge 2 ] || die "--runtime-version needs X.Y.Z"
      RT_VERSION=${2#v}
      shift 2
      ;;
    --domain)
      [ "$#" -ge 2 ] || die "--domain needs a host name"
      DOMAIN=$2
      shift 2
      ;;
    --apps-domain)
      [ "$#" -ge 2 ] || die "--apps-domain needs a host name"
      APPS_DOMAIN=$2
      shift 2
      ;;
    --email)
      [ "$#" -ge 2 ] || die "--email needs an address"
      EMAIL=$2
      shift 2
      ;;
    --public-url)
      [ "$#" -ge 2 ] || die "--public-url needs a URL"
      PUBLIC_URL=$2
      shift 2
      ;;
    --default-plan)
      [ "$#" -ge 2 ] || die "--default-plan needs a plan name"
      DEFAULT_PLAN=$2
      shift 2
      ;;
    --tarball)
      [ "$#" -ge 2 ] || die "--tarball needs a path"
      TARBALL=$2
      shift 2
      ;;
    --sha256)
      [ "$#" -ge 2 ] || die "--sha256 needs a hex digest"
      TARBALL_SHA256=$2
      shift 2
      ;;
    --verify-signature)
      # Kept for old command lines: verification is now always required.
      shift
      ;;
    --insecure-skip-signature)
      SKIP_SIG=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --uninstall)
      UNINSTALL=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

# --- input validation (values end up in config files, so keep them to safe characters) ---------------------------
[ -z "$VERSION" ] || valid_version "$VERSION" || die "bad --version '$VERSION'"
[ -z "$RT_VERSION" ] || valid_version "$RT_VERSION" || die "bad --runtime-version '$RT_VERSION'"
[ -n "$RT_VERSION" ] || RT_VERSION=$RT_PINNED_VERSION
if [ -n "$DOMAIN" ]; then
  printf '%s' "$DOMAIN" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$' ||
    die "bad --domain '$DOMAIN' (a fully qualified host name)"
fi
[ -n "$APPS_DOMAIN" ] || [ -z "$DOMAIN" ] || APPS_DOMAIN="apps.$DOMAIN"
if [ -n "$APPS_DOMAIN" ]; then
  printf '%s' "$APPS_DOMAIN" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$' ||
    die "bad --apps-domain '$APPS_DOMAIN' (a fully qualified host name)"
  [ "$(printf '%s' "$APPS_DOMAIN" | tr '[:upper:]' '[:lower:]')" != "$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]')" ] ||
    die "--apps-domain must differ from --domain: Apps must never share the console origin"
fi
if [ -n "$EMAIL" ]; then
  printf '%s' "$EMAIL" | grep -Eq '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]+$' || die "bad --email '$EMAIL'"
fi
if [ -n "$PUBLIC_URL" ]; then
  printf '%s' "$PUBLIC_URL" | grep -Eq '^https?://[A-Za-z0-9.:-]+(/[A-Za-z0-9._~/-]*)?$' || die "bad --public-url '$PUBLIC_URL'"
fi
if [ -n "$DEFAULT_PLAN" ]; then
  printf '%s' "$DEFAULT_PLAN" | grep -Eq '^[a-z0-9][a-z0-9_-]*$' || die "bad --default-plan '$DEFAULT_PLAN'"
fi
printf '%s' "$SLUG" | grep -Eq '^[a-z0-9][a-z0-9-]*$' || die "bad RTWEB_SLUG '$SLUG'"
if [ -n "$TARBALL" ]; then
  tb=$(basename "$TARBALL")
  tv=${tb#runtime-web-}
  tv=${tv%.tar.gz}
  { [ "$tb" = "runtime-web-$tv.tar.gz" ] && valid_version "$tv"; } || die "--tarball must be named runtime-web-X.Y.Z.tar.gz (got $tb)"
  [ -z "$VERSION" ] || [ "$VERSION" = "$tv" ] || die "--version $VERSION does not match --tarball $tb"
  VERSION=$tv
  [ "$UNINSTALL" = 1 ] || [ -f "$TARBALL" ] || [ "$DRY_RUN" = 1 ] || die "--tarball $TARBALL: no such file"
  [ -z "$TARBALL_SHA256" ] || printf '%s' "$TARBALL_SHA256" | grep -Eq '^[0-9a-f]{64}$' || die "bad --sha256 (64 hex chars)"
  [ -n "$TARBALL_SHA256" ] || [ "$SKIP_SIG" = 1 ] ||
    die "--tarball is not signature-checked: pass --sha256 HEX or --insecure-skip-signature to install it anyway"
fi
[ "$UNINSTALL" = 1 ] || [ -n "$DOMAIN" ] || die "--domain is required (see --help)"
[ "$UNINSTALL" = 1 ] || [ -n "$EMAIL" ] || die "--email is required: Caddy needs an ACME account e-mail (see --help)"
[ -n "$PUBLIC_URL" ] || PUBLIC_URL="https://$APPS_DOMAIN"
# Fail closed: App code served on the console origin could call /api with an admin's cookies.
lc_domain=$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]')
case "$(printf '%s' "$PUBLIC_URL" | tr '[:upper:]' '[:lower:]')" in
  "https://$lc_domain" | "https://$lc_domain/"* | "https://$lc_domain:443" | "https://$lc_domain:443/"*)
    [ "$UNINSTALL" = 1 ] || die "--public-url must not be the console origin https://$DOMAIN (Apps need their own origin)"
    ;;
esac

[ "$DRY_RUN" = 1 ] && say "dry run: nothing on this host is changed"

# --- platform checks -----------------------------------------------------------------------------------------------
os=$(uname -s)
arch=$(uname -m)
if [ "$(id -u)" -ne 0 ]; then
  if [ "$DRY_RUN" = 1 ]; then say "warning: not root (a real install must run as root)"; else die "run as root (sudo sh install.sh ...)"; fi
fi
case "$os" in
  Linux) ;;
  *)
    if [ "$DRY_RUN" = 1 ]; then say "warning: $os is not supported (Linux only); continuing the dry run"; else die "Linux only (got $os)"; fi
    ;;
esac
case "$arch" in
  x86_64 | amd64) arch=x86_64 ;;
  aarch64 | arm64) arch=aarch64 ;;
  *) die "unsupported architecture $arch (x86_64 or aarch64)" ;;
esac

umask 077

# Environment file of the rt unit (holds RT_ROOT_TOKEN / RT_MASTER_KEY and the rtweb binding secrets).
RT_ENV=/etc/default/rt
[ -d /etc/sysconfig ] && [ ! -d /etc/default ] && RT_ENV=/etc/sysconfig/rt

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

# --- uninstall -----------------------------------------------------------------------------------------------------
if [ "$UNINSTALL" = 1 ]; then
  say "removing $PREFIX, $ETC (secrets, caddy.env), $CADDY_SITE and $CADDY_DROPIN"
  run rm -rf "$PREFIX" "$ETC"
  run rm -f "$CADDY_SITE" "$CADDY_DROPIN"
  rmdir /etc/systemd/system/caddy.service.d 2>/dev/null || true
  if [ "$DRY_RUN" = 1 ]; then
    say "would remove RTWEB_OP_TOKEN / RTWEB_RELAY_SECRET from $RT_ENV, the runtime-web block from $RT_TOML and the import install.sh added to $CADDY_MAIN"
  else
    [ -f "$RT_ENV" ] && drop_env_keys "$RT_ENV" RTWEB_OP_TOKEN RTWEB_RELAY_SECRET
    [ -f "$RT_TOML" ] && strip_block "$RT_TOML"
    [ -f "$CADDY_MAIN" ] && drop_caddy_import "$CADDY_MAIN"
  fi
  if have systemctl; then
    run systemctl daemon-reload
    run systemctl reload caddy || true
    run systemctl restart rt || true
  fi
  cat >&2 <<EOF
rtweb-install: Runtime Web files, secrets, the rtweb plan + bindings and the Caddy site are removed. Left in place:
  - the runtime node (rt), its data, RT_ROOT_TOKEN and the rest of $RT_TOML (backup: $RT_TOML.pre-rtweb)
  - Caddy's certificates and $CADDY_MAIN without the Caddyfile.d import install.sh added (backup: $CADDY_MAIN.pre-rtweb)
  - the runtime tenant 'runtime-web' and service 'rtweb' (delete them with the control API:
    DELETE /v1/tenants/<id> using the root token)
EOF
  exit 0
fi

# --- dependencies --------------------------------------------------------------------------------------------------
need curl
need tar
need awk
if have sha256sum; then
  sha256() { sha256sum "$1" | awk '{print $1}'; }
elif have shasum; then
  sha256() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  die "this installer needs sha256sum or shasum to verify downloads"
fi

if have node; then
  nv=$(node -p 'process.versions.node' 2>/dev/null || echo 0.0.0)
  major=${nv%%.*}
  rest=${nv#*.}
  minor=${rest%%.*}
  if [ "$major" -lt "$NODE_MIN_MAJOR" ] || { [ "$major" -eq "$NODE_MIN_MAJOR" ] && [ "$minor" -lt "$NODE_MIN_MINOR" ]; }; then
    die "node $nv is too old: need >= $NODE_MIN_MAJOR.$NODE_MIN_MINOR (install it from your distribution or nodejs.org)"
  fi
elif [ "$DRY_RUN" = 1 ]; then
  say "warning: node not found (a real install needs node >= $NODE_MIN_MAJOR.$NODE_MIN_MINOR)"
else
  die "node >= $NODE_MIN_MAJOR.$NODE_MIN_MINOR is required to run install.mjs (distribution package or nodejs.org)"
fi

HAVE_COSIGN=0
have cosign && HAVE_COSIGN=1
if [ "$HAVE_COSIGN" = 0 ] && [ "$SKIP_SIG" = 0 ] && [ -z "$TARBALL" ]; then
  if [ "$DRY_RUN" = 1 ]; then
    say "warning: cosign not found (a real install refuses to run without it, unless --insecure-skip-signature)"
  else
    die "cosign is required to verify the release signature (https://docs.sigstore.dev/cosign/system_config/installation/); pass --insecure-skip-signature to install on checksums alone"
  fi
fi

# --- Runtime Web release (first: it also carries deploy/rt.service for the node) -----------------------------------
if [ -z "$VERSION" ]; then
  if [ "$DRY_RUN" = 1 ]; then VERSION=latest; else VERSION=$(latest "$REPO"); fi
fi
tarball="runtime-web-$VERSION.tar.gz"
say "Runtime Web $VERSION"
if [ -n "$TARBALL" ]; then
  say "WARNING: --tarball $TARBALL: a local file, not a signed release"
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
    [ "$DRY_RUN" = 1 ] || say "SHA256SUMS signature verified (Sigstore, $REPO release workflow identity)"
  else
    say "WARNING: --insecure-skip-signature: SHA256SUMS is NOT signature-checked; it only detects corruption"
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

# --- 21 Cloud Runtime node -----------------------------------------------------------------------------------------
if have rt; then
  say "runtime node found: $(rt --version 2>/dev/null || echo rt)"
else
  install_rt
fi

if [ "$DRY_RUN" = 1 ]; then
  say "would ensure $RT_ENV (0600) holds RT_ROOT_TOKEN (generated if absent)"
elif [ ! -f "$RT_ENV" ] || ! grep -Eq '^RT_ROOT_TOKEN(_FILE)?=' "$RT_ENV"; then
  touch "$RT_ENV"
  chmod 0600 "$RT_ENV"
  printf 'RT_ROOT_TOKEN=%s\n' "$(random_hex 32)" >>"$RT_ENV"
  say "generated a root token in $RT_ENV (0600; not printed)"
fi

# --- secrets (0600, root only, never printed) ----------------------------------------------------------------------
run install -d -m 0700 "$ETC"
if [ "$DRY_RUN" = 1 ]; then
  say "would create $ETC/rtweb.env (0600) with RTWEB_RELAY_SECRET (32 random bytes)"
else
  relay=$(read_env RTWEB_RELAY_SECRET "$ETC/rtweb.env")
  if ! valid_secret "$relay"; then
    relay=$(random_hex 32)
    valid_secret "$relay" || die "could not generate RTWEB_RELAY_SECRET"
    printf 'RTWEB_RELAY_SECRET=%s\n' "$relay" >"$ETC/rtweb.env"
    chmod 0600 "$ETC/rtweb.env"
    say "generated $ETC/rtweb.env (0600)"
  fi
  # Older installs kept a random, never-registered RTWEB_OP_TOKEN here; the op token is now derived below.
  drop_env_keys "$ETC/rtweb.env" RTWEB_OP_TOKEN
fi

# --- runtime node config: rtweb plan + bindings, trusted proxy, secrets in the rt environment ----------------------
if [ "$DRY_RUN" = 1 ]; then
  say "would put $APP/deploy/rt.rtweb.toml into $RT_TOML between runtime-web markers (backup $RT_TOML.pre-rtweb)"
  say "would ensure [ingress] trusted_proxies = [\"127.0.0.1/32\", \"::1/128\"] in $RT_TOML (Caddy on loopback)"
  say "would set RTWEB_OP_TOKEN=\"Bearer <root token>\" and RTWEB_RELAY_SECRET in $RT_ENV and restart rt"
else
  [ -f "$RT_TOML" ] && [ ! -f "$RT_TOML.pre-rtweb" ] && cp -p "$RT_TOML" "$RT_TOML.pre-rtweb"
  [ -f "$RT_TOML" ] && strip_block "$RT_TOML"
  { printf '\n%s\n' "$BLOCK_BEGIN"; cat "$APP/deploy/rt.rtweb.toml"; printf '%s\n' "$BLOCK_END"; } >>"$RT_TOML"
  chmod 0644 "$RT_TOML"
  say "wrote the rtweb plan and bindings to $RT_TOML"
  ensure_trusted_proxies "$RT_TOML"
  # The runtime has one operator credential, the root token; inject_headers sends the value verbatim.
  op="Bearer $(root_token)"
  set_env_key "$RT_ENV" RTWEB_OP_TOKEN "\"$op\""
  set_env_key "$RT_ENV" RTWEB_RELAY_SECRET "$relay"
  unset op
  chmod 0600 "$RT_ENV"
fi
if have systemctl; then
  run systemctl daemon-reload
  run systemctl enable rt
  run systemctl restart rt
fi
if [ "$DRY_RUN" = 0 ]; then
  i=0
  until curl -fsS http://127.0.0.1:9090/readyz >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -le 60 ] || die "rt did not become ready (journalctl -u rt)"
    sleep 1
  done
fi

# --- Caddy: relay + console host + on-demand TLS restricted by the ask endpoint ------------------------------------
if have caddy; then
  run install -d -m 0755 /etc/caddy/Caddyfile.d
  run install -m 0644 "$APP/deploy/Caddyfile" "$CADDY_SITE"
  if [ "$DRY_RUN" = 1 ]; then
    say "would write $ETC/caddy.env (0600: RTWEB_DOMAIN=$DOMAIN, RTWEB_APPS_DOMAIN=$APPS_DOMAIN, RTWEB_ACME_EMAIL, RTWEB_SLUG=$SLUG, RTWEB_RELAY_SECRET) for caddy and import $CADDY_SITE"
  else
    caddy_import "$CADDY_MAIN"
    # deploy/Caddyfile reads RTWEB_DOMAIN, RTWEB_APPS_DOMAIN, RTWEB_ACME_EMAIL and RTWEB_RELAY_SECRET (the relay's shared secret);
    # systemd loads the 0600 file as root before dropping to the caddy user.
    printf 'RTWEB_DOMAIN=%s\nRTWEB_APPS_DOMAIN=%s\nRTWEB_ACME_EMAIL=%s\nRTWEB_SLUG=%s\nRTWEB_RELAY_SECRET=%s\n' "$DOMAIN" "$APPS_DOMAIN" "$EMAIL" "$SLUG" "$relay" >"$ETC/caddy.env"
    chmod 0600 "$ETC/caddy.env"
    install -d -m 0755 /etc/systemd/system/caddy.service.d
    printf '[Service]\nEnvironmentFile=%s\n' "$ETC/caddy.env" >"$CADDY_DROPIN"
    chmod 0644 "$CADDY_DROPIN"
    # Validate with the same environment Caddy will run with; a broken site must not be (re)started.
    (
      export RTWEB_DOMAIN="$DOMAIN" RTWEB_APPS_DOMAIN="$APPS_DOMAIN" RTWEB_ACME_EMAIL="$EMAIL" RTWEB_SLUG="$SLUG" RTWEB_RELAY_SECRET="$relay"
      caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >"$tmp/caddy-validate.log" 2>&1
    ) || {
      sed 's/^/  /' "$tmp/caddy-validate.log" >&2
      die "caddy validate failed for $CADDY_SITE: Caddy was not restarted"
    }
  fi
  if have systemctl; then
    run systemctl daemon-reload
    run systemctl enable caddy
    run systemctl restart caddy
  fi
else
  say "caddy not found: install it from your distribution (apt/dnf install caddy, or caddyserver.com packages),"
  say "then re-run this script; the site file is $APP/deploy/Caddyfile"
fi
unset relay

# --- deploy the rtweb service (install.mjs is idempotent) ----------------------------------------------------------
if [ "$DRY_RUN" = 1 ]; then
  say "would run: node $APP/server/scripts/install.mjs (RT_ROOT_TOKEN from $RT_ENV via the environment, RTWEB_ORIGIN=https://$DOMAIN, RTWEB_HOST=$DOMAIN, RTWEB_RUNTIME_PUBLIC_URL=$PUBLIC_URL${DEFAULT_PLAN:+, RTWEB_DEFAULT_PLAN=$DEFAULT_PLAN})"
else
  # The token goes through the environment of one child process only: never argv, never the terminal.
  (
    RT_ROOT_TOKEN=$(root_token)
    export RT_ROOT_TOKEN
    RTWEB_SLUG="$SLUG" RTWEB_ORIGIN="https://$DOMAIN" RTWEB_HOST="$DOMAIN" RTWEB_RUNTIME_PUBLIC_URL="$PUBLIC_URL" \
      RTWEB_DEFAULT_PLAN="$DEFAULT_PLAN" RTWEB_VERSION="$VERSION" \
      node "$APP/server/scripts/install.mjs"
  ) || die "install.mjs failed (re-run is safe: it is idempotent)"
fi

done_msg="is installed"
[ "$DRY_RUN" = 1 ] && done_msg="would be installed (dry run)"
cat >&2 <<EOF

Runtime Web $VERSION $done_msg.

  DNS:              $DOMAIN (console) and $APPS_DOMAIN (Apps) must both point at this host
  First-run setup:  https://$DOMAIN/setup
                    (use the setup token install.mjs printed above; it works once)

Firewall: allow inbound 80/tcp and 443/tcp (Caddy) only. Keep the runtime's control API (8081), invoke
listener (8080) and metrics (9090) on loopback; do not expose them. For example:
  ufw allow 80,443/tcp        or   firewall-cmd --add-service=http --add-service=https --permanent

Secrets: $RT_ENV, $ETC/rtweb.env and $ETC/caddy.env (mode 0600, root). Back them up; never commit them.
Uninstall: sh install.sh --uninstall
EOF
}

# ===================================================================================================================
# helpers (defined before main runs; they read main's variables at call time)

say() { printf '%s\n' "rtweb-install: $*" >&2; }
die() {
  say "error: $*"
  exit 1
}
have() { command -v "$1" >/dev/null 2>&1; }
need() { have "$1" || die "this installer needs '$1' on PATH"; }

# run CMD...: execute, or print in --dry-run. Never pass secrets as arguments (they would be printed here).
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '  [dry-run] %s\n' "$*" >&2
  else
    "$@"
  fi
}

usage() {
  cat <<'EOF'
usage: install.sh --domain HOST --email ADDR [--apps-domain HOST] [--public-url URL] [--default-plan NAME] [--version X.Y.Z] [--runtime-version X.Y.Z]
                  [--tarball PATH [--sha256 HEX]] [--insecure-skip-signature] [--dry-run] | --uninstall [--dry-run]

Installs Runtime Web as an App on a 21 Cloud Runtime node and puts Caddy with on-demand TLS in front of it.
The release's SHA256SUMS must carry a valid Sigstore signature from the release workflow (needs cosign), and the
runtime node is installed from a pinned, checksum-verified release.
EOF
}

valid_version() { printf '%s' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; }
valid_secret() { printf '%s' "$1" | grep -Eq '^[0-9a-f]{64}$'; }

# random_hex N: N random bytes as hex, from the kernel CSPRNG.
random_hex() {
  if have openssl; then
    openssl rand -hex "$1"
  else
    od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'
  fi
}

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
    printf '  [dry-run] curl %s -> %s\n' "$1" "$2" >&2
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
    say "would verify sha256($3) against SHA256SUMS"
    return 0
  fi
  want=$(awk -v f="$3" '$2 == f || $2 == "*"f {print $1}' "$1")
  [ -n "$want" ] || die "$3 is not listed in SHA256SUMS"
  got=$(sha256 "$2")
  [ "$want" = "$got" ] || die "checksum mismatch for $3: refusing to install"
  say "checksum ok: $3"
}

# install_rt: the rt binary from its GitHub release tarball, the production rt.toml from the same tarball, and the
# unit from this (already verified) Runtime Web release. Never runs a script downloaded from the runtime repository.
install_rt() {
  target="$arch-unknown-linux-gnu"
  name="rt-$RT_VERSION-$target"
  url="$RT_BASE_URL/v$RT_VERSION"
  say "installing the runtime node rt $RT_VERSION ($target) from $RT_REPO release assets"
  mkdir -p "$tmp/rt"
  fetch "$url/SHA256SUMS" "$tmp/rt/SHA256SUMS"
  fetch "$url/$name.tar.gz" "$tmp/rt/$name.tar.gz"
  if [ "$RT_VERSION" = "$RT_PINNED_VERSION" ]; then
    if [ "$DRY_RUN" = 1 ]; then
      say "would check sha256(SHA256SUMS) == pinned $RT_PINNED_SUMS_SHA256"
    else
      [ "$(sha256 "$tmp/rt/SHA256SUMS")" = "$RT_PINNED_SUMS_SHA256" ] ||
        die "runtime SHA256SUMS does not match the checksum pinned in install.sh: refusing to install"
      case "$arch" in
        x86_64) pinned=$RT_PINNED_X86_64_SHA256 ;;
        *) pinned=$RT_PINNED_AARCH64_SHA256 ;;
      esac
      [ "$(sha256 "$tmp/rt/$name.tar.gz")" = "$pinned" ] || die "checksum mismatch for $name.tar.gz: refusing to install"
    fi
    [ "$DRY_RUN" = 1 ] || say "runtime SHA256SUMS matches the pinned checksum"
  elif [ "$HAVE_COSIGN" = 0 ] && [ "$DRY_RUN" = 0 ]; then
    die "--runtime-version $RT_VERSION is not the pinned $RT_PINNED_VERSION: verifying it needs cosign"
  fi
  if [ "$HAVE_COSIGN" = 1 ] || [ "$DRY_RUN" = 1 ]; then
    fetch "$url/SHA256SUMS.sigstore.json" "$tmp/rt/SHA256SUMS.sigstore.json"
    verify_sums "$tmp/rt/SHA256SUMS" "$RT_CERT_IDENTITY_REGEXP" || die "cosign could not verify the runtime SHA256SUMS"
    [ "$DRY_RUN" = 1 ] || say "runtime SHA256SUMS signature verified (Sigstore, $RT_REPO release workflow identity)"
  fi
  check_sum "$tmp/rt/SHA256SUMS" "$tmp/rt/$name.tar.gz" "$name.tar.gz"
  run tar -xzf "$tmp/rt/$name.tar.gz" -C "$tmp/rt" --no-same-owner
  run install -m 0755 "$tmp/rt/$name/rt" /usr/bin/rt
  if [ "$DRY_RUN" = 0 ] && ! id rt >/dev/null 2>&1; then
    useradd --system --user-group --home-dir /var/lib/rt --no-create-home --shell /usr/sbin/nologin rt
  fi
  run install -d -m 0755 /etc/rt
  run install -d -m 0750 /var/lib/rt
  if [ "$DRY_RUN" = 1 ]; then
    run chown rt:rt /var/lib/rt
  else
    chown rt:rt /var/lib/rt
  fi
  if [ ! -f "$RT_TOML" ]; then run install -m 0644 "$tmp/rt/$name/defconfigs/production.toml" "$RT_TOML"; fi
  run install -m 0644 "$APP/deploy/rt.service" /etc/systemd/system/rt.service
}

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
strip_block() {
  awk -v b="$BLOCK_BEGIN" -v e="$BLOCK_END" -v l="$LEGACY_MARK" '
    $0 == b { skip = 1; next }
    $0 == e { skip = 0; next }
    $0 == l { legacy = 1 }
    !skip && !legacy { print }
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
  say "ingress.trusted_proxies covers loopback (client IPs come from Caddy's X-Forwarded-For)"
}

main "$@"

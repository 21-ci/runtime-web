#!/bin/sh
# Install Runtime Web (the 21 Cloud console) on a Linux host, as an App on a 21 Cloud Runtime node.
#
#   curl -fsSL https://raw.githubusercontent.com/21-ci/runtime-web/main/install.sh | sudo sh -s -- --domain console.example.com --email ops@example.com
#
# Options:
#   --version X.Y.Z        Runtime Web release (default: the latest)
#   --domain HOST          console host name, served by Caddy with automatic TLS (required to install)
#   --email ADDR           ACME account e-mail for Caddy (recommended)
#   --runtime-version X    21 Cloud Runtime release to install when `rt` is missing (default: the latest)
#   --verify-signature     require cosign verification of SHA256SUMS (default: verify when cosign is on PATH)
#   --dry-run              print every step instead of changing the host (needs no root, no network)
#   --uninstall            remove Runtime Web files, secrets and the Caddy site (the runtime node is left alone)
#   -h, --help
#
# What it does (docs/design/backend-on-runtime.md section 5):
#   1. checks root, Linux, x86_64/aarch64, curl, tar, sha256sum|shasum, node >= 22.5
#   2. installs the runtime node (rt) with its own installer, pinned to a release tag, when it is not on PATH
#   3. downloads runtime-web-<ver>.tar.gz + SHA256SUMS (+ Sigstore bundle), verifies them, unpacks to /opt/runtime-web
#   4. generates RTWEB_OP_TOKEN / RTWEB_RELAY_SECRET (0600, never printed), adds the rtweb plan + bindings
#      (deploy/rt.rtweb.toml) to /etc/rt/rt.toml and restarts rt
#   5. installs the Caddy site (deploy/Caddyfile: relay + console host + on-demand TLS gated by an `ask` endpoint)
#   6. runs server/scripts/install.mjs with the node's root token read from the rt environment file
#   7. prints the first-run setup URL and firewall hints
#
# Environment: RTWEB_INSTALL_REPO (default 21-ci/runtime-web), RTWEB_INSTALL_BASE_URL (release download mirror),
# RT_INSTALL_REPO (default 21-ci/runtime), GITHUB_TOKEN (optional, for the latest-version lookup).
set -eu

REPO=${RTWEB_INSTALL_REPO:-21-ci/runtime-web}
BASE_URL=${RTWEB_INSTALL_BASE_URL:-https://github.com/$REPO/releases/download}
RT_REPO=${RT_INSTALL_REPO:-21-ci/runtime}
CERT_IDENTITY_REGEXP="^https://github\.com/$REPO/\.github/workflows/release\.yml@refs/tags/v"
CERT_OIDC_ISSUER=https://token.actions.githubusercontent.com

PREFIX=/opt/runtime-web
ETC=/etc/rtweb
RT_TOML=/etc/rt/rt.toml
CADDY_SITE=/etc/caddy/Caddyfile.d/rtweb.caddy
NODE_MIN_MAJOR=22
NODE_MIN_MINOR=5

VERSION=""
RT_VERSION=""
DOMAIN=""
EMAIL=""
DRY_RUN=0
UNINSTALL=0
VERIFY_SIG=auto

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
usage: install.sh --domain HOST [--email ADDR] [--version X.Y.Z] [--runtime-version X.Y.Z]
                  [--verify-signature] [--dry-run] | --uninstall [--dry-run]

Installs Runtime Web as an App on a 21 Cloud Runtime node, verifying the release checksums (and their Sigstore
signature when cosign is on PATH), and puts Caddy with on-demand TLS in front of it.
EOF
}

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
    --email)
      [ "$#" -ge 2 ] || die "--email needs an address"
      EMAIL=$2
      shift 2
      ;;
    --verify-signature)
      VERIFY_SIG=yes
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
valid_version() { printf '%s' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; }
[ -z "$VERSION" ] || valid_version "$VERSION" || die "bad --version '$VERSION'"
[ -z "$RT_VERSION" ] || valid_version "$RT_VERSION" || die "bad --runtime-version '$RT_VERSION'"
if [ -n "$DOMAIN" ]; then
  printf '%s' "$DOMAIN" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$' ||
    die "bad --domain '$DOMAIN' (a fully qualified host name)"
fi
if [ -n "$EMAIL" ]; then
  printf '%s' "$EMAIL" | grep -Eq '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]+$' || die "bad --email '$EMAIL'"
fi
[ "$UNINSTALL" = 1 ] || [ -n "$DOMAIN" ] || die "--domain is required (see --help)"

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
  x86_64 | amd64 | aarch64 | arm64) ;;
  *) die "unsupported architecture $arch (x86_64 or aarch64)" ;;
esac

umask 077

# --- uninstall -----------------------------------------------------------------------------------------------------
if [ "$UNINSTALL" = 1 ]; then
  say "removing $PREFIX, $ETC and $CADDY_SITE"
  run rm -rf "$PREFIX" "$ETC"
  run rm -f "$CADDY_SITE"
  if have systemctl; then run systemctl reload caddy || true; fi
  cat >&2 <<EOF
rtweb-install: Runtime Web files are removed. Left in place on purpose:
  - the runtime node (rt), its data and /etc/rt/rt.toml (remove the [plans.rtweb] block and the rtweb
    [[binding]] entries by hand; a backup of the pre-install file is $RT_TOML.pre-rtweb)
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

# random_hex N: N random bytes as hex, from the kernel CSPRNG.
random_hex() {
  if have openssl; then
    openssl rand -hex "$1"
  else
    od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'
  fi
}

latest() { # latest OWNER/REPO -> X.Y.Z
  auth=""
  [ -n "${GITHUB_TOKEN:-}" ] && auth="Authorization: Bearer $GITHUB_TOKEN"
  v=$(curl -fsSL ${auth:+-H "$auth"} "https://api.github.com/repos/$1/releases/latest" |
    sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -n1)
  valid_version "$v" || die "could not find the latest release of $1 (pass --version)"
  printf '%s' "$v"
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

# fetch URL FILE: download over https only, retries, fail on HTTP errors.
fetch() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '  [dry-run] curl %s -> %s\n' "$1" "$2" >&2
    return 0
  fi
  curl --proto '=https' --tlsv1.2 -fsSL --retry 3 -o "$2" "$1"
}

# --- 21 Cloud Runtime node -----------------------------------------------------------------------------------------
if have rt; then
  say "runtime node found: $(rt --version 2>/dev/null || echo rt)"
else
  if [ -z "$RT_VERSION" ]; then
    if [ "$DRY_RUN" = 1 ]; then RT_VERSION=latest; else RT_VERSION=$(latest "$RT_REPO"); fi
  fi
  say "installing the runtime node rt $RT_VERSION (its installer verifies SHA256SUMS and, with cosign, the signature)"
  # The installer is taken from the release tag, not a moving branch, and run from a file (never curl | sh).
  ref=v$RT_VERSION
  [ "$RT_VERSION" = latest ] && ref=main
  fetch "https://raw.githubusercontent.com/$RT_REPO/$ref/packaging/install.sh" "$tmp/rt-install.sh"
  fetch "https://raw.githubusercontent.com/$RT_REPO/$ref/packaging/systemd/rt.service" "$tmp/rt.service"
  fetch "https://raw.githubusercontent.com/$RT_REPO/$ref/deploy/rt.toml" "$tmp/rt.toml"
  sig_flag=""
  [ "$VERIFY_SIG" = yes ] && sig_flag=--verify-signature
  run sh "$tmp/rt-install.sh" --only rt --version "$RT_VERSION" --bin-dir /usr/bin $sig_flag
  run install -d -m 0755 /etc/rt
  run install -d -m 0750 /var/lib/rt
  if [ ! -f "$RT_TOML" ]; then run install -m 0644 "$tmp/rt.toml" "$RT_TOML"; fi
  run install -m 0644 "$tmp/rt.service" /etc/systemd/system/rt.service
fi

# Environment file of the rt unit (holds RT_ROOT_TOKEN / RT_MASTER_KEY); created 0600 with a fresh root token.
RT_ENV=/etc/default/rt
[ -d /etc/sysconfig ] && [ ! -d /etc/default ] && RT_ENV=/etc/sysconfig/rt
if [ "$DRY_RUN" = 1 ]; then
  say "would ensure $RT_ENV (0600) holds RT_ROOT_TOKEN (generated if absent)"
elif [ ! -f "$RT_ENV" ] || ! grep -Eq '^RT_ROOT_TOKEN(_FILE)?=' "$RT_ENV"; then
  touch "$RT_ENV"
  chmod 0600 "$RT_ENV"
  printf 'RT_ROOT_TOKEN=%s\n' "$(random_hex 32)" >>"$RT_ENV"
  say "generated a root token in $RT_ENV (0600; not printed)"
fi

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

# --- Runtime Web release -------------------------------------------------------------------------------------------
if [ -z "$VERSION" ]; then
  if [ "$DRY_RUN" = 1 ]; then VERSION=latest; else VERSION=$(latest "$REPO"); fi
fi
tarball="runtime-web-$VERSION.tar.gz"
say "Runtime Web $VERSION"
fetch "$BASE_URL/v$VERSION/SHA256SUMS" "$tmp/SHA256SUMS"
fetch "$BASE_URL/v$VERSION/$tarball" "$tmp/$tarball"

if [ "$VERIFY_SIG" != no ] && { have cosign || [ "$VERIFY_SIG" = yes ]; }; then
  have cosign || die "--verify-signature needs cosign on PATH (https://docs.sigstore.dev/cosign/system_config/installation/)"
  fetch "$BASE_URL/v$VERSION/SHA256SUMS.sigstore.json" "$tmp/SHA256SUMS.sigstore.json"
  run cosign verify-blob --bundle "$tmp/SHA256SUMS.sigstore.json" \
    --certificate-identity-regexp "$CERT_IDENTITY_REGEXP" --certificate-oidc-issuer "$CERT_OIDC_ISSUER" \
    "$tmp/SHA256SUMS" || die "cosign could not verify SHA256SUMS: refusing to install"
  say "SHA256SUMS signature verified (Sigstore, release workflow identity)"
else
  say "cosign not found: verifying checksums only (install cosign to also verify the signature)"
fi

if [ "$DRY_RUN" = 1 ]; then
  say "would verify sha256($tarball) against SHA256SUMS"
else
  want=$(awk -v f="$tarball" '$2 == f || $2 == "*"f {print $1}' "$tmp/SHA256SUMS")
  [ -n "$want" ] || die "$tarball is not listed in SHA256SUMS"
  got=$(sha256 "$tmp/$tarball")
  [ "$want" = "$got" ] || die "checksum mismatch for $tarball: refusing to install"
  say "checksum ok"
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

# --- secrets (0600, root only, never printed) ----------------------------------------------------------------------
run install -d -m 0700 "$ETC"
if [ "$DRY_RUN" = 1 ]; then
  say "would create $ETC/rtweb.env (0600) with RTWEB_OP_TOKEN and RTWEB_RELAY_SECRET (32 random bytes each)"
elif [ ! -f "$ETC/rtweb.env" ]; then
  {
    printf 'RTWEB_OP_TOKEN=%s\n' "$(random_hex 32)"
    printf 'RTWEB_RELAY_SECRET=%s\n' "$(random_hex 32)"
  } >"$ETC/rtweb.env"
  chmod 0600 "$ETC/rtweb.env"
  say "generated $ETC/rtweb.env (0600)"
fi

# --- runtime node config: rtweb plan + bindings, secrets in the rt environment -------------------------------------
if [ "$DRY_RUN" = 1 ]; then
  say "would append $APP/deploy/rt.rtweb.toml to $RT_TOML (backup $RT_TOML.pre-rtweb) unless [plans.rtweb] exists"
  say "would add RTWEB_OP_TOKEN / RTWEB_RELAY_SECRET to $RT_ENV and restart rt"
else
  if ! grep -q '^\[plans\.rtweb\]' "$RT_TOML" 2>/dev/null; then
    [ -f "$RT_TOML" ] && cp -p "$RT_TOML" "$RT_TOML.pre-rtweb"
    { printf '\n# --- added by runtime-web install.sh ---\n'; cat "$APP/deploy/rt.rtweb.toml"; } >>"$RT_TOML"
    say "added the rtweb plan and bindings to $RT_TOML"
  fi
  for k in RTWEB_OP_TOKEN RTWEB_RELAY_SECRET; do
    if ! grep -q "^$k=" "$RT_ENV"; then grep "^$k=" "$ETC/rtweb.env" >>"$RT_ENV"; fi
  done
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
    say "would set RTWEB_DOMAIN / RTWEB_ACME_EMAIL for caddy (systemd drop-in) and import $CADDY_SITE"
  else
    grep -q 'Caddyfile.d/' /etc/caddy/Caddyfile 2>/dev/null ||
      printf '\nimport /etc/caddy/Caddyfile.d/*.caddy\n' >>/etc/caddy/Caddyfile
    install -d -m 0755 /etc/systemd/system/caddy.service.d
    printf '[Service]\nEnvironment=RTWEB_DOMAIN=%s\nEnvironment=RTWEB_ACME_EMAIL=%s\n' "$DOMAIN" "$EMAIL" \
      >/etc/systemd/system/caddy.service.d/rtweb.conf
    chmod 0644 /etc/systemd/system/caddy.service.d/rtweb.conf
    caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 ||
      say "warning: caddy validate failed; check $CADDY_SITE"
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

# --- deploy the rtweb service (install.mjs is idempotent) ----------------------------------------------------------
if [ "$DRY_RUN" = 1 ]; then
  say "would run: node $APP/server/scripts/install.mjs (RT_ROOT_TOKEN from $RT_ENV via the environment, RTWEB_ORIGIN=https://$DOMAIN)"
else
  # The token goes through the environment of one child process only: never argv, never the terminal.
  (
    RT_ROOT_TOKEN=$(root_token)
    export RT_ROOT_TOKEN
    set -a
    # shellcheck disable=SC1091
    . "$ETC/rtweb.env"
    set +a
    RTWEB_ORIGIN="https://$DOMAIN" RTWEB_DOMAIN="$DOMAIN" RTWEB_VERSION="$VERSION" \
      node "$APP/server/scripts/install.mjs"
  ) || die "install.mjs failed (re-run is safe: it is idempotent)"
fi

done_msg="is installed"
[ "$DRY_RUN" = 1 ] && done_msg="would be installed (dry run)"
cat >&2 <<EOF

Runtime Web $VERSION $done_msg.

  First-run setup:  https://$DOMAIN/setup
                    (use the setup token install.mjs printed above; it works once)

Firewall: allow inbound 80/tcp and 443/tcp (Caddy) only. Keep the runtime's control API (8081), invoke
listener (8080) and metrics (9090) on loopback; do not expose them. For example:
  ufw allow 80,443/tcp        or   firewall-cmd --add-service=http --add-service=https --permanent

Secrets: $RT_ENV and $ETC/rtweb.env (mode 0600, root). Back them up; never commit them.
Uninstall: sh install.sh --uninstall
EOF

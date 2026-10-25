#!/usr/bin/env bash
# Local CI: the checks of .github/workflows/ci.yml and security.yml, run on this machine.
# Every step runs even when an earlier one fails; a summary at the end lists what failed and the
# script exits non-zero if anything did.
#
#   scripts/ci-local.sh              everything (build, lint, i18n, coverage, budgets, shell, workflows, docs, security)
#   scripts/ci-local.sh --fast       skip coverage (plain tests), docs and CodeQL
#   scripts/ci-local.sh --security   only npm audit, Trivy, CodeQL, gitleaks, semgrep and osv-scanner
#
# Tools: node/npm (required); go, hadolint, docker buildx, shellcheck, actionlint, zizmor, mkdocs (or .venv /
# docs/requirements.txt), trivy, codeql,
# gitleaks, semgrep and osv-scanner are used when installed and reported as SKIP otherwise. Logs go to .ci-local/<step>.log.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOGS="$ROOT/.ci-local"
mkdir -p "$LOGS"
cd "$ROOT" || exit 1

FAST=0
ONLY_SECURITY=0
for arg in "$@"; do
  case "$arg" in
    --fast) FAST=1 ;;
    --security) ONLY_SECURITY=1 ;;
    -h | --help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

# Same scan scope as security.yml.
TRIVY_SKIP="node_modules,web/node_modules,server/node_modules,site,.ci-local,.venv"

PASSED=()
FAILED=()
SKIPPED=()

# step NAME CMD... runs CMD with its output in $LOGS/NAME.log and records the result.
step() {
  local name=$1
  shift
  local start=$SECONDS
  printf '%-28s' "$name"
  if "$@" >"$LOGS/$name.log" 2>&1; then
    printf 'PASS  %3ss\n' $((SECONDS - start))
    PASSED+=("$name")
  else
    printf 'FAIL  %3ss  (%s)\n' $((SECONDS - start)) ".ci-local/$name.log"
    FAILED+=("$name")
  fi
}

skip() {
  printf '%-28sSKIP  %s\n' "$1" "$2"
  SKIPPED+=("$1")
}

have() { command -v "$1" >/dev/null 2>&1; }

web_deps() { [ -d web/node_modules ] || (cd web && npm ci --ignore-scripts); }
server_deps() { [ -d server/node_modules ] || (cd server && npm ci --ignore-scripts); }

mkdocs_bin() {
  if have mkdocs; then echo mkdocs
  elif [ -x .venv/bin/mkdocs ]; then echo .venv/bin/mkdocs
  fi
}

# The inline JavaScript uses template literals, not shell expansions.
# shellcheck disable=SC2016
# CodeQL scans an export of HEAD (what CI checks out), not the working tree with its node_modules,
# dist and coverage output. Uncommitted changes are therefore not scanned.
run_codeql() {
  local db="$LOGS/codeql-db" src="$LOGS/codeql-src"
  rm -rf "$db" "$src"
  mkdir -p "$src"
  git archive HEAD | tar -x -C "$src" &&
    codeql database create "$db" --language=javascript-typescript --source-root="$src" \
      --build-mode=none --codescanning-config=.github/codeql/codeql-config.yml --overwrite &&
    codeql database analyze "$db" codeql/javascript-queries:codeql-suites/javascript-security-extended.qls \
      --download --format=sarif-latest --output="$LOGS/codeql.sarif" &&
    node -e '
      const fs = require("fs");
      const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).runs[0];
      const accepted = new Set(
        fs.readFileSync(".github/codeql/accepted.txt", "utf8").split("\n")
          .map((l) => l.replace(/#.*/, "").trim()).filter(Boolean)
          .map((l) => l.split(/\s+/).slice(0, 2).join(" ")),
      );
      const uri = (x) => x.locations?.[0]?.physicalLocation?.artifactLocation?.uri ?? "";
      const hits = r.results.filter((x) => !uri(x).includes("/gen/") && !accepted.has(`${x.ruleId} ${uri(x)}`));
      for (const x of hits) {
        const l = x.locations[0].physicalLocation;
        console.log(`${x.ruleId}  ${l.artifactLocation.uri}:${l.region?.startLine}  ${x.message.text.split("\n")[0]}`);
      }
      console.log(`${hits.length} result(s)`);
      process.exit(hits.length ? 1 : 0);
    ' "$LOGS/codeql.sarif"
}

if [ $ONLY_SECURITY -eq 0 ]; then
  echo "== build and tests"
  step web-deps web_deps
  step server-deps server_deps
  step web-lint sh -c 'cd web && npm run lint'
  step web-i18n sh -c 'cd web && npm run i18n:check'
  step web-typecheck sh -c 'cd web && npx tsc --noEmit'
  if [ $FAST -eq 1 ]; then
    step web-test sh -c 'cd web && npx vitest run --maxWorkers=2'
  else
    step web-coverage sh -c 'cd web && npm run coverage'
  fi
  step web-build sh -c 'cd web && npm run build'
  step budget sh -c 'node --test scripts/budget-measure.test.js && scripts/budget.sh'
  step server-lint sh -c 'cd server && npm run lint'
  step server-typecheck sh -c 'cd server && npm run typecheck'
  if [ $FAST -eq 1 ]; then
    step server-test sh -c 'cd server && npm test'
  else
    step server-coverage sh -c 'cd server && npm run coverage'
  fi

  echo "== installer"
  if have shellcheck; then
    step shellcheck sh -c 'shellcheck -s sh install.sh && shellcheck scripts/*.sh'
  else
    skip shellcheck "shellcheck not installed"
  fi
  step install-dry-run sh install.sh --dry-run --version 0.0.0 --domain console.example.com --email ops@acme-corp.dev

  echo "== container image"
  if have go; then
    step entry-test sh -c 'cd docker/entry && go vet ./... && go test ./...'
  else
    skip entry-test "go not installed (docker/entry; the image build runs these tests too)"
  fi
  if have hadolint; then
    step hadolint hadolint Dockerfile
  else
    skip hadolint "hadolint not installed (brew install hadolint)"
  fi
  if [ $FAST -eq 1 ]; then
    skip docker-build "--fast"
  elif have docker && docker buildx version >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    # Native platform only (no emulation); docker.yml builds both platforms. Trivy gates the result when installed.
    # "$t" expands inside sh -c, not here.
    # shellcheck disable=SC2016
    step docker-build sh -c 'for t in distroless slim; do docker buildx build --target "$t" -t "runtime-web:ci-local-$t" --load . || exit 1; done'
    if have trivy; then
      # shellcheck disable=SC2016
      step docker-trivy sh -c 'for t in distroless slim; do trivy image --quiet --scanners vuln,secret --severity HIGH,CRITICAL --ignore-unfixed --ignorefile .trivyignore --exit-code 1 "runtime-web:ci-local-$t" || exit 1; done'
    else
      skip docker-trivy "trivy not installed (brew install trivy)"
    fi
  else
    skip docker-build "docker with buildx not available"
  fi

  echo "== workflows"
  if have actionlint; then
    step actionlint actionlint
  else
    skip actionlint "actionlint not installed (brew install actionlint)"
  fi
  if have zizmor; then
    step zizmor zizmor --min-severity medium .github/workflows
  else
    skip zizmor "zizmor not installed (brew install zizmor)"
  fi

  echo "== docs"
  if [ $FAST -eq 1 ]; then
    skip mkdocs "--fast"
  elif [ -n "$(mkdocs_bin)" ]; then
    step mkdocs "$(mkdocs_bin)" build --strict --site-dir "$LOGS/site"
  else
    skip mkdocs "mkdocs not installed (python3 -m venv .venv && .venv/bin/pip install -r docs/requirements.txt)"
  fi
fi

echo "== security"
step npm-audit-web-prod sh -c 'cd web && npm audit --omit=dev --audit-level=high'
step npm-audit-web-all sh -c 'cd web && npm audit --audit-level=high'
step npm-audit-server-prod sh -c 'cd server && npm audit --omit=dev --audit-level=high'
step npm-audit-server-all sh -c 'cd server && npm audit --audit-level=high'
if have trivy; then
  # The gate CI enforces, then a full report of every severity for reading.
  step trivy sh -c "trivy fs --scanners vuln,secret,misconfig --ignorefile .trivyignore --skip-dirs $TRIVY_SKIP \
    --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 . && \
    trivy fs --scanners vuln,secret,misconfig --ignorefile .trivyignore --skip-dirs $TRIVY_SKIP \
    --format table --output '$LOGS/trivy-all.txt' ."
else
  skip trivy "trivy not installed (brew install trivy)"
fi
if [ $FAST -eq 1 ]; then
  skip codeql "--fast"
elif have codeql; then
  step codeql run_codeql
else
  skip codeql "codeql not installed (brew install --cask codeql)"
fi
if have gitleaks; then
  # Full history, as security.yml; .gitleaksignore holds the reviewed false positives.
  step gitleaks gitleaks git --redact --no-banner .
else
  skip gitleaks "gitleaks not installed (brew install gitleaks)"
fi
if have semgrep; then
  # Blocks on ERROR only, as security.yml; .semgrepignore excludes the test files.
  step semgrep env SEMGREP_SEND_METRICS=off semgrep scan --metrics=off \
    --config p/typescript --config p/javascript --config p/react --config p/nodejsscan \
    --config p/secrets --config p/github-actions --severity ERROR --error .
else
  skip semgrep "semgrep not installed (brew install semgrep)"
fi
if have osv-scanner; then
  step osv-scanner osv-scanner scan --lockfile web/package-lock.json --lockfile server/package-lock.json
else
  skip osv-scanner "osv-scanner not installed (brew install osv-scanner)"
fi

echo
echo "passed: ${#PASSED[@]}  failed: ${#FAILED[@]}  skipped: ${#SKIPPED[@]}"
if [ ${#FAILED[@]} -gt 0 ]; then
  echo "failed: ${FAILED[*]}"
  exit 1
fi

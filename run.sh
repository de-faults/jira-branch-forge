#!/usr/bin/env bash
# One command to bring the whole thing up: preflight, deps, build, serve.
#
#   ./run.sh          production-ish — build the UI, serve everything on one port
#   ./run.sh dev      hot-reload — API on $PORT, Vite on 5173
#   ./run.sh check    preflight only, change nothing
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

MODE="${1:-prod}"
PORT="${PORT:-4178}"

bold=$'\033[1m'; dim=$'\033[2m'; red=$'\033[31m'; grn=$'\033[32m'; ylw=$'\033[33m'; rst=$'\033[0m'
ok()   { printf '  %s✓%s %s\n' "$grn" "$rst" "$1"; }
warn() { printf '  %s!%s %s\n' "$ylw" "$rst" "$1"; }
die()  { printf '  %s✗%s %s\n' "$red" "$rst" "$1" >&2; exit 1; }
step() { printf '\n%s%s%s\n' "$bold" "$1" "$rst"; }

# --- 1. toolchain -----------------------------------------------------------
step "Preflight"

command -v node >/dev/null || die "node not found. Install Node.js 20 or newer."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "node $(node -v) is too old — this app needs 20 or newer."
ok "node $(node -v)"

command -v npm >/dev/null || die "npm not found."

if command -v gh >/dev/null; then
  ok "gh $(gh --version | head -1 | awk '{print $3}')"
  if GH_USER="$(gh api user --jq .login 2>/dev/null)"; then
    ok "gh authenticated as ${bold}${GH_USER}${rst}"
    # A fine-grained token reports no scopes at all, so only warn when gh
    # printed a scope list and 'repo' was not in it.
    GH_STATUS="$(gh auth status 2>&1 || true)"
    if grep -q 'Token scopes' <<<"$GH_STATUS" && ! grep -q "'repo'" <<<"$GH_STATUS"; then
      warn "gh token has no 'repo' scope. Fix: gh auth refresh --scopes \"repo,read:org\""
    fi
  else
    warn "gh is installed but not logged in. Run: gh auth login --scopes \"repo,read:org\""
  fi
else
  warn "gh CLI not found — GitHub features will be unavailable. https://cli.github.com"
fi

# --- 2. configuration -------------------------------------------------------
if [ ! -f .env ]; then
  cp .env.example .env
  warn ".env created from .env.example — fill in JIRA_CLIENT_ID and JIRA_CLIENT_SECRET."
else
  ok ".env present"
fi

# Read the Jira client id without sourcing .env (never execute a config file).
JIRA_ID="$(sed -n 's/^JIRA_CLIENT_ID=\(.*\)$/\1/p' .env | tail -1)"
[ -n "${JIRA_ID//[[:space:]]/}" ] || warn "JIRA_CLIENT_ID is empty in .env — Jira sign-in will be disabled."

# --- 3. port ----------------------------------------------------------------
if command -v lsof >/dev/null && lsof -ti "tcp:$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  HOLDER="$(lsof -ti "tcp:$PORT" -sTCP:LISTEN | head -1)"
  die "port $PORT is in use by PID $HOLDER. Stop it, or run: PORT=$((PORT + 1)) ./run.sh"
fi
ok "port $PORT free"

[ "$MODE" = "check" ] && { printf '\n%sPreflight only — nothing started.%s\n' "$dim" "$rst"; exit 0; }

# --- 4. dependencies --------------------------------------------------------
step "Dependencies"
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules ]; then
  echo "  installing…"
  npm install --no-fund --no-audit
  touch node_modules
  ok "dependencies installed"
else
  ok "up to date"
fi

# --- 5. run -----------------------------------------------------------------
if [ "$MODE" = "dev" ]; then
  step "Starting (dev)"
  printf '  API  http://127.0.0.1:%s\n  UI   %shttp://127.0.0.1:5173%s\n\n' "$PORT" "$bold" "$rst"
  PORT="$PORT" exec npm run dev:all
fi

step "Building UI"
npm run build >/dev/null
ok "dist/ built"

step "Starting"
printf '  %shttp://127.0.0.1:%s%s   %s(loopback only · ctrl-c to stop)%s\n\n' "$bold" "$PORT" "$rst" "$dim" "$rst"
PORT="$PORT" exec node server/index.js

#!/usr/bin/env bash
# forge-delegate installer — register the MCP server with Claude Code, Codex, and/or opencode.
#
# Preferred route: the published npm package (works everywhere, always latest):
#     npx -y forge-delegate setup --model ... --targets ... --scope ...
# If that fails (e.g. package not published yet / offline), this script falls back to a
# repo checkout or clone. From a checkout:        bash install.sh [options...]
# From a pipe:                                    curl -fsSL <raw-url> | bash -s -- [options...]
#
# Options:
#   --model provider/model   default model so calls can omit it
#   --targets a,b,c          hosts to register with: claude,codex,opencode (default all)
#   --scope user|project     registration scope (default user)
#   --project-dir <path>     project for --scope project (default current dir)
#   --no-skill               skip installing the delegate-work skill for Claude Code
#   --no-opencode            skip auto-installing opencode if missing
#   --no-npx                 skip the npx route, force clone/checkout
#   --help
set -euo pipefail

MODEL=""
TARGETS="claude,codex,opencode"
SCOPE="user"
PROJECT_DIR=""
NO_OPENCODE=0
NO_NPX=0
NO_SKILL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model) MODEL="${2:-}"; shift 2 ;;
    --model=*) MODEL="${1#*=}"; shift ;;
    --targets) TARGETS="${2:-}"; shift 2 ;;
    --targets=*) TARGETS="${1#*=}"; shift ;;
    --scope) SCOPE="${2:-}"; shift 2 ;;
    --scope=*) SCOPE="${1#*=}"; shift ;;
    --project-dir) PROJECT_DIR="${2:-}"; shift 2 ;;
    --project-dir=*) PROJECT_DIR="${1#*=}"; shift ;;
    --no-skill) NO_SKILL=1; shift ;;
    --no-opencode) NO_OPENCODE=1; shift ;;
    --no-npx) NO_NPX=1; shift ;;
    --help|-h)
      sed -n '3,19p' "$0"
      exit 0 ;;
    *) echo "unknown option: $1"; exit 1 ;;
  esac
done

if [[ -n "$PROJECT_DIR" ]]; then
  PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd)"
else
  PROJECT_DIR="$PWD"
fi

echo "=== forge-delegate installer ==="

# 1. Requirements
command -v node >/dev/null 2>&1 || { echo "✗ node is required (>=18)"; exit 1; }
if [[ "$NO_OPENCODE" -eq 0 ]] && ! command -v opencode >/dev/null 2>&1; then
  echo "· opencode not found — installing it..."
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL https://opencode.ai/install | bash || true
  fi
  if ! command -v opencode >/dev/null 2>&1 && [[ -x "$HOME/.opencode/bin/opencode" ]]; then
    export PATH="$HOME/.opencode/bin:$PATH"
  fi
  command -v opencode >/dev/null 2>&1 || echo "· opencode still not on PATH — install it from https://opencode.ai and re-run. (Delegations need it.)"
fi

# 2. Build the setup args once, used by both routes
ARGS=(--targets "$TARGETS" --scope "$SCOPE")
if [[ -n "$MODEL" ]]; then ARGS+=(--model "$MODEL"); fi
if [[ "$SCOPE" == "project" ]]; then ARGS+=(--project-dir "$PROJECT_DIR"); fi
if [[ "$NO_SKILL" -eq 1 ]]; then ARGS+=(--no-skill); fi

# 3. Preferred route: published npm package (works on Windows, always latest)
if [[ "$NO_NPX" -eq 0 ]] && command -v npx >/dev/null 2>&1; then
  echo "· installing via npx (published package)..."
  if npx -y forge-delegate setup "${ARGS[@]}"; then
    echo
    echo "Done. Restart your agent, then confirm the server is connected:"
    echo "  Claude Code : /mcp"
    echo "  Codex       : codex mcp"
    echo "  opencode    : opencode"
    echo "Change defaults anytime: forge-delegate config set --model <m>"
    exit 0
  fi
  echo "· npx route unavailable (not published yet?) — falling back to a repo copy..."
fi

# 4. Fallback: local checkout, or clone into place (pipe mode)
SCRIPT_DIR="$(dirname "${BASH_SOURCE[0]}")"
if [[ -f "$SCRIPT_DIR/cli.mjs" ]]; then
  APP_DIR="$SCRIPT_DIR"
  echo "· using local checkout: $APP_DIR"
else
  APP_DIR="${FORGE_DELEGATE_DIR:-$HOME/.local/share/forge-delegate}"
  REPO="${FORGE_DELEGATE_REPO:-https://github.com/MuhamadBarzani/forge-delegate.git}"
  command -v git >/dev/null 2>&1 || { echo "✗ git is required for remote install"; exit 1; }
  echo "· fetching forge-delegate into $APP_DIR"
  if [[ -f "$APP_DIR/cli.mjs" ]]; then
    (cd "$APP_DIR" && git pull --ff-only) || echo "· pull failed — continuing with existing copy"
  else
    mkdir -p "$APP_DIR"
    git clone --depth 1 "$REPO" "$APP_DIR"
  fi
fi

# 5. Install JS deps if not present
if [[ ! -d "$APP_DIR/node_modules" ]]; then
  echo "· installing dependencies..."
  (cd "$APP_DIR" && npm install --silent)
fi

node "$APP_DIR/cli.mjs" setup "${ARGS[@]}"

echo
echo "Done. Restart your agent, then confirm the server is connected:"
echo "  Claude Code : /mcp"
echo "  Codex       : codex mcp"
echo "  opencode    : opencode"
echo "Change defaults anytime: forge-delegate config set --model <m>"
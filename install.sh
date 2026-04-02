#!/bin/sh
set -e

# ---- colors ----
if [ -t 1 ] && [ "${NO_COLOR:-}" = "" ]; then
  BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'
  RED='\033[31m'; GREEN='\033[32m'; YELLOW='\033[33m'; CYAN='\033[36m'
else
  BOLD=''; DIM=''; RESET=''; RED=''; GREEN=''; YELLOW=''; CYAN=''
fi

step() { printf "  ${YELLOW}→${RESET}  %s\n" "$1"; }
ok()   { printf "  ${GREEN}${BOLD}✓${RESET}  %s\n" "$1"; }
info() { printf "  ${DIM}%s${RESET}\n" "$1"; }
fail() { printf "\n  ${RED}${BOLD}✗${RESET}  %s\n\n" "$1" >&2; exit 1; }

# ---- detect platform ----
OS=$(uname -s)
ARCH=$(uname -m)

case "$OS" in
  Darwin)
    # Apple Silicon only; Intel Macs are not supported
    PLATFORM="darwin-arm64"
    ;;
  Linux)
    case "$ARCH" in
      x86_64)          PLATFORM="linux-x64" ;;
      aarch64 | arm64) PLATFORM="linux-arm64" ;;
      *) fail "Unsupported architecture: $ARCH" ;;
    esac
    ;;
  *)
    fail "Unsupported OS: $OS — Windows users please run this script inside WSL"
    ;;
esac

# ---- install ----
# REPO is replaced with the actual owner/repo by the release CI workflow.
REPO="__REPO__"
case "$REPO" in
  */*) ;; # valid owner/repo
  *) fail "REPO placeholder was not replaced — this installer is broken" ;;
esac
URL="https://github.com/${REPO}/releases/latest/download/wsh-${PLATFORM}"
INSTALL_DIR="$HOME/.local/bin"
BIN="$INSTALL_DIR/wsh"

printf "\n  ${CYAN}${BOLD}◆  Installing wsh${RESET}\n"
info "Platform: $PLATFORM"
printf "\n"

command -v curl >/dev/null 2>&1 || fail "curl is required but not found — please install curl"
[ -f "$BIN" ] && info "Updating existing install at $BIN"

step "Downloading from GitHub Releases..."
mkdir -p "$INSTALL_DIR"
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
if ! curl -fsSL "$URL" -o "$TMP"; then
  fail "Download failed — check your internet connection or visit https://github.com/$REPO/releases"
fi

mv "$TMP" "$BIN"
chmod +x "$BIN"

ok "Installed to $BIN"
if VERSION=$("$BIN" --version 2>/dev/null); then
  info "Version: $VERSION"
else
  info "Warning: 'wsh --version' failed (first-run setup may have failed)"
fi

# ---- PATH hint ----
case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    case "${SHELL:-}" in
      */zsh)  RC="$HOME/.zshrc" ;;
      */bash) RC="$HOME/.bashrc" ;;
      *)      RC="$HOME/.profile" ;;
    esac
    printf "\n"
    printf "  ${YELLOW}${BOLD}┌─ Action required ───────────────────────────────────────┐${RESET}\n"
    printf "  ${YELLOW}${BOLD}│${RESET}  ${BOLD}wsh${RESET} is not on your PATH yet.\n"
    printf "  ${YELLOW}${BOLD}│${RESET}  Run this to add it, then open a new terminal:\n"
    printf "  ${YELLOW}${BOLD}│${RESET}\n"
    printf "  ${YELLOW}${BOLD}│${RESET}  ${BOLD}echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> %s${RESET}\n" "$RC"
    printf "  ${YELLOW}${BOLD}└─────────────────────────────────────────────────────────┘${RESET}\n"
    ;;
esac

ok "Done! Run it with:"
printf "\n"
printf "  ${BOLD}wsh${RESET}\n"
printf "\n"

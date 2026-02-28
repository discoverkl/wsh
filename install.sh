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
    # arm64 only; Intel Macs run via Rosetta 2 transparently
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
URL="https://github.com/${REPO}/releases/latest/download/wsh-${PLATFORM}"
INSTALL_DIR="$HOME/.local/bin"
BIN="$INSTALL_DIR/wsh"

printf "\n  ${CYAN}${BOLD}◆  Installing wsh${RESET}\n"
info "Platform: $PLATFORM"
printf "\n"

step "Downloading from GitHub Releases..."
mkdir -p "$INSTALL_DIR"
if ! curl -fsSL "$URL" -o "$BIN"; then
  fail "Download failed — check your internet connection or visit https://github.com/$REPO/releases"
fi
chmod +x "$BIN"

ok "Installed to $BIN"

# ---- PATH hint ----
case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    printf "\n"
    printf "  ${YELLOW}${BOLD}!${RESET}  ${BOLD}$INSTALL_DIR is not in your PATH.${RESET}\n"
    printf "     Add this to your ~/.zshrc or ~/.bashrc, then restart your shell:\n"
    printf "     ${DIM}export PATH=\"\$HOME/.local/bin:\$PATH\"${RESET}\n"
    ;;
esac

printf "\n"
exec "$BIN" "$@"

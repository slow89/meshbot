#!/usr/bin/env bash
set -euo pipefail

REPO="slow89/meshbot"
INSTALL_DIR="${MESHBOT_HOME:-$HOME/.meshbot}"
BIN_LINK="/usr/local/bin/meshbot"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[meshbot]${NC} $1"; }
warn()  { echo -e "${YELLOW}[meshbot]${NC} $1"; }
error() { echo -e "${RED}[meshbot]${NC} $1" >&2; }

usage() {
  cat <<EOF
meshbot installer

Usage:
  curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh | bash
  bash install.sh [--uninstall]

Options:
  --uninstall    Remove meshbot from your system
  --help         Show this help message

Environment:
  MESHBOT_HOME    Installation directory (default: ~/.meshbot)
EOF
}

check_dependencies() {
  if ! command -v node &>/dev/null; then
    error "Node.js is required but not found. Install it from https://nodejs.org/"
    exit 1
  fi

  local node_version
  node_version=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$node_version" -lt 18 ]; then
    error "Node.js 18+ is required. Found: $(node -v)"
    exit 1
  fi

  if ! command -v pnpm &>/dev/null; then
    info "pnpm not found. Installing via corepack..."
    corepack enable
    corepack prepare pnpm@latest --activate
  fi

  if ! command -v git &>/dev/null; then
    error "git is required but not found."
    exit 1
  fi
}

uninstall() {
  info "Uninstalling meshbot..."

  if [ -L "$BIN_LINK" ]; then
    if [ -w "$(dirname "$BIN_LINK")" ]; then
      rm -f "$BIN_LINK"
    else
      sudo rm -f "$BIN_LINK"
    fi
    info "Removed $BIN_LINK"
  fi

  if [ -d "$INSTALL_DIR" ]; then
    rm -rf "$INSTALL_DIR"
    info "Removed $INSTALL_DIR"
  fi

  info "meshbot uninstalled. Mesh configs in ~/.mesh/ were preserved."
}

install() {
  check_dependencies

  info "Installing meshbot to $INSTALL_DIR..."

  # Clone or update
  if [ -d "$INSTALL_DIR/.git" ]; then
    info "Updating existing installation..."
    cd "$INSTALL_DIR"
    git pull --ff-only
  else
    if [ -d "$INSTALL_DIR" ]; then
      warn "Directory $INSTALL_DIR exists but is not a git repo. Removing..."
      rm -rf "$INSTALL_DIR"
    fi
    git clone "https://github.com/$REPO.git" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
  fi

  # Install dependencies and build
  info "Installing dependencies..."
  pnpm install --frozen-lockfile 2>/dev/null || pnpm install
  info "Building..."
  pnpm run build

  # Create symlink
  local bin_target="$INSTALL_DIR/dist/bin/meshbot.js"
  if [ ! -f "$bin_target" ]; then
    error "Build failed: $bin_target not found"
    exit 1
  fi

  chmod +x "$bin_target"

  info "Creating symlink at $BIN_LINK..."
  if [ -w "$(dirname "$BIN_LINK")" ]; then
    ln -sf "$bin_target" "$BIN_LINK"
  else
    sudo ln -sf "$bin_target" "$BIN_LINK"
  fi

  info "Installation complete!"
  echo ""
  info "Quick start:"
  echo "  meshbot init my-mesh"
  echo "  meshbot add-peer dev https://dev-server:9820"
  echo "  meshbot --as my-agent --dev \"Hello, mesh!\""
  echo ""
  info "Run 'meshbot --help' for all commands."
}

# Parse arguments
case "${1:-}" in
  --uninstall)
    uninstall
    ;;
  --help|-h)
    usage
    ;;
  *)
    install
    ;;
esac

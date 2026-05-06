#!/usr/bin/env bash
#
# Installs the pluggy CLI into $PLUGGY_HOME (defaults to $HOME/.pluggy) and
# wires the `bin/` directory onto $PATH via the user's shell profile. No
# sudo required.
#
# Override the install location with PLUGGY_HOME=/path/to/dir.

set -e

REPO="ch99q/pluggy"
BINARY="pluggy"

PLUGGY_HOME="${PLUGGY_HOME:-$HOME/.pluggy}"
INSTALL_DIR="$PLUGGY_HOME/bin"
DEST="$INSTALL_DIR/$BINARY"

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$ARCH" in
  x86_64|amd64) ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

case "$OS" in
  darwin|linux) ;;
  *) echo "Unsupported OS: $OS" >&2; exit 1 ;;
esac

URL="https://github.com/$REPO/releases/latest/download/${BINARY}-${OS}-${ARCH}"

mkdir -p "$INSTALL_DIR"

TMP="$(mktemp -t pluggy-install.XXXXXX)"
trap 'rm -f "$TMP"' EXIT

echo "Downloading $URL"
if ! curl -fsSL "$URL" -o "$TMP"; then
  echo "Failed to download $URL" >&2
  exit 1
fi
chmod +x "$TMP"
mv "$TMP" "$DEST"
trap - EXIT

echo "Installed $BINARY to $DEST"

# Warn about a stale system-wide install that would shadow the new one.
LEGACY="/usr/local/bin/$BINARY"
if [ -e "$LEGACY" ] && [ "$LEGACY" != "$DEST" ]; then
  cat <<EOF >&2

A previous install was found at $LEGACY. It will shadow the new install
on PATH. Remove it with:

  sudo rm $LEGACY

EOF
fi

# Add INSTALL_DIR to PATH idempotently in the user's shell profiles.
add_path_line() {
  local file="$1"
  local line="$2"
  [ -f "$file" ] || return 0
  if ! grep -Fq "$line" "$file" 2>/dev/null; then
    printf '\n# pluggy\n%s\n' "$line" >> "$file"
    echo "Added pluggy to PATH in $file"
  fi
}

POSIX_LINE="export PATH=\"$INSTALL_DIR:\$PATH\""
FISH_LINE="fish_add_path -g $INSTALL_DIR"

add_path_line "$HOME/.bashrc" "$POSIX_LINE"
add_path_line "$HOME/.bash_profile" "$POSIX_LINE"
add_path_line "$HOME/.zshrc" "$POSIX_LINE"
add_path_line "$HOME/.profile" "$POSIX_LINE"
[ -d "$HOME/.config/fish" ] && add_path_line "$HOME/.config/fish/config.fish" "$FISH_LINE"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    cat <<EOF

To start using pluggy in this shell:

  export PATH="$INSTALL_DIR:\$PATH"

Or open a new terminal session.
EOF
    ;;
esac

echo
echo "Run 'pluggy -V' to verify the install."

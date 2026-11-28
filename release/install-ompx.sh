#!/usr/bin/env bash
# Download and install the prebuilt OMPx binary (macOS arm64).
#
#   curl -fsSL https://raw.githubusercontent.com/hvquy001/ompx/main/release/install-ompx.sh | bash
#
# Options (environment variables):
#   OMPX_VERSION   version to install (default: 1.11.10)
#   OMPX_REF       git ref to download from (default: main)
#   OMPX_BIN_DIR   install directory (default: ~/.local/bin)
#   OMPX_BASE_URL  override the download base URL

set -euo pipefail

VERSION="${OMPX_VERSION:-1.11.10}"
REF="${OMPX_REF:-main}"
BIN_DIR="${OMPX_BIN_DIR:-$HOME/.local/bin}"
BASE_URL="${OMPX_BASE_URL:-https://raw.githubusercontent.com/hvquy001/ompx/${REF}/release}"
ASSET="ompx-${VERSION}-darwin-arm64.zst"

os="$(uname -s)"
arch="$(uname -m)"
if [ "$os" != "Darwin" ] || [ "$arch" != "arm64" ]; then
	echo "error: this build is macOS arm64 only (found ${os}/${arch})" >&2
	exit 1
fi

for cmd in curl shasum; do
	command -v "$cmd" >/dev/null 2>&1 || { echo "error: missing required command: $cmd" >&2; exit 1; }
done

if ! command -v zstd >/dev/null 2>&1; then
	echo "error: zstd is required to unpack the binary. Install it with: brew install zstd" >&2
	exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading ${ASSET} ..."
curl -fsSL "${BASE_URL}/${ASSET}" -o "${tmp}/${ASSET}"
curl -fsSL "${BASE_URL}/${ASSET}.sha256" -o "${tmp}/${ASSET}.sha256"

expected="$(awk '{print $1}' "${tmp}/${ASSET}.sha256")"
actual="$(shasum -a 256 "${tmp}/${ASSET}" | awk '{print $1}')"
if [ "$expected" != "$actual" ]; then
	echo "error: checksum mismatch" >&2
	echo "  expected: $expected" >&2
	echo "  actual:   $actual" >&2
	exit 1
fi
echo "Checksum ok: ${actual}"

zstd -d -f -q "${tmp}/${ASSET}" -o "${tmp}/ompx"
chmod +x "${tmp}/ompx"
# Ad-hoc re-sign: the signature does not survive compression on some setups.
codesign --force --sign - "${tmp}/ompx" >/dev/null 2>&1 || true
xattr -d com.apple.quarantine "${tmp}/ompx" >/dev/null 2>&1 || true

mkdir -p "$BIN_DIR"
mv -f "${tmp}/ompx" "${BIN_DIR}/ompx"

echo "Installed: ${BIN_DIR}/ompx"
"${BIN_DIR}/ompx" --version

case ":${PATH}:" in
	*":${BIN_DIR}:"*) ;;
	*) echo "note: ${BIN_DIR} is not on PATH. Add: export PATH=\"${BIN_DIR}:\$PATH\"" ;;
esac

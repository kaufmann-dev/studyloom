#!/usr/bin/env bash
set -euo pipefail
installer="$(mktemp)"
trap 'rm -f "$installer"' EXIT
curl --fail --location --proto '=https' --tlsv1.2 https://dev.meta.ai/install.sh --output "$installer"
MUSE_INSTALL_DIR=/usr/local/bin MUSE_NO_MODIFY_PATH=1 bash "$installer"
/usr/local/bin/muse --version

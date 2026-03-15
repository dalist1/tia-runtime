#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
export PI_PACKAGE_DIR="/home/frensiqatipi1/.bun/install/global/node_modules/@mariozechner/pi-coding-agent"

exec "${ROOT_DIR}/bin/pi-tool-override-runner" "$@"

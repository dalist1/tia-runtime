#!/usr/bin/env bash

set -euo pipefail

REQUEST_FILE="${1:?missing request file}"
PI_CLI="/home/frensiqatipi1/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/dist/cli.js"
TIMEOUT_SECONDS="${PI_RPC_TIMEOUT_SECONDS:-20}"

export PI_SKIP_VERSION_CHECK=1

exec timeout "${TIMEOUT_SECONDS}s" \
	bun "${PI_CLI}" \
		--mode rpc \
		--no-session \
		--no-extensions \
		--no-skills \
		--no-prompt-templates \
		--no-themes \
	< "${REQUEST_FILE}"

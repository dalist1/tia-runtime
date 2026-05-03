#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PAYLOAD_DIR="${ROOT_DIR}/payloads"
mkdir -p "${PAYLOAD_DIR}"

TIA_BENCH_ROOT_DIR="${ROOT_DIR}" bun -e '
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.TIA_BENCH_ROOT_DIR;
const payloadDir = path.join(root, "payloads");
fs.mkdirSync(payloadDir, { recursive: true });
fs.writeFileSync(path.join(payloadDir, "tiny.txt"), "hello stdin\n");
fs.writeFileSync(path.join(payloadDir, "lines-10k.txt"), Array.from({ length: 10000 }, (_, i) => `line-${i}\n`).join(""));
fs.writeFileSync(path.join(payloadDir, "blob-1m.txt"), "x".repeat(1024 * 1024));
fs.writeFileSync(path.join(payloadDir, "jsonl-5m.txt"), Array.from({ length: 75000 }, (_, i) => `{"id":${i},"name":"item-${i}","active":true,"tags":["a","b","c"]}\n`).join(""));
fs.writeFileSync(path.join(payloadDir, "edit-old.txt"), "line-4500\nline-4501\nline-4502\n");
fs.writeFileSync(path.join(payloadDir, "edit-new.txt"), "line-4500-updated\nline-4501-updated\nline-4502-updated\n");
'

printf 'Built tool benchmark fixtures in %s\n' "${PAYLOAD_DIR}"

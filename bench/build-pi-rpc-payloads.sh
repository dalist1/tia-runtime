#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PAYLOAD_DIR="${ROOT_DIR}/payloads"
RPC_PAYLOAD_DIR="${ROOT_DIR}/payloads-rpc"

mkdir -p "${PAYLOAD_DIR}" "${RPC_PAYLOAD_DIR}"

TIA_BENCH_ROOT_DIR="${ROOT_DIR}" bun -e '
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.TIA_BENCH_ROOT_DIR;
const payloadDir = path.join(root, "payloads");
const rpcPayloadDir = path.join(root, "payloads-rpc");
fs.mkdirSync(payloadDir, { recursive: true });
fs.mkdirSync(rpcPayloadDir, { recursive: true });
fs.writeFileSync(path.join(payloadDir, "tiny.txt"), "hello stdin\n");
fs.writeFileSync(path.join(payloadDir, "lines-10k.txt"), Array.from({ length: 10000 }, (_, i) => `line-${i}\n`).join(""));
fs.writeFileSync(path.join(payloadDir, "blob-1m.txt"), "x".repeat(1024 * 1024));
fs.writeFileSync(path.join(payloadDir, "jsonl-5m.txt"), Array.from({ length: 75000 }, (_, i) => `{"id":${i},"name":"item-${i}","active":true,"tags":["a","b","c"]}\n`).join(""));
fs.writeFileSync(path.join(rpcPayloadDir, "empty.get-state.jsonl"), `${JSON.stringify({ type: "get_state" })}\n`);
for (const name of fs.readdirSync(payloadDir).filter((name) => name.endsWith(".txt")).sort()) {
  const payloadPath = path.join(payloadDir, name);
  const stem = path.basename(name, ".txt");
  const request = { type: "get_state", padding: fs.readFileSync(payloadPath, "utf8") };
  fs.writeFileSync(path.join(rpcPayloadDir, `${stem}.get-state.jsonl`), `${JSON.stringify(request)}\n`);
}
'

printf 'Built pi RPC payloads in %s\n' "${RPC_PAYLOAD_DIR}"

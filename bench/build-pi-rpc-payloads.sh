#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PAYLOAD_DIR="${ROOT_DIR}/payloads"
RPC_PAYLOAD_DIR="${ROOT_DIR}/payloads-rpc"

mkdir -p "${PAYLOAD_DIR}" "${RPC_PAYLOAD_DIR}"

TIA_BENCH_ROOT_DIR="${ROOT_DIR}" python3 - <<'PY'
import json
import os
from pathlib import Path

root = Path(os.environ["TIA_BENCH_ROOT_DIR"])
payload_dir = root / "payloads"
rpc_payload_dir = root / "payloads-rpc"
payload_dir.mkdir(parents=True, exist_ok=True)
rpc_payload_dir.mkdir(parents=True, exist_ok=True)

(payload_dir / "tiny.txt").write_text("hello stdin\n", encoding="utf-8")
(payload_dir / "lines-10k.txt").write_text("".join(f"line-{i}\n" for i in range(10000)), encoding="utf-8")
(payload_dir / "blob-1m.txt").write_text("x" * (1024 * 1024), encoding="utf-8")
(payload_dir / "jsonl-5m.txt").write_text(
    "".join(
        '{"id":%d,"name":"item-%d","active":true,"tags":["a","b","c"]}\n' % (i, i)
        for i in range(75000)
    ),
    encoding="utf-8",
)

(rpc_payload_dir / "empty.get-state.jsonl").write_text(
    json.dumps({"type": "get_state"}, separators=(",", ":")) + "\n",
    encoding="utf-8",
)

for payload_path in sorted(payload_dir.glob("*.txt")):
    request = {
        "type": "get_state",
        "padding": payload_path.read_text(encoding="utf-8"),
    }
    target = rpc_payload_dir / f"{payload_path.stem}.get-state.jsonl"
    target.write_text(json.dumps(request, separators=(",", ":")) + "\n", encoding="utf-8")
PY

printf 'Built pi RPC payloads in %s\n' "${RPC_PAYLOAD_DIR}"

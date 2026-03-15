#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PAYLOAD_DIR="${ROOT_DIR}/payloads"
mkdir -p "${PAYLOAD_DIR}"

python3 - <<'PY'
from pathlib import Path

root = Path("/home/frensiqatipi1/bun-stdin-bench")
payload_dir = root / "payloads"
payload_dir.mkdir(parents=True, exist_ok=True)

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

old_text = "line-4500\nline-4501\nline-4502\n"
new_text = "line-4500-updated\nline-4501-updated\nline-4502-updated\n"
(payload_dir / "edit-old.txt").write_text(old_text, encoding="utf-8")
(payload_dir / "edit-new.txt").write_text(new_text, encoding="utf-8")
PY

printf 'Built tool benchmark fixtures in %s\n' "${PAYLOAD_DIR}"

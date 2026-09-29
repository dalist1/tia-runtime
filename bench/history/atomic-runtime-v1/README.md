# Atomic runtime generations — validation (v0.7.0)

Offline acceptance evidence for [ATOMIC-UPGRADE-PLAN.md](../../../ATOMIC-UPGRADE-PLAN.md#implementation-status), recorded 2026-09-29 on Linux x64 (ext4) with Bun 1.4.3. Every validation run used disposable HOMEs/roots, loopback providers and dummy credentials. The live runtime was upgraded afterwards; that record is at the end of this page.

| Gate | Result |
| --- | --- |
| Shell syntax, runtime asset manifest, format, lint, typecheck | passed |
| Unit and transaction tests (`bun test`) | 151 passed, 0 failed, 3,264 assertions ([log](final-unit.log.gz)) |
| Fixture crash matrix (`runtime-transaction.test.ts`) | throw/SIGTERM/SIGKILL × 16 phases = 48 crashes contained |
| Real-installer fault matrix (`bun run test:faults`) | 36 injected failures contained ([rows](fault-matrix.json)) |
| Integration (`bash test.sh`) | 14/14 stages ([log](final-integration.log.gz)) |

**Fault matrix.** The unmodified installer (real package installs, compile, seal and smoke; Pi 0.87.1, FFF 0.10.7-nightly.c3f2c7f) was SIGKILLed and made to throw at each of the 16 phases, then given an unknown Pi version, an unknown FFF version, an unreachable registry, and an external SIGTERM during package install. For every row the pointer changed if and only if the failure was at or after the rename, the launcher ran the selected generation, no transaction process survived, `tia recover` left no unreferenced staging or temp pointers, user-state bytes were unchanged, the failing phase was logged, and the dummy secret never appeared in logs. A final rollback verified.

**Legacy upgrade** (`test.sh` stage 13, [receipts](legacy-upgrade-receipts.tar.gz)): a v0.6.0 install (Pi 0.85.0) with a symlinked custom extension, a customized `fast-tools.ts` and real-shaped settings and sessions. The first upgrade was refused before staging and the launcher bytes were unchanged. The upgrade with `TIA_PRESERVE_FAST_TOOLS=1` then kept both customizations with byte-identical user state. A legacy RPC session answered after the upgrade, and a new-generation session answered after rollback. After rollback, `tia status` was byte-identical to the pre-upgrade legacy output, and a reinstall then verified. Separately, a disposable fresh root was upgraded from Pi 0.87.1 to 0.99.1 (newest by publish date), rolled back both ways, uninstalled and restored.

**Host Pi sync** (stage 14, [receipts](host-sync-receipts.tar.gz)): a root installed against a host Pi manifest at 0.87.1 was left running while the manifest was bumped to 0.99.1. One ordinary `tia pi` launch still ran 0.87.1 and started a background transaction. The next launch ran a verified 0.99.1 generation. `tia sync` then reported "already matches", and rollback with `TIA_AUTO_SYNC=0` stayed on 0.87.1.

**Live upgrade (2026-09-29):** generation `485b768a…` (Pi 0.99.1 from the host, FFF 0.10.7-nightly.c3f2c7f, preserved `fast-tools.ts` 6a0f0e68…). User settings, models, trust and `fast-tools.ts` hashes were unchanged, and `tia verify` passed. Slim mode defaulted to `openai-codex/gpt-6.1-sol`, and full-mode `--list-models` included it. The installer output is in the receipts archive.

Not covered: the human review gate, cross-filesystem/rename denial, fsync failure injection, power loss, other filesystems and platforms. The status record in the plan owns these.

[`release-validation.json`](release-validation.json) pins the source hashes for these runs. Bulky disposable roots (sealed generations, about 6.5 GB) were deleted after the runs; transaction logs and matrix rows were retained locally under the gitignored `results-atomic-v2/`.

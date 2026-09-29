# TODO

## After v0.7.0 / `2026-09-atomic-runtime-v1`

- Close the atomic-generation human review gate (permissions, manifests, rollback receipts, dispatcher diff). Implementation, offline gates and the live upgrade are done; remaining items are tracked in [ATOMIC-UPGRADE-PLAN.md § Implementation status](ATOMIC-UPGRADE-PLAN.md#implementation-status).
- Profile cold transformation and normal multi-turn sessions (including FFF, event-loop delay, and context serialization) before making further caching or SDK substitutions. See the [runtime anatomy report](bench/history/runtime-boundaries-v1/README.md#next-first-principles-work).

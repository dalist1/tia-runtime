# TODO

## After v0.5.0 / `2026-09-runtime-boundaries-v1`

- Resolve upstream pi 0.85.0 installation compatibility: bundling currently fails on missing `@earendil-works/pi-server` and `@earendil-works/pi-server/unix` imports. Keep 0.84.4 as the documented validated override; rerun the unpinned install/integration gate before claiming latest-version support.
- Extend atomic binary publication to immutable whole-runtime generations, including dependency closure, catalogs, and FFF. Global package updates and other asset changes are not yet transactional.
- Profile cold transformation and normal multi-turn sessions (including FFF, event-loop delay, and context serialization) before making further caching or SDK substitutions. See the [runtime anatomy report](bench/history/runtime-boundaries-v1/README.md#next-first-principles-work).

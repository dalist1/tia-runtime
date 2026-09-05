# TODO

## After v0.5.0 / `2026-09-runtime-boundaries-v1`

- Extend atomic binary publication to immutable whole-runtime generations, including dependency closure, catalogs, and FFF. Global package updates and other asset changes are not yet transactional.
- Profile cold transformation and normal multi-turn sessions (including FFF, event-loop delay, and context serialization) before making further caching or SDK substitutions. See the [runtime anatomy report](bench/history/runtime-boundaries-v1/README.md#next-first-principles-work).

# tia feedback-loop results

## Config

- rounds: `5`
- runs: `6`
- warmup: `1`
- tier: `full`
- run_startup: `false`
- zig: `available:zig (0.17.0-dev.1441+d5181a9c9)`

## Winners by suite

| Suite | Winner | Mean | Speedup | CV | Success |
|---|---|---:|---:|---:|---:|
| `stream-read` | fast stream compiled/gcc read comparison | 302.9 ms | n/a | 3.4% | 100% |
| `tool-bash` | fast compiled/gcc comparison | 322.2 ms | n/a | 5.4% | 100% |
| `tool-edit` | fast compiled/gcc comparison | 498.7 ms | n/a | 2.2% | 100% |
| `tool-read` | fast compiled/gcc comparison | 305.6 ms | n/a | 5.4% | 100% |
| `tool-write` | fast compiled/gcc comparison | 667.2 ms | n/a | 2.5% | 100% |

## Top strategies

| Rank | Strategy | Wins | Avg speedup | Avg CV | Suites |
|---:|---|---:|---:|---:|---|
| 1 | gcc comparison helpers | 5 | n/a | 3.8% | `stream-read`, `tool-bash`, `tool-edit`, `tool-read`, `tool-write` |

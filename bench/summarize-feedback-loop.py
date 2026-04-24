#!/usr/bin/env python3
"""Summarize tia-runtime feedback-loop hyperfine results.

The score intentionally combines speed and reliability:
  score = mean_seconds * (1 + coefficient_of_variation) / success_rate
Lower is better.  A candidate with flaky exits or high variance is penalized even if
its best run is fast.
"""

from __future__ import annotations

import json
import math
import statistics
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any


def mean(values: list[float]) -> float:
    return statistics.fmean(values) if values else math.inf


def pstdev(values: list[float]) -> float:
    return statistics.pstdev(values) if len(values) > 1 else 0.0


def strategy_for(command: str) -> str:
    lower = command.lower()
    if "zigcc" in lower or "zig" in lower:
        return "zig-built native helpers"
    if "warm-daemon" in lower or "warm daemon" in lower:
        return "warm daemon + native helpers"
    if "compiled" in lower and "native" in lower:
        return "compiled runner + native helpers"
    if "tia pi rpc" in lower:
        return "tia compiled launcher"
    if "bun/native" in lower or "bun + native" in lower or "bun+native" in lower:
        return "bun fast path + native helpers"
    if "stream" in lower and "fast" in lower:
        return "native streaming read"
    return command


def is_baseline(command: str) -> bool:
    lower = command.lower()
    return lower.startswith("stock") or "original" in lower or "baseline" in lower or "pi cli rpc" in lower


def load_config(result_dir: Path) -> dict[str, Any]:
    config_path = result_dir / "config.json"
    if not config_path.exists():
        return {}
    return json.loads(config_path.read_text(encoding="utf-8"))


def collect(result_dir: Path) -> tuple[dict[str, dict[str, dict[str, Any]]], dict[str, str]]:
    suites: dict[str, dict[str, dict[str, Any]]] = defaultdict(dict)
    baselines: dict[str, str] = {}

    for path in sorted(result_dir.glob("round-*/*.json")):
        if path.name == "meta.json":
            continue
        suite = path.stem
        data = json.loads(path.read_text(encoding="utf-8"))
        results = data.get("results", [])
        if not results:
            continue
        baselines.setdefault(suite, results[0].get("command", "baseline"))
        for item in results:
            command = item["command"]
            bucket = suites[suite].setdefault(
                command,
                {
                    "suite": suite,
                    "command": command,
                    "strategy": strategy_for(command),
                    "times": [],
                    "exit_codes": [],
                    "hyperfine_means": [],
                    "rounds_seen": 0,
                },
            )
            bucket["times"].extend(float(v) for v in item.get("times", []))
            bucket["exit_codes"].extend(int(v) for v in item.get("exit_codes", []))
            if "mean" in item:
                bucket["hyperfine_means"].append(float(item["mean"]))
            bucket["rounds_seen"] += 1

    return suites, baselines


def finalize(suites: dict[str, dict[str, dict[str, Any]]], baselines: dict[str, str]) -> dict[str, Any]:
    suite_summaries: dict[str, Any] = {}
    strategy_scores: dict[str, dict[str, Any]] = defaultdict(
        lambda: {"relative_scores": [], "speedups": [], "cvs": [], "wins": 0, "suites": []}
    )

    for suite, commands in sorted(suites.items()):
        baseline_name = baselines.get(suite) or next(iter(commands))
        baseline_bucket = commands.get(baseline_name) or next(iter(commands.values()))
        baseline_times = baseline_bucket.get("times", [])
        baseline_mean = mean(baseline_times)

        rows = []
        for command, bucket in sorted(commands.items()):
            times = bucket.get("times", [])
            exit_codes = bucket.get("exit_codes", [])
            successes = sum(1 for code in exit_codes if code == 0)
            attempts = len(exit_codes) or len(times)
            success_rate = successes / attempts if attempts else 0.0
            m = mean(times)
            sd = pstdev(times)
            cv = sd / m if m and math.isfinite(m) else math.inf
            score = m * (1.0 + cv) / max(success_rate, 0.01)
            speedup = baseline_mean / m if m > 0 and math.isfinite(baseline_mean) else None
            row = {
                "command": command,
                "strategy": bucket["strategy"],
                "is_baseline": command == baseline_name or is_baseline(command),
                "mean_s": m,
                "mean_ms": m * 1000.0,
                "stddev_s": sd,
                "cv": cv,
                "success_rate": success_rate,
                "attempts": attempts,
                "rounds_seen": bucket.get("rounds_seen", 0),
                "speedup_vs_baseline": speedup,
                "score": score,
            }
            rows.append(row)

        ranked = sorted(rows, key=lambda r: (r["score"], r["mean_s"]))
        candidate_rows = [r for r in ranked if not r["is_baseline"] and r["success_rate"] >= 1.0]
        winner = candidate_rows[0] if candidate_rows else ranked[0]
        if winner:
            strategy = winner["strategy"]
            rel = winner["score"] / ranked[0]["score"] if ranked and ranked[0]["score"] else winner["score"]
            # Better cross-suite normalization: candidate score over baseline score.
            baseline_row = next((r for r in rows if r["command"] == baseline_name), None)
            if baseline_row and baseline_row["score"]:
                rel = winner["score"] / baseline_row["score"]
            strategy_scores[strategy]["relative_scores"].append(rel)
            if winner["speedup_vs_baseline"] is not None:
                strategy_scores[strategy]["speedups"].append(winner["speedup_vs_baseline"])
            strategy_scores[strategy]["cvs"].append(winner["cv"])
            strategy_scores[strategy]["wins"] += 1
            strategy_scores[strategy]["suites"].append(suite)

        suite_summaries[suite] = {
            "baseline": baseline_name,
            "winner": winner,
            "ranked": ranked,
        }

    top_strategies = []
    for strategy, data in strategy_scores.items():
        top_strategies.append(
            {
                "strategy": strategy,
                "wins": data["wins"],
                "suites": data["suites"],
                "avg_relative_score_vs_baseline": mean(data["relative_scores"]),
                "avg_speedup_vs_baseline": mean(data["speedups"]),
                "avg_cv": mean(data["cvs"]),
            }
        )
    top_strategies.sort(
        key=lambda r: (
            -r["wins"],
            r["avg_relative_score_vs_baseline"],
            -r["avg_speedup_vs_baseline"],
            r["avg_cv"],
        )
    )

    return {"suites": suite_summaries, "top_strategies": top_strategies[:3]}


def fmt_ms(value: float) -> str:
    return f"{value:.1f}"


def fmt_speedup(value: float | None) -> str:
    if value is None or not math.isfinite(value):
        return "n/a"
    return f"{value:.2f}x"


def write_markdown(result_dir: Path, config: dict[str, Any], summary: dict[str, Any]) -> None:
    lines: list[str] = []
    lines.append("# tia feedback-loop results")
    lines.append("")
    if config:
        lines.append("## Config")
        lines.append("")
        for key in ["rounds", "runs", "warmup", "tier", "run_startup", "zig"]:
            if key in config:
                lines.append(f"- {key}: `{config[key]}`")
        lines.append("")
        ideas = config.get("top_ideas") or []
        if ideas:
            lines.append("## Candidate ideas tested")
            lines.append("")
            for idea in ideas:
                lines.append(f"- **{idea['name']}**: {idea['hypothesis']}")
            lines.append("")

    lines.append("## Winners by suite")
    lines.append("")
    lines.append("| Suite | Winner | Mean | Speedup | CV | Success |")
    lines.append("|---|---|---:|---:|---:|---:|")
    for suite, item in sorted(summary["suites"].items()):
        w = item["winner"]
        lines.append(
            f"| `{suite}` | {w['command']} | {fmt_ms(w['mean_ms'])} ms | "
            f"{fmt_speedup(w['speedup_vs_baseline'])} | {w['cv'] * 100:.1f}% | "
            f"{w['success_rate'] * 100:.0f}% |"
        )
    lines.append("")

    lines.append("## Top strategies")
    lines.append("")
    lines.append("| Rank | Strategy | Wins | Avg speedup | Avg CV | Suites |")
    lines.append("|---:|---|---:|---:|---:|---|")
    for index, row in enumerate(summary.get("top_strategies", []), start=1):
        lines.append(
            f"| {index} | {row['strategy']} | {row['wins']} | "
            f"{fmt_speedup(row['avg_speedup_vs_baseline'])} | {row['avg_cv'] * 100:.1f}% | "
            f"{', '.join(f'`{s}`' for s in row['suites'])} |"
        )
    lines.append("")

    lines.append("## Full ranking")
    lines.append("")
    for suite, item in sorted(summary["suites"].items()):
        lines.append(f"### `{suite}`")
        lines.append("")
        lines.append("| Rank | Command | Mean | Speedup | CV | Success | Score |")
        lines.append("|---:|---|---:|---:|---:|---:|---:|")
        for index, row in enumerate(item["ranked"], start=1):
            lines.append(
                f"| {index} | {row['command']} | {fmt_ms(row['mean_ms'])} ms | "
                f"{fmt_speedup(row['speedup_vs_baseline'])} | {row['cv'] * 100:.1f}% | "
                f"{row['success_rate'] * 100:.0f}% | {row['score']:.4f} |"
            )
        lines.append("")

    (result_dir / "summary.md").write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: summarize-feedback-loop.py <result-dir>", file=sys.stderr)
        return 2
    result_dir = Path(sys.argv[1])
    suites, baselines = collect(result_dir)
    summary = finalize(suites, baselines)
    config = load_config(result_dir)
    payload = {"config": config, **summary}
    (result_dir / "summary.json").write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    write_markdown(result_dir, config, summary)
    print(result_dir / "summary.md")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

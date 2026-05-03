import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type AnyObj = Record<string, any>;

function mean(values: number[]) {
  return values.length > 0
    ? values.reduce((a, b) => a + b, 0) / values.length
    : Number.POSITIVE_INFINITY;
}

function pstdev(values: number[]) {
  if (values.length <= 1) return 0;
  const m = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - m) ** 2)));
}

function strategyFor(command: string) {
  const lower = command.toLowerCase();
  if (lower.includes("zigcc") || lower.includes("zig")) return "zig-built native helpers";
  if (lower.includes("warm-daemon") || lower.includes("warm daemon"))
    return "warm daemon + native helpers";
  if (lower.includes("compiled") && lower.includes("native"))
    return "compiled runner + native helpers";
  if (lower.includes("tia pi rpc")) return "tia compiled launcher";
  if (lower.includes("stream") && lower.includes("fast")) return "native streaming read";
  return command;
}

function isBaseline(command: string) {
  const lower = command.toLowerCase();
  return (
    lower.startsWith("stock") ||
    lower.includes("original") ||
    lower.includes("baseline") ||
    lower.includes("pi cli rpc")
  );
}

function loadJson(path: string) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function collect(resultDir: string) {
  const suites: Record<string, Record<string, AnyObj>> = {};
  const baselines: Record<string, string> = {};
  for (const dir of readdirSync(resultDir)
    .filter((name) => name.startsWith("round-"))
    .sort()) {
    const roundDir = join(resultDir, dir);
    for (const file of readdirSync(roundDir).filter(
      (name) => name.endsWith(".json") && name !== "meta.json",
    )) {
      const suite = file.replace(/\.json$/, "");
      const data = loadJson(join(roundDir, file));
      const results = data.results ?? [];
      if (results.length === 0) continue;
      suites[suite] ??= {};
      baselines[suite] ??= results[0].command ?? "baseline";
      for (const item of results) {
        const command = item.command;
        const bucket = (suites[suite][command] ??= {
          suite,
          command,
          strategy: strategyFor(command),
          times: [],
          exit_codes: [],
          hyperfine_means: [],
          rounds_seen: 0,
        });
        bucket.times.push(...(item.times ?? []).map(Number));
        bucket.exit_codes.push(...(item.exit_codes ?? []).map(Number));
        if (item.mean !== undefined) bucket.hyperfine_means.push(Number(item.mean));
        bucket.rounds_seen += 1;
      }
    }
  }
  return { suites, baselines };
}

function finalize(
  suites: Record<string, Record<string, AnyObj>>,
  baselines: Record<string, string>,
) {
  const suiteSummaries: AnyObj = {};
  const strategyScores: AnyObj = {};
  for (const suite of Object.keys(suites).sort()) {
    const commands = suites[suite];
    const baselineName = baselines[suite] ?? Object.keys(commands)[0];
    const baselineBucket = commands[baselineName] ?? Object.values(commands)[0];
    const baselineMean = mean(baselineBucket.times ?? []);
    const rows = Object.entries(commands).map(([command, bucket]) => {
      const times = bucket.times ?? [];
      const exitCodes = bucket.exit_codes ?? [];
      const successes = exitCodes.filter((code: number) => code === 0).length;
      const attempts = exitCodes.length || times.length;
      const successRate = attempts ? successes / attempts : 0;
      const m = mean(times);
      const sd = pstdev(times);
      const cv = m && Number.isFinite(m) ? sd / m : Number.POSITIVE_INFINITY;
      const score = (m * (1 + cv)) / Math.max(successRate, 0.01);
      return {
        command,
        strategy: bucket.strategy,
        is_baseline: isBaseline(baselineName) && command === baselineName,
        mean_s: m,
        mean_ms: m * 1000,
        stddev_s: sd,
        cv,
        success_rate: successRate,
        attempts,
        rounds_seen: bucket.rounds_seen ?? 0,
        speedup_vs_baseline: m > 0 && Number.isFinite(baselineMean) ? baselineMean / m : null,
        score,
      };
    });
    const ranked = rows.sort((a, b) => a.score - b.score || a.mean_s - b.mean_s);
    const winner = ranked.find((row) => row.success_rate >= 1) ?? ranked[0];
    if (winner) {
      const bucket = (strategyScores[winner.strategy] ??= {
        relative_scores: [],
        speedups: [],
        cvs: [],
        wins: 0,
        suites: [],
      });
      const baselineRow = rows.find((row) => row.command === baselineName);
      bucket.relative_scores.push(
        baselineRow?.score ? winner.score / baselineRow.score : winner.score,
      );
      if (winner.speedup_vs_baseline !== null) bucket.speedups.push(winner.speedup_vs_baseline);
      bucket.cvs.push(winner.cv);
      bucket.wins += 1;
      bucket.suites.push(suite);
    }
    suiteSummaries[suite] = { baseline: baselineName, winner, ranked };
  }
  const topStrategies = Object.entries(strategyScores)
    .map(([strategy, data]: [string, any]) => ({
      strategy,
      wins: data.wins,
      suites: data.suites,
      avg_relative_score_vs_baseline: mean(data.relative_scores),
      avg_speedup_vs_baseline: mean(data.speedups),
      avg_cv: mean(data.cvs),
    }))
    .sort(
      (a, b) =>
        b.wins - a.wins ||
        a.avg_relative_score_vs_baseline - b.avg_relative_score_vs_baseline ||
        b.avg_speedup_vs_baseline - a.avg_speedup_vs_baseline ||
        a.avg_cv - b.avg_cv,
    )
    .slice(0, 3);
  return { suites: suiteSummaries, top_strategies: topStrategies };
}

function fmtMs(value: number) {
  return value.toFixed(1);
}
function fmtSpeedup(value: number | null) {
  return value == null || !Number.isFinite(value) ? "n/a" : `${value.toFixed(2)}x`;
}

function writeMarkdown(resultDir: string, config: AnyObj, summary: AnyObj) {
  const lines: string[] = ["# tia feedback-loop results", ""];
  if (Object.keys(config).length > 0) {
    lines.push("## Config", "");
    for (const key of ["rounds", "runs", "warmup", "tier", "run_startup", "zig"])
      if (key in config) lines.push(`- ${key}: \`${config[key]}\``);
    lines.push("");
  }
  lines.push(
    "## Winners by suite",
    "",
    "| Suite | Winner | Mean | Speedup | CV | Success |",
    "|---|---|---:|---:|---:|---:|",
  );
  for (const entry of Object.entries(summary.suites).sort()) {
    const suite = entry[0];
    const item = entry[1];
    const w = item.winner;
    lines.push(
      `| \`${suite}\` | ${w.command} | ${fmtMs(w.mean_ms)} ms | ${fmtSpeedup(w.speedup_vs_baseline)} | ${(w.cv * 100).toFixed(1)}% | ${(w.success_rate * 100).toFixed(0)}% |`,
    );
  }
  lines.push(
    "",
    "## Top strategies",
    "",
    "| Rank | Strategy | Wins | Avg speedup | Avg CV | Suites |",
    "|---:|---|---:|---:|---:|---|",
  );
  summary.top_strategies.forEach((row: any, index: number) =>
    lines.push(
      `| ${index + 1} | ${row.strategy} | ${row.wins} | ${fmtSpeedup(row.avg_speedup_vs_baseline)} | ${(row.avg_cv * 100).toFixed(1)}% | ${row.suites.map((s: string) => `\`${s}\``).join(", ")} |`,
    ),
  );
  lines.push("");
  writeFileSync(join(resultDir, "summary.md"), `${lines.join("\n")}\n`);
}

const resultDir = process.argv[2];
if (!resultDir) {
  console.error("usage: summarize-feedback-loop.ts <result-dir>");
  process.exit(2);
}
const configPath = join(resultDir, "config.json");
const config = existsSync(configPath) ? loadJson(configPath) : {};
const collected = collect(resultDir);
const summary = finalize(collected.suites, collected.baselines);
writeFileSync(
  join(resultDir, "summary.json"),
  `${JSON.stringify({ config, ...summary }, null, 2)}\n`,
);
writeMarkdown(resultDir, config, summary);
console.log(join(resultDir, "summary.md"));

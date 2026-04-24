process.env.PI_PACKAGE_DIR ??= "/home/frensiqatipi1/.bun/install/global/node_modules/@mariozechner/pi-coding-agent";

import { access, constants } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { DEFAULT_MAX_LINES } from "/home/frensiqatipi1/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/dist/core/tools/truncate.js";

function detectRootDir() {
	if (process.env.TIA_BENCH_ROOT_DIR) return resolve(process.env.TIA_BENCH_ROOT_DIR);
	const moduleDir = dirname(fileURLToPath(import.meta.url));
	if (basename(moduleDir) === "bench") return dirname(moduleDir);
	const executableDir = dirname(process.execPath);
	if (basename(executableDir) === "bin") return dirname(executableDir);
	return process.cwd();
}

const ROOT_DIR = detectRootDir();
const FASTREAD_BIN = process.env.TIA_FASTREAD_BIN ?? `${ROOT_DIR}/bin/fastread-window`;
const mode = process.argv[2];
const tool = process.argv[3];
const iterations = Number(process.argv[4] ?? 20);
const READ_PROGRESS_MIN_INTERVAL_MS = 120;

if (mode !== "fast" || !tool || !Number.isFinite(iterations) || iterations <= 0) {
	throw new Error("Usage: pi-tool-override-stream-burst.ts fast <tool> <iterations>");
}

type UpdateStats = {
	updates: number;
	firstUpdateMs: number | null;
	observedBytes: number;
};

type OnUpdate = ((update: { content: Array<{ type: "text"; text: string }>; details?: any }) => void) | undefined;

function makeUpdateTracker(iterationStart: number, stats: UpdateStats): OnUpdate {
	return (update) => {
		stats.updates += 1;
		const text = update.content[0]?.text ?? "";
		stats.observedBytes += Buffer.byteLength(text, "utf8");
		if (stats.firstUpdateMs === null) {
			stats.firstUpdateMs = performance.now() - iterationStart;
		}
	};
}

async function fastRead(pathArg: string, offset?: number, limit?: number, onUpdate?: OnUpdate) {
	const absolutePath = resolve(ROOT_DIR, pathArg);
	const startLine = Math.max(1, offset ?? 1);
	const maxLines = limit ?? DEFAULT_MAX_LINES;
	const proc = Bun.spawn([FASTREAD_BIN, absolutePath, String(startLine), String(maxLines)], {
		cwd: ROOT_DIR,
		stdout: "pipe",
		stderr: "pipe",
	});
	const stderrPromise = new Response(proc.stderr).text();
	const reader = proc.stdout.getReader();
	const decoder = new TextDecoder();
	let output = "";
	let lastProgressAt = 0;
	let lastProgressBytes = 0;

	while (true) {
		const { value, done } = await reader.read();
		if (done) {
			output += decoder.decode();
			break;
		}
		output += decoder.decode(value, { stream: true });
		if (!onUpdate || output.length === 0) {
			continue;
		}
		const now = Date.now();
		if (output.length - lastProgressBytes < 8 * 1024 && now - lastProgressAt < READ_PROGRESS_MIN_INTERVAL_MS) {
			continue;
		}
		lastProgressAt = now;
		lastProgressBytes = output.length;
		onUpdate({ content: [{ type: "text", text: output }] });
	}

	if (onUpdate && output.length > 0 && output.length !== lastProgressBytes) {
		onUpdate({ content: [{ type: "text", text: output }] });
	}

	const stderrText = await stderrPromise;
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(stderrText.trim() || `fastread-window exited with code ${exitCode}`);
	}
	return output;
}

await access(join(ROOT_DIR, "payloads"), constants.R_OK).catch(() => {
	throw new Error("Missing payloads; run build-tool-fixtures.sh first");
});

if (tool !== "read") {
	throw new Error(`Unsupported streaming benchmark tool: ${tool}`);
}

const file = `${ROOT_DIR}/payloads/jsonl-5m.txt`;
let totalUpdates = 0;
let totalObservedBytes = 0;
let firstUpdateTotalMs = 0;
let iterationsWithUpdate = 0;

const start = performance.now();
for (let i = 0; i < iterations; i += 1) {
	const iterationStart = performance.now();
	const stats: UpdateStats = { updates: 0, firstUpdateMs: null, observedBytes: 0 };
	const onUpdate = makeUpdateTracker(iterationStart, stats);
	await fastRead(file, undefined, undefined, onUpdate);
	if (stats.firstUpdateMs !== null) {
		firstUpdateTotalMs += stats.firstUpdateMs;
		iterationsWithUpdate += 1;
	}
	totalUpdates += stats.updates;
	totalObservedBytes += stats.observedBytes;
}
const end = performance.now();

console.log(
	JSON.stringify({
		mode,
		tool,
		iterations,
		elapsedMs: end - start,
		perIterationMs: (end - start) / iterations,
		totalUpdates,
		updatesPerIteration: totalUpdates / iterations,
		avgFirstUpdateMs: iterationsWithUpdate > 0 ? firstUpdateTotalMs / iterationsWithUpdate : null,
		observedBytesPerIteration: totalObservedBytes / iterations,
	}),
);

process.env.PI_PACKAGE_DIR ??= "/home/frensiqatipi1/.bun/install/global/node_modules/@mariozechner/pi-coding-agent";

import { createReadStream } from "node:fs";
import { access, constants } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createReadTool } from "/home/frensiqatipi1/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/dist/core/tools/read.js";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
} from "/home/frensiqatipi1/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/dist/core/tools/truncate.js";

const ROOT_DIR = "/home/frensiqatipi1/bun-stdin-bench";
const mode = process.argv[2];
const tool = process.argv[3];
const iterations = Number(process.argv[4] ?? 20);
const READ_PROGRESS_MIN_LINES = 128;
const READ_PROGRESS_MIN_BYTES = 8 * 1024;
const READ_PROGRESS_MIN_INTERVAL_MS = 120;

if (!mode || !tool || !Number.isFinite(iterations) || iterations <= 0) {
	throw new Error("Usage: pi-tool-override-stream-burst.ts <stock|fast> <tool> <iterations>");
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
	let currentLine = 1;
	let output = "";
	let outputLines = 0;
	let outputBytes = 0;
	let carry = "";
	let lastProgressAt = 0;
	let lastProgressLines = 0;
	let lastProgressBytes = 0;

	const maybeEmitProgress = (force = false) => {
		if (!onUpdate || outputLines === 0) {
			return;
		}
		const now = Date.now();
		if (
			!force &&
			outputLines - lastProgressLines < READ_PROGRESS_MIN_LINES &&
			outputBytes - lastProgressBytes < READ_PROGRESS_MIN_BYTES &&
			now - lastProgressAt < READ_PROGRESS_MIN_INTERVAL_MS
		) {
			return;
		}
		lastProgressAt = now;
		lastProgressLines = outputLines;
		lastProgressBytes = outputBytes;
		onUpdate({ content: [{ type: "text", text: output }] });
	};

	for await (const chunk of createReadStream(absolutePath, { encoding: "utf8", highWaterMark: 64 * 1024 })) {
		const combined = carry + chunk;
		const lines = combined.split("\n");
		carry = lines.pop() ?? "";

		for (const lineBody of lines) {
			const line = `${lineBody}\n`;
			if (currentLine >= startLine) {
				if (outputLines >= maxLines) {
					return output;
				}

				const nextBytes = Buffer.byteLength(line, "utf8");
				if (outputBytes + nextBytes > DEFAULT_MAX_BYTES) {
					if (outputLines === 0) {
						return `[Line ${startLine} is ${formatSize(nextBytes)}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit.]`;
					}
					return output;
				}

				output += line;
				outputLines += 1;
				outputBytes += nextBytes;
				maybeEmitProgress();
			}
			currentLine += 1;
		}
	}

	if (carry && currentLine >= startLine) {
		const nextBytes = Buffer.byteLength(carry, "utf8");
		if (outputLines === 0 && nextBytes > DEFAULT_MAX_BYTES) {
			return `[Line ${startLine} is ${formatSize(nextBytes)}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit.]`;
		}
		if (outputBytes + nextBytes <= DEFAULT_MAX_BYTES && outputLines < maxLines) {
			output += carry;
			outputLines += 1;
			outputBytes += nextBytes;
			maybeEmitProgress(true);
		}
	}

	return output;
}

async function stockRead(file: string, onUpdate?: OnUpdate) {
	const tool = createReadTool(ROOT_DIR);
	await tool.execute("stock-read", { path: file }, undefined as any, onUpdate as any);
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
	if (mode === "stock") {
		await stockRead(file, onUpdate);
	} else if (mode === "fast") {
		await fastRead(file, undefined, undefined, onUpdate);
	} else {
		throw new Error(`Unsupported mode: ${mode}`);
	}
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

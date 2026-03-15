process.env.PI_PACKAGE_DIR ??= "/home/frensiqatipi1/.bun/install/global/node_modules/@mariozechner/pi-coding-agent";

import { createReadStream } from "node:fs";
import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createReadTool } from "/home/frensiqatipi1/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/dist/core/tools/read.js";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
} from "/home/frensiqatipi1/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/dist/core/tools/truncate.js";

const ROOT_DIR = "/home/frensiqatipi1/bun-stdin-bench";
const variant = process.argv[2];
const runMode = process.argv[3];
const iterations = Number(process.argv[4] ?? 20);
const READ_PROGRESS_MIN_LINES = 128;
const READ_PROGRESS_MIN_BYTES = 8 * 1024;
const READ_PROGRESS_MIN_INTERVAL_MS = 120;

type UpdateStats = {
	updates: number;
	firstUpdateMs: number | null;
	observedBytes: number;
};

type OnUpdate =
	| ((update: { content: Array<{ type: "text"; text: string }>; details?: any }) => void)
	| undefined;

if (!variant || !runMode || !Number.isFinite(iterations) || iterations <= 0) {
	throw new Error(
		"Usage: pi-read-variants.ts <stock|split64k|scan64k|scan256k|bunscan> <burst|stream> <iterations>",
	);
}

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

function makeProgressEmitter(onUpdate?: OnUpdate) {
	let outputLines = 0;
	let outputBytes = 0;
	let lastProgressAt = 0;
	let lastProgressLines = 0;
	let lastProgressBytes = 0;

	const update = (nextLines: number, nextBytes: number, output: string, force = false) => {
		outputLines = nextLines;
		outputBytes = nextBytes;
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

	return { update };
}

async function stockRead(file: string, onUpdate?: OnUpdate) {
	const tool = createReadTool(ROOT_DIR);
	await tool.execute("stock-read", { path: file }, undefined as any, onUpdate as any);
}

async function splitRead(file: string, highWaterMark: number, onUpdate?: OnUpdate) {
	let currentLine = 1;
	let output = "";
	let outputLines = 0;
	let outputBytes = 0;
	let carry = "";
	const progress = makeProgressEmitter(onUpdate);

	for await (const chunk of createReadStream(file, { encoding: "utf8", highWaterMark })) {
		const combined = carry + chunk;
		const lines = combined.split("\n");
		carry = lines.pop() ?? "";

		for (const lineBody of lines) {
			const line = `${lineBody}\n`;
			if (outputLines >= DEFAULT_MAX_LINES) {
				return output;
			}
			const nextBytes = Buffer.byteLength(line, "utf8");
			if (outputBytes + nextBytes > DEFAULT_MAX_BYTES) {
				if (outputLines === 0) {
					return `[Line 1 is ${formatSize(nextBytes)}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit.]`;
				}
				return output;
			}
			output += line;
			outputLines += 1;
			outputBytes += nextBytes;
			progress.update(outputLines, outputBytes, output);
			currentLine += 1;
		}
	}

	if (carry) {
		const nextBytes = Buffer.byteLength(carry, "utf8");
		if (outputLines === 0 && nextBytes > DEFAULT_MAX_BYTES) {
			return `[Line 1 is ${formatSize(nextBytes)}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit.]`;
		}
		if (outputBytes + nextBytes <= DEFAULT_MAX_BYTES && outputLines < DEFAULT_MAX_LINES) {
			output += carry;
			outputLines += 1;
			outputBytes += nextBytes;
			progress.update(outputLines, outputBytes, output, true);
		}
	}

	if (currentLine < 1) {
		throw new Error("Unreachable");
	}

	return output;
}

async function scanRead(file: string, highWaterMark: number, onUpdate?: OnUpdate) {
	let output = "";
	let outputLines = 0;
	let outputBytes = 0;
	let carry = "";
	const progress = makeProgressEmitter(onUpdate);

	const appendLine = (line: string) => {
		if (outputLines >= DEFAULT_MAX_LINES) {
			return output;
		}
		const nextBytes = Buffer.byteLength(line, "utf8");
		if (outputBytes + nextBytes > DEFAULT_MAX_BYTES) {
			if (outputLines === 0) {
				return `[Line 1 is ${formatSize(nextBytes)}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit.]`;
			}
			return output;
		}
		output += line;
		outputLines += 1;
		outputBytes += nextBytes;
		progress.update(outputLines, outputBytes, output);
		return null;
	};

	for await (const chunk of createReadStream(file, { encoding: "utf8", highWaterMark })) {
		const combined = carry + chunk;
		let lineStart = 0;
		while (true) {
			const newlineIndex = combined.indexOf("\n", lineStart);
			if (newlineIndex === -1) {
				carry = combined.slice(lineStart);
				break;
			}
			const line = combined.slice(lineStart, newlineIndex + 1);
			const result = appendLine(line);
			if (result !== null) {
				return result;
			}
			lineStart = newlineIndex + 1;
		}
	}

	if (carry) {
		const nextBytes = Buffer.byteLength(carry, "utf8");
		if (outputLines === 0 && nextBytes > DEFAULT_MAX_BYTES) {
			return `[Line 1 is ${formatSize(nextBytes)}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit.]`;
		}
		if (outputBytes + nextBytes <= DEFAULT_MAX_BYTES && outputLines < DEFAULT_MAX_LINES) {
			output += carry;
			outputLines += 1;
			outputBytes += nextBytes;
			progress.update(outputLines, outputBytes, output, true);
		}
	}

	return output;
}

async function bunScanRead(file: string, onUpdate?: OnUpdate) {
	const decoder = new TextDecoder();
	let output = "";
	let outputLines = 0;
	let outputBytes = 0;
	let carry = "";
	const progress = makeProgressEmitter(onUpdate);

	const appendLine = (line: string) => {
		if (outputLines >= DEFAULT_MAX_LINES) {
			return output;
		}
		const nextBytes = Buffer.byteLength(line, "utf8");
		if (outputBytes + nextBytes > DEFAULT_MAX_BYTES) {
			if (outputLines === 0) {
				return `[Line 1 is ${formatSize(nextBytes)}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit.]`;
			}
			return output;
		}
		output += line;
		outputLines += 1;
		outputBytes += nextBytes;
		progress.update(outputLines, outputBytes, output);
		return null;
	};

	for await (const chunk of Bun.file(file).stream()) {
		const combined = carry + decoder.decode(chunk, { stream: true });
		let lineStart = 0;
		while (true) {
			const newlineIndex = combined.indexOf("\n", lineStart);
			if (newlineIndex === -1) {
				carry = combined.slice(lineStart);
				break;
			}
			const line = combined.slice(lineStart, newlineIndex + 1);
			const result = appendLine(line);
			if (result !== null) {
				return result;
			}
			lineStart = newlineIndex + 1;
		}
	}

	const tail = carry + decoder.decode();
	if (tail) {
		const nextBytes = Buffer.byteLength(tail, "utf8");
		if (outputLines === 0 && nextBytes > DEFAULT_MAX_BYTES) {
			return `[Line 1 is ${formatSize(nextBytes)}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit.]`;
		}
		if (outputBytes + nextBytes <= DEFAULT_MAX_BYTES && outputLines < DEFAULT_MAX_LINES) {
			output += tail;
			outputLines += 1;
			outputBytes += nextBytes;
			progress.update(outputLines, outputBytes, output, true);
		}
	}

	return output;
}

async function runVariant(file: string, onUpdate?: OnUpdate) {
	switch (variant) {
		case "stock":
			return stockRead(file, onUpdate);
		case "split64k":
			return splitRead(file, 64 * 1024, onUpdate);
		case "scan64k":
			return scanRead(file, 64 * 1024, onUpdate);
		case "scan256k":
			return scanRead(file, 256 * 1024, onUpdate);
		case "bunscan":
			return bunScanRead(file, onUpdate);
		default:
			throw new Error(`Unsupported variant: ${variant}`);
	}
}

await access(join(ROOT_DIR, "payloads"), constants.R_OK).catch(() => {
	throw new Error("Missing payloads; run build-tool-fixtures.sh first");
});

const file = `${ROOT_DIR}/payloads/jsonl-5m.txt`;
let totalUpdates = 0;
let totalObservedBytes = 0;
let firstUpdateTotalMs = 0;
let iterationsWithUpdate = 0;

const start = performance.now();
for (let i = 0; i < iterations; i += 1) {
	const iterationStart = performance.now();
	const stats: UpdateStats = { updates: 0, firstUpdateMs: null, observedBytes: 0 };
	const onUpdate = runMode === "stream" ? makeUpdateTracker(iterationStart, stats) : undefined;
	await runVariant(file, onUpdate);
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
		variant,
		runMode,
		iterations,
		elapsedMs: end - start,
		perIterationMs: (end - start) / iterations,
		totalUpdates,
		updatesPerIteration: totalUpdates / iterations,
		avgFirstUpdateMs: iterationsWithUpdate > 0 ? firstUpdateTotalMs / iterationsWithUpdate : null,
		observedBytesPerIteration: totalObservedBytes / iterations,
	}),
);

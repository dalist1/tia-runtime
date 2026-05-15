process.env.PI_PACKAGE_DIR ??= "/home/frensiqatipi1/.bun/install/global/node_modules/@earendil-works/pi-coding-agent";

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { access, constants } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createBashTool } from "/home/frensiqatipi1/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js";
import { DEFAULT_MAX_LINES } from "/home/frensiqatipi1/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/truncate.js";

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
const FASTEDIT_BIN = process.env.TIA_FASTEDIT_BIN ?? `${ROOT_DIR}/bin/fastedit`;
const FASTDRAIN_BIN = process.env.TIA_FASTDRAIN_BIN ?? `${ROOT_DIR}/bin/fastdrain`;
const FASTCOPY_BIN = process.env.TIA_FASTCOPY_BIN ?? `${ROOT_DIR}/bin/fastcopy`;
const FASTWRITE_BIN = process.env.TIA_FASTWRITE_BIN ?? `${ROOT_DIR}/bin/fastwrite`;
const mode = process.argv[2];
const READ_PROGRESS_MIN_INTERVAL_MS = 120;
const READ_PROGRESS_MIN_BYTES = 8 * 1024;

type ToolUpdate = { content: Array<{ type: "text"; text: string }>; details?: any };
type OnUpdate = ((update: ToolUpdate) => void) | undefined;

type Request = {
	id?: string;
	tool?: string;
	path?: string;
	offset?: number;
	limit?: number;
	contentFile?: string;
	templateFile?: string;
	oldTextFile?: string;
	newTextFile?: string;
	command?: string;
};

type UpdateStats = {
	updates: number;
	firstUpdateMs: number | null;
	observedBytes: number;
};

if (mode !== "fast") {
	throw new Error("Usage: pi-tool-override-daemon.ts fast");
}

const tempDir = () => {
	const dir = join(tmpdir(), `pi-fast-daemon-${process.pid}-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
};


function assertFileText(path: string, expected: string) {
	const actual = readFileSync(path, "utf8");
	if (actual !== expected) {
		throw new Error(
			`write verification failed for ${path}: expected ${expected.length} chars/${Buffer.byteLength(expected, "utf8")} bytes, got ${actual.length} chars/${Buffer.byteLength(actual, "utf8")} bytes`,
		);
	}
}
function makeUpdateTracker(startedAt: number, stats: UpdateStats): OnUpdate {
	return (update) => {
		stats.updates += 1;
		const text = update.content[0]?.text ?? "";
		stats.observedBytes += Buffer.byteLength(text, "utf8");
		if (stats.firstUpdateMs === null) {
			stats.firstUpdateMs = performance.now() - startedAt;
		}
	};
}

async function runBinaryWithInput(cmd: string, args: string[], input: string) {
	const proc = Bun.spawn([cmd, ...args], {
		cwd: ROOT_DIR,
		stdin: "pipe",
		stdout: "ignore",
		stderr: "pipe",
	});
	const stderrPromise = new Response(proc.stderr).text();
	await proc.stdin.write(input);
	proc.stdin.end();
	const [stderrText, exitCode] = await Promise.all([stderrPromise, proc.exited]);
	if (exitCode !== 0) throw new Error(stderrText.trim() || `${cmd} exited with code ${exitCode}`);
}

async function runBinary(cmd: string, args: string[]) {
	const proc = Bun.spawn([cmd, ...args], {
		cwd: ROOT_DIR,
		stdout: "ignore",
		stderr: "pipe",
	});
	const stderrText = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(stderrText.trim() || `${cmd} exited with code ${exitCode}`);
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
		if (output.length - lastProgressBytes < READ_PROGRESS_MIN_BYTES && now - lastProgressAt < READ_PROGRESS_MIN_INTERVAL_MS) {
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

async function fastWrite(contentFile: string) {
	const dir = tempDir();
	try {
		const content = readFileSync(contentFile, "utf8");
		const targetFile = join(dir, "out.txt");
		mkdirSync(dirname(targetFile), { recursive: true });
		if (existsSync(FASTWRITE_BIN)) {
			await runBinaryWithInput(FASTWRITE_BIN, [targetFile], content);
		} else {
			await Bun.write(targetFile, content);
		}
		assertFileText(targetFile, content);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

async function fastEdit(templateFile: string, oldTextFile: string, newTextFile: string) {
	const dir = tempDir();
	try {
		const targetFile = join(dir, "edit-target.txt");
		writeFileSync(targetFile, readFileSync(templateFile, "utf8"), "utf8");
		await runBinary(FASTEDIT_BIN, [targetFile, oldTextFile, newTextFile]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

async function tryOptimizedBash(command: string) {
	const parts = command
		.split("&&")
		.map((part) => part.trim())
		.filter(Boolean);

	if (parts.length === 0) {
		return false;
	}

	const actions: Array<() => Promise<void>> = [];

	for (const part of parts) {
		const catMatch = part.match(/^cat\s+(\S+)\s*>\s*\/dev\/null$/);
		if (catMatch) {
			const file = resolve(ROOT_DIR, catMatch[1]);
			actions.push(async () => {
				await runBinary(FASTDRAIN_BIN, [file]);
			});
			continue;
		}

		const cpMatch = part.match(/^cp\s+(\S+)\s+(\S+)$/);
		if (cpMatch) {
			const src = resolve(ROOT_DIR, cpMatch[1]);
			const dst = resolve(ROOT_DIR, cpMatch[2]);
			actions.push(async () => {
				mkdirSync(dirname(dst), { recursive: true });
				await runBinary(FASTCOPY_BIN, [src, dst]);
			});
			continue;
		}

		const rmMatch = part.match(/^rm\s+(\S+)$/);
		if (rmMatch) {
			const target = resolve(ROOT_DIR, rmMatch[1]);
			actions.push(async () => {
				rmSync(target, { force: true });
			});
			continue;
		}

		return false;
	}

	for (const action of actions) {
		await action();
	}

	return true;
}

async function fastBash(command: string) {
	if (await tryOptimizedBash(command)) {
		return;
	}

	const tool = createBashTool(ROOT_DIR);
	await tool.execute("fast-bash", { command }, undefined as any, undefined);
}

function output(value: unknown, exitAfter = false) {
	const line = `${JSON.stringify(value)}\n`;
	if (exitAfter) {
		process.stdout.write(line, () => process.exit(0));
		return;
	}
	process.stdout.write(line);
}

async function handleRequest(request: Request) {
	const id = request.id;
	const tool = request.tool;
	if (!tool) {
		output({ id, ok: false, error: "Missing tool" });
		return;
	}

	if (tool === "shutdown") {
		output({ id, ok: true, tool, mode }, true);
		return;
	}

	const startedAt = performance.now();
	const stats: UpdateStats = { updates: 0, firstUpdateMs: null, observedBytes: 0 };
	const onUpdate = makeUpdateTracker(startedAt, stats);

	try {
		if (tool === "read") {
			const file = request.path ?? `${ROOT_DIR}/payloads/jsonl-5m.txt`;
			const offset = request.offset;
			const limit = request.limit;
			const text = await fastRead(file, offset, limit, onUpdate);
			const bytes = Buffer.byteLength(text, "utf8");
			output({
				id,
				ok: true,
				tool,
				mode,
				elapsedMs: performance.now() - startedAt,
				bytes,
				updates: stats.updates,
				firstUpdateMs: stats.firstUpdateMs,
				observedBytes: stats.observedBytes,
			});
			return;
		}

		if (tool === "write") {
			const contentFile = request.contentFile ?? `${ROOT_DIR}/payloads/blob-1m.txt`;
			await fastWrite(contentFile);
			output({ id, ok: true, tool, mode, elapsedMs: performance.now() - startedAt });
			return;
		}

		if (tool === "edit") {
			const templateFile = request.templateFile ?? `${ROOT_DIR}/payloads/lines-10k.txt`;
			const oldTextFile = request.oldTextFile ?? `${ROOT_DIR}/payloads/edit-old.txt`;
			const newTextFile = request.newTextFile ?? `${ROOT_DIR}/payloads/edit-new.txt`;
			await fastEdit(templateFile, oldTextFile, newTextFile);
			output({ id, ok: true, tool, mode, elapsedMs: performance.now() - startedAt });
			return;
		}

		if (tool === "bash") {
			const copyPath = `/tmp/pi-fast-daemon-copy-${process.pid}-${Date.now()}`;
			const command =
				request.command ??
				`cat ${ROOT_DIR}/payloads/jsonl-5m.txt > /dev/null && cp ${ROOT_DIR}/payloads/jsonl-5m.txt ${copyPath} && rm ${copyPath}`;
			await fastBash(command);
			output({ id, ok: true, tool, mode, elapsedMs: performance.now() - startedAt });
			return;
		}

		output({ id, ok: false, tool, error: `Unsupported tool: ${tool}` });
	} catch (error) {
		output({
			id,
			ok: false,
			tool,
			mode,
			elapsedMs: performance.now() - startedAt,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

await access(join(ROOT_DIR, "payloads"), constants.R_OK).catch(() => {
	throw new Error("Missing payloads; run build-tool-fixtures.sh first");
});

output({ type: "ready", mode, pid: process.pid });

let buffer = "";
let pending = Promise.resolve();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	for (;;) {
		const newlineIndex = buffer.indexOf("\n");
		if (newlineIndex === -1) break;
		let line = buffer.slice(0, newlineIndex);
		buffer = buffer.slice(newlineIndex + 1);
		if (line.endsWith("\r")) line = line.slice(0, -1);
		if (!line) continue;
		pending = pending.then(async () => {
			try {
				await handleRequest(JSON.parse(line));
			} catch (error) {
				output({ ok: false, error: error instanceof Error ? error.message : String(error) });
			}
		});
	}
});

process.stdin.on("end", () => {
	pending.finally(() => process.exit(0));
});

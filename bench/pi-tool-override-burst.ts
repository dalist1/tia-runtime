process.env.PI_PACKAGE_DIR ??= "/home/frensiqatipi1/.bun/install/global/node_modules/@mariozechner/pi-coding-agent";

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { access, constants } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createBashTool } from "/home/frensiqatipi1/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/dist/core/tools/bash.js";
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
const FASTEDIT_BIN = process.env.TIA_FASTEDIT_BIN ?? `${ROOT_DIR}/bin/fastedit`;
const FASTDRAIN_BIN = process.env.TIA_FASTDRAIN_BIN ?? `${ROOT_DIR}/bin/fastdrain`;
const FASTCOPY_BIN = process.env.TIA_FASTCOPY_BIN ?? `${ROOT_DIR}/bin/fastcopy`;
const FASTWRITE_BIN = process.env.TIA_FASTWRITE_BIN ?? `${ROOT_DIR}/bin/fastwrite`;
const mode = process.argv[2];
const tool = process.argv[3];
const iterations = Number(process.argv[4] ?? 20);

if (mode !== "fast" || !tool || !Number.isFinite(iterations) || iterations <= 0) {
	throw new Error("Usage: pi-tool-override-burst.ts fast <tool> <iterations>");
}

const tempDir = () => {
	const dir = join(tmpdir(), `pi-fast-tool-${process.pid}-${randomUUID()}`);
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
async function runBinaryCapture(cmd: string, args: string[]) {
	const proc = Bun.spawn([cmd, ...args], {
		cwd: ROOT_DIR,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdoutText, stderrText, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(stderrText.trim() || `${cmd} exited with code ${exitCode}`);
	}
	return stdoutText;
}

async function fastRead(pathArg: string, offset?: number, limit?: number) {
	const absolutePath = resolve(ROOT_DIR, pathArg);
	const startLine = Math.max(1, offset ?? 1);
	const maxLines = limit ?? DEFAULT_MAX_LINES;
	if (startLine >= 1 && maxLines >= 1) {
		return await runBinaryCapture(FASTREAD_BIN, [absolutePath, String(startLine), String(maxLines)]);
	}
	return await runBinaryCapture(FASTREAD_BIN, [absolutePath, "1", String(DEFAULT_MAX_LINES)]);
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
		stderr: "ignore",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`${cmd} exited with code ${exitCode}`);
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

await access(join(ROOT_DIR, "payloads"), constants.R_OK).catch(() => {
	throw new Error("Missing payloads; run build-tool-fixtures.sh first");
});

const run = async () => {
	if (tool === "read") {
		const file = `${ROOT_DIR}/payloads/jsonl-5m.txt`;
		for (let i = 0; i < iterations; i += 1) {
			await fastRead(file);
		}
		return;
	}

	if (tool === "write") {
		const contentFile = `${ROOT_DIR}/payloads/blob-1m.txt`;
		for (let i = 0; i < iterations; i += 1) {
			await fastWrite(contentFile);
		}
		return;
	}

	if (tool === "edit") {
		const templateFile = `${ROOT_DIR}/payloads/lines-10k.txt`;
		const oldTextFile = `${ROOT_DIR}/payloads/edit-old.txt`;
		const newTextFile = `${ROOT_DIR}/payloads/edit-new.txt`;
		for (let i = 0; i < iterations; i += 1) {
			await fastEdit(templateFile, oldTextFile, newTextFile);
		}
		return;
	}

	if (tool === "bash") {
		for (let i = 0; i < iterations; i += 1) {
			const copyPath = `/tmp/pi-fast-tool-copy-${process.pid}-${Date.now()}-${i}`;
			const command = `cat ${ROOT_DIR}/payloads/jsonl-5m.txt > /dev/null && cp ${ROOT_DIR}/payloads/jsonl-5m.txt ${copyPath} && rm ${copyPath}`;
			await fastBash(command);
		}
		return;
	}

	throw new Error(`Unsupported tool: ${tool}`);
};

const start = performance.now();
await run();
const end = performance.now();

console.log(JSON.stringify({ mode, tool, iterations, elapsedMs: end - start, perIterationMs: (end - start) / iterations }));

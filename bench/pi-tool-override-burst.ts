process.env.PI_PACKAGE_DIR ??= "/home/frensiqatipi1/.bun/install/global/node_modules/@mariozechner/pi-coding-agent";

import { createReadStream, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { access, constants } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createBashTool } from "/home/frensiqatipi1/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/dist/core/tools/bash.js";
import { createEditTool } from "/home/frensiqatipi1/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/dist/core/tools/edit.js";
import { createReadTool } from "/home/frensiqatipi1/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/dist/core/tools/read.js";
import { createWriteTool } from "/home/frensiqatipi1/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/dist/core/tools/write.js";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
} from "/home/frensiqatipi1/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/dist/core/tools/truncate.js";

const ROOT_DIR = "/home/frensiqatipi1/bun-stdin-bench";
const mode = process.argv[2];
const tool = process.argv[3];
const iterations = Number(process.argv[4] ?? 20);

if (!mode || !tool || !Number.isFinite(iterations) || iterations <= 0) {
	throw new Error("Usage: pi-tool-override-burst.ts <stock|fast> <tool> <iterations>");
}

const tempDir = () => {
	const dir = join(tmpdir(), `pi-fast-tool-${process.pid}-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
};

async function fastRead(pathArg: string, offset?: number, limit?: number) {
	const absolutePath = resolve(ROOT_DIR, pathArg);
	const startLine = Math.max(1, offset ?? 1);
	const maxLines = limit ?? DEFAULT_MAX_LINES;
	let currentLine = 1;
	let output = "";
	let outputLines = 0;
	let outputBytes = 0;
	let carry = "";

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
		}
	}

	return output;
}

async function fastWrite(contentFile: string) {
	const dir = tempDir();
	try {
		const content = readFileSync(contentFile, "utf8");
		mkdirSync(dirname(join(dir, "out.txt")), { recursive: true });
		await Bun.write(join(dir, "out.txt"), content);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

async function fastEdit(templateFile: string, oldTextFile: string, newTextFile: string) {
	const dir = tempDir();
	try {
		const targetFile = join(dir, "edit-target.txt");
		writeFileSync(targetFile, readFileSync(templateFile, "utf8"), "utf8");
		const oldText = readFileSync(oldTextFile, "utf8");
		const newText = readFileSync(newTextFile, "utf8");
		const content = await Bun.file(targetFile).text();
		const firstIndex = content.indexOf(oldText);
		if (firstIndex === -1) throw new Error("oldText not found");
		const secondIndex = content.indexOf(oldText, firstIndex + oldText.length);
		if (secondIndex !== -1) throw new Error("oldText not unique");
		await Bun.write(targetFile, content.slice(0, firstIndex) + newText + content.slice(firstIndex + oldText.length));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

async function stockRead(file: string) {
	const tool = createReadTool(ROOT_DIR);
	await tool.execute("stock-read", { path: file }, undefined as any);
}

async function stockWrite(contentFile: string) {
	const content = readFileSync(contentFile, "utf8");
	const dir = tempDir();
	try {
		const tool = createWriteTool(dir);
		await tool.execute("stock-write", { path: "out.txt", content }, undefined as any);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

async function stockEdit(templateFile: string, oldTextFile: string, newTextFile: string) {
	const dir = tempDir();
	try {
		const targetFile = join(dir, "edit-target.txt");
		writeFileSync(targetFile, readFileSync(templateFile, "utf8"), "utf8");
		const tool = createEditTool(dir);
		await tool.execute(
			"stock-edit",
			{
				path: "edit-target.txt",
				oldText: readFileSync(oldTextFile, "utf8"),
				newText: readFileSync(newTextFile, "utf8"),
			},
			undefined as any,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

async function stockBash(command: string) {
	const tool = createBashTool(ROOT_DIR);
	await tool.execute("stock-bash", { command }, undefined as any, undefined);
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
				await runBinary(`${ROOT_DIR}/bin/fastdrain`, [file]);
			});
			continue;
		}

		const cpMatch = part.match(/^cp\s+(\S+)\s+(\S+)$/);
		if (cpMatch) {
			const src = resolve(ROOT_DIR, cpMatch[1]);
			const dst = resolve(ROOT_DIR, cpMatch[2]);
			actions.push(async () => {
				await runBinary(`${ROOT_DIR}/opencode-optimized/bin/fastcopy`, [src, dst]);
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

	const helperBin = `${ROOT_DIR}/opencode-optimized/bin`;
	const tool = createBashTool(ROOT_DIR, {
		spawnHook: ({ command: currentCommand, cwd, env }) => ({
			command: currentCommand,
			cwd,
			env: {
				...(env ?? process.env),
				PATH: `${helperBin}:${process.env.PATH ?? ""}`,
			},
		}),
	});
	await tool.execute("fast-bash", { command }, undefined as any, undefined);
}

await access(join(ROOT_DIR, "payloads"), constants.R_OK).catch(() => {
	throw new Error("Missing payloads; run build-tool-fixtures.sh first");
});

const run = async () => {
	if (tool === "read") {
		const file = `${ROOT_DIR}/payloads/jsonl-5m.txt`;
		for (let i = 0; i < iterations; i += 1) {
			if (mode === "stock") await stockRead(file);
			else await fastRead(file);
		}
		return;
	}

	if (tool === "write") {
		const contentFile = `${ROOT_DIR}/payloads/blob-1m.txt`;
		for (let i = 0; i < iterations; i += 1) {
			if (mode === "stock") await stockWrite(contentFile);
			else await fastWrite(contentFile);
		}
		return;
	}

	if (tool === "edit") {
		const templateFile = `${ROOT_DIR}/payloads/lines-10k.txt`;
		const oldTextFile = `${ROOT_DIR}/payloads/edit-old.txt`;
		const newTextFile = `${ROOT_DIR}/payloads/edit-new.txt`;
		for (let i = 0; i < iterations; i += 1) {
			if (mode === "stock") await stockEdit(templateFile, oldTextFile, newTextFile);
			else await fastEdit(templateFile, oldTextFile, newTextFile);
		}
		return;
	}

	if (tool === "bash") {
		for (let i = 0; i < iterations; i += 1) {
			const copyPath = `/tmp/pi-fast-tool-copy-${process.pid}-${Date.now()}-${i}`;
			const command = `cat ${ROOT_DIR}/payloads/jsonl-5m.txt > /dev/null && cp ${ROOT_DIR}/payloads/jsonl-5m.txt ${copyPath} && rm ${copyPath}`;
			if (mode === "stock") await stockBash(command);
			else await fastBash(command);
		}
		return;
	}

	throw new Error(`Unsupported tool: ${tool}`);
};

const start = performance.now();
await run();
const end = performance.now();

console.log(JSON.stringify({ mode, tool, iterations, elapsedMs: end - start, perIterationMs: (end - start) / iterations }));

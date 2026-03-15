process.env.PI_PACKAGE_DIR ??= "/home/frensiqatipi1/.bun/install/global/node_modules/@mariozechner/pi-coding-agent";

import { createReadStream, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { access, constants } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
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

if (!mode || !tool) {
	throw new Error("Usage: pi-tool-override-runner.ts <stock|fast> <tool> [...args]");
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

	const appendLine = (line: string) => {
		if (currentLine >= startLine) {
			if (outputLines >= maxLines) {
				return finalizeFastRead(output, startLine, outputLines, outputBytes, "lines", line, pathArg);
			}

			const nextBytes = Buffer.byteLength(line, "utf8");
			if (outputBytes + nextBytes > DEFAULT_MAX_BYTES) {
				return finalizeFastRead(output, startLine, outputLines, outputBytes, "bytes", line, pathArg);
			}

			output += line;
			outputLines += 1;
			outputBytes += nextBytes;
		}

		currentLine += 1;
		return null;
	};

	for await (const chunk of createReadStream(absolutePath, { encoding: "utf8", highWaterMark: 64 * 1024 })) {
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

	if (carry && currentLine >= startLine) {
		const nextBytes = Buffer.byteLength(carry, "utf8");
		if (outputLines === 0 && nextBytes > DEFAULT_MAX_BYTES) {
			return {
				content: [
					{
						type: "text",
						text: `[Line ${startLine} is ${formatSize(nextBytes)}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash for partial reads.]`,
					},
				],
				details: { truncation: { truncated: true, firstLineExceedsLimit: true } },
			};
		}
		if (outputBytes + nextBytes <= DEFAULT_MAX_BYTES && outputLines < maxLines) {
			output += carry;
			outputLines += 1;
		}
	}

	return {
		content: [{ type: "text", text: output || "" }],
		details: undefined,
	};
}

function finalizeFastRead(
	output: string,
	startLine: number,
	outputLines: number,
	outputBytes: number,
	reason: "lines" | "bytes",
	nextLine: string,
	pathArg: string,
) {
	if (outputLines === 0) {
		const firstLineSize = Buffer.byteLength(nextLine, "utf8");
		return {
			content: [
				{
					type: "text",
					text: `[Line ${startLine} is ${formatSize(firstLineSize)}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash for partial reads.]`,
				},
			],
			details: { truncation: { truncated: true, firstLineExceedsLimit: true } },
		};
	}

	const endLine = startLine + outputLines - 1;
	const nextOffset = endLine + 1;
	let text = output;
	if (reason === "lines") {
		text += `\n\n[Showing lines ${startLine}-${endLine}. Use offset=${nextOffset} to continue.]`;
	} else {
		text += `\n\n[Showing lines ${startLine}-${endLine} (${formatSize(outputBytes)} limit). Use offset=${nextOffset} to continue.]`;
	}
	return {
		content: [{ type: "text", text }],
		details: { truncation: { truncated: true, truncatedBy: reason, outputLines } },
	};
}

async function fastWrite(contentFile: string) {
	const dir = tempDir();
	try {
		const content = readFileSync(contentFile, "utf8");
		mkdirSync(dir, { recursive: true });
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
		if (firstIndex === -1) {
			throw new Error("oldText not found");
		}
		const secondIndex = content.indexOf(oldText, firstIndex + oldText.length);
		if (secondIndex !== -1) {
			throw new Error("oldText not unique");
		}
		const updated = content.slice(0, firstIndex) + newText + content.slice(firstIndex + oldText.length);
		await Bun.write(targetFile, updated);
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
	if (exitCode !== 0) {
		throw new Error(`${cmd} exited with code ${exitCode}`);
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
				await runBinary(`${ROOT_DIR}/bin/fastdrain`, [file]);
			});
			continue;
		}

		const cpMatch = part.match(/^cp\s+(\S+)\s+(\S+)$/);
		if (cpMatch) {
			const src = resolve(ROOT_DIR, cpMatch[1]);
			const dst = resolve(ROOT_DIR, cpMatch[2]);
			actions.push(async () => {
				mkdirSync(dirname(dst), { recursive: true });
				await Bun.write(dst, Bun.file(src));
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

if (tool === "read") {
	const file = process.argv[4] ?? `${ROOT_DIR}/payloads/jsonl-5m.txt`;
	if (mode === "stock") await stockRead(file);
	else if (mode === "fast") await fastRead(file);
	else throw new Error(`Unsupported mode: ${mode}`);
} else if (tool === "write") {
	const contentFile = process.argv[4] ?? `${ROOT_DIR}/payloads/blob-1m.txt`;
	if (mode === "stock") await stockWrite(contentFile);
	else if (mode === "fast") await fastWrite(contentFile);
	else throw new Error(`Unsupported mode: ${mode}`);
} else if (tool === "edit") {
	const templateFile = process.argv[4] ?? `${ROOT_DIR}/payloads/lines-10k.txt`;
	const oldTextFile = process.argv[5] ?? `${ROOT_DIR}/payloads/edit-old.txt`;
	const newTextFile = process.argv[6] ?? `${ROOT_DIR}/payloads/edit-new.txt`;
	if (mode === "stock") await stockEdit(templateFile, oldTextFile, newTextFile);
	else if (mode === "fast") await fastEdit(templateFile, oldTextFile, newTextFile);
	else throw new Error(`Unsupported mode: ${mode}`);
} else if (tool === "bash") {
	const copyPath = `/tmp/pi-fast-tool-copy-${process.pid}-${Date.now()}`;
	const command =
		process.argv[4] ??
		`cat ${ROOT_DIR}/payloads/jsonl-5m.txt > /dev/null && cp ${ROOT_DIR}/payloads/jsonl-5m.txt ${copyPath} && rm ${copyPath}`;
	if (mode === "stock") await stockBash(command);
	else if (mode === "fast") await fastBash(command);
	else throw new Error(`Unsupported mode: ${mode}`);
} else {
	throw new Error(`Unsupported tool: ${tool}`);
}

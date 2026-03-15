import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBashTool } from "/home/frensiqatipi1/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/dist/core/tools/bash.js";
import { createEditTool } from "/home/frensiqatipi1/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/dist/core/tools/edit.js";
import { createReadTool } from "/home/frensiqatipi1/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/dist/core/tools/read.js";
import { createWriteTool } from "/home/frensiqatipi1/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/dist/core/tools/write.js";

const ROOT_DIR = "/home/frensiqatipi1/bun-stdin-bench";
const tool = process.argv[2];

if (!tool) {
	throw new Error("Missing tool name");
}

const makeTempDir = () => {
	const dir = join(tmpdir(), `pi-tool-bench-${process.pid}-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
};

const execute = async () => {
	switch (tool) {
		case "read": {
			const file = process.argv[3] ?? `${ROOT_DIR}/payloads/jsonl-5m.txt`;
			const readTool = createReadTool(ROOT_DIR);
			await readTool.execute("bench-read", { path: file }, undefined as any);
			break;
		}
		case "write": {
			const contentFile = process.argv[3] ?? `${ROOT_DIR}/payloads/blob-1m.txt`;
			const content = readFileSync(contentFile, "utf8");
			const dir = makeTempDir();
			try {
				const writeTool = createWriteTool(dir);
				await writeTool.execute("bench-write", { path: "out.txt", content }, undefined as any);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
			break;
		}
		case "edit": {
			const templateFile = process.argv[3] ?? `${ROOT_DIR}/payloads/lines-10k.txt`;
			const oldTextFile = process.argv[4] ?? `${ROOT_DIR}/payloads/edit-old.txt`;
			const newTextFile = process.argv[5] ?? `${ROOT_DIR}/payloads/edit-new.txt`;
			const dir = makeTempDir();
			try {
				const targetFile = join(dir, "edit-target.txt");
				writeFileSync(targetFile, readFileSync(templateFile, "utf8"), "utf8");
				const editTool = createEditTool(dir);
				await editTool.execute(
					"bench-edit",
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
			break;
		}
		case "bash": {
			const copyPath = `/tmp/pi-tool-copy-${process.pid}-${Date.now()}`;
			const command =
				process.argv[3] ??
				`cat ${ROOT_DIR}/payloads/jsonl-5m.txt > /dev/null && cp ${ROOT_DIR}/payloads/jsonl-5m.txt ${copyPath} && rm ${copyPath}`;
			const bashTool = createBashTool(ROOT_DIR);
			await bashTool.execute("bench-bash", { command }, undefined as any, undefined);
			break;
		}
		default:
			throw new Error(`Unsupported tool: ${tool}`);
	}
};

await execute();

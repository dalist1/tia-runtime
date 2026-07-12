// Burst benchmark for the real in-process fast-tools extension code path.
// Usage: PI_CODING_AGENT_DIR=<agent dir> bun bench/fast-tools-extension-burst.ts <read|write|edit> <iterations>
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

const ROOT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const optimizationVersion = readFileSync(join(ROOT_DIR, "OPTIMIZATION_VERSION"), "utf8").trim();
const tool = process.argv[2];
const iterations = Number(process.argv[3] ?? 20);

if (!tool || !Number.isFinite(iterations) || iterations <= 0) {
	throw new Error("Usage: fast-tools-extension-burst.ts <read|write|edit> <iterations>");
}
if (!process.env.PI_CODING_AGENT_DIR) throw new Error("Set PI_CODING_AGENT_DIR");

const extensionPath = process.env.TIA_FAST_TOOLS_EXTENSION ?? "../scripts/fast-tools-extension.ts";
const ext = await import(extensionPath);

const workDir = join(tmpdir(), `tia-ext-burst-${process.pid}-${randomUUID()}`);
mkdirSync(workDir, { recursive: true });

const cleanup = () => {
	rmSync(workDir, { recursive: true, force: true });
};
process.on("exit", cleanup);

const run = async () => {
	if (tool === "read") {
		const file = `${ROOT_DIR}/payloads/jsonl-5m.txt`;
		for (let i = 0; i < iterations; i += 1) {
			await ext.fastRead(ROOT_DIR, file);
		}
		return;
	}

	if (tool === "write") {
		const content = readFileSync(`${ROOT_DIR}/payloads/blob-1m.txt`, "utf8");
		for (let i = 0; i < iterations; i += 1) {
			const target = join(workDir, `write-${i}.txt`);
			await ext.fastWrite(workDir, target, content);
			rmSync(target, { force: true });
		}
		return;
	}

	if (tool === "edit") {
		const template = readFileSync(`${ROOT_DIR}/payloads/lines-10k.txt`, "utf8");
		const oldText = readFileSync(`${ROOT_DIR}/payloads/edit-old.txt`, "utf8");
		const newText = readFileSync(`${ROOT_DIR}/payloads/edit-new.txt`, "utf8");
		for (let i = 0; i < iterations; i += 1) {
			const target = join(workDir, `edit-${i}.txt`);
			writeFileSync(target, template, "utf8");
			await ext.fastEdit(workDir, [{ path: target, oldText, newText }]);
			rmSync(target, { force: true });
		}
		return;
	}

	throw new Error(`Unsupported tool: ${tool}`);
};

const start = performance.now();
await run();
const end = performance.now();

console.log(JSON.stringify({ optimizationVersion, tool, iterations, elapsedMs: end - start, perIterationMs: (end - start) / iterations }));

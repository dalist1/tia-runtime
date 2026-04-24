import { spawn } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

function detectRootDir() {
	if (process.env.TIA_BENCH_ROOT_DIR) return resolve(process.env.TIA_BENCH_ROOT_DIR);
	const moduleDir = dirname(fileURLToPath(import.meta.url));
	if (basename(moduleDir) === "bench") return dirname(moduleDir);
	const executableDir = dirname(process.execPath);
	if (basename(executableDir) === "bin") return dirname(executableDir);
	return process.cwd();
}

const ROOT_DIR = detectRootDir();
const transport = process.argv[2];
const mode = process.argv[3];
const tool = process.argv[4];
const iterations = Number(process.argv[5] ?? 20);

if ((transport !== "spawn" && transport !== "daemon") || (mode !== "stock" && mode !== "fast") || !tool) {
	throw new Error("Usage: pi-tool-request-loop.ts <spawn|daemon> <stock|fast> <tool> <iterations>");
}

if (!Number.isFinite(iterations) || iterations <= 0) {
	throw new Error(`Invalid iterations: ${process.argv[5]}`);
}

type JsonValue = Record<string, any>;

function spawnJsonCommand(command: string, args: string[]) {
	const child = spawn(command, args, {
		cwd: ROOT_DIR,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	return new Promise<JsonValue>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code !== 0) {
				reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
				return;
			}
			try {
				resolve(JSON.parse(stdout.trim()));
			} catch (error) {
				reject(error);
			}
		});
	});
}

class DaemonClient {
	private child = spawn(`${ROOT_DIR}/bin/pi-tool-override-daemon`, [mode], {
		cwd: ROOT_DIR,
		stdio: ["pipe", "pipe", "pipe"],
	});
	private buffer = "";
	private nextId = 1;
	private readyResolve!: (value: JsonValue) => void;
	private readyReject!: (error: unknown) => void;
	private readyPromise = new Promise<JsonValue>((resolve, reject) => {
		this.readyResolve = resolve;
		this.readyReject = reject;
	});
	private inflight = new Map<string, { resolve: (value: JsonValue) => void; reject: (error: unknown) => void }>();
	private exited = new Promise<number>((resolve, reject) => {
		this.child.once("error", reject);
		this.child.once("exit", (code) => resolve(code ?? 1));
	});

	constructor() {
		this.child.stdout.setEncoding("utf8");
		this.child.stderr.setEncoding("utf8");
		let stderr = "";
		this.child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		this.child.stdout.on("data", (chunk) => {
			this.buffer += chunk;
			for (;;) {
				const newlineIndex = this.buffer.indexOf("\n");
				if (newlineIndex === -1) break;
				let line = this.buffer.slice(0, newlineIndex);
				this.buffer = this.buffer.slice(newlineIndex + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				if (!line) continue;
				const message = JSON.parse(line);
				if (message.type === "ready") {
					this.readyResolve(message);
					continue;
				}
				const entry = this.inflight.get(message.id ?? "");
				if (entry) {
					this.inflight.delete(message.id ?? "");
					entry.resolve(message);
				}
			}
		});
		this.child.once("exit", (code) => {
			const error = new Error(stderr.trim() || `daemon exited with code ${code ?? 1}`);
			this.readyReject(error);
			for (const entry of this.inflight.values()) {
				entry.reject(error);
			}
			this.inflight.clear();
		});
	}

	async waitUntilReady() {
		return await this.readyPromise;
	}

	request(payload: JsonValue) {
		const id = `req-${this.nextId++}`;
		return new Promise<JsonValue>((resolve, reject) => {
			this.inflight.set(id, { resolve, reject });
			this.child.stdin.write(`${JSON.stringify({ ...payload, id })}\n`, (error) => {
				if (error) {
					this.inflight.delete(id);
					reject(error);
				}
			});
		});
	}

	async shutdown() {
		const response = await this.request({ tool: "shutdown" });
		if (!response.ok) {
			throw new Error(`shutdown failed: ${JSON.stringify(response)}`);
		}
		this.child.stdin.end();
		const code = await this.exited;
		if (code !== 0) {
			throw new Error(`daemon exited with code ${code}`);
		}
	}
}

async function runSpawnLoop() {
	let firstResponseMs: number | null = null;
	const start = performance.now();
	for (let i = 0; i < iterations; i += 1) {
		await spawnJsonCommand(`${ROOT_DIR}/bin/pi-tool-override-burst`, [mode, tool, "1"]);
		if (firstResponseMs === null) {
			firstResponseMs = performance.now() - start;
		}
	}
	const end = performance.now();
	return {
		transport,
		mode,
		tool,
		iterations,
		daemonReadyMs: null,
		firstResponseMs,
		elapsedMs: end - start,
		perIterationMs: (end - start) / iterations,
	};
}

async function runDaemonLoop() {
	const daemonStart = performance.now();
	const client = new DaemonClient();
	await client.waitUntilReady();
	const daemonReadyMs = performance.now() - daemonStart;
	let firstResponseMs: number | null = null;
	const start = performance.now();
	for (let i = 0; i < iterations; i += 1) {
		const response = await client.request({ tool });
		if (!response.ok) {
			throw new Error(`request failed: ${JSON.stringify(response)}`);
		}
		if (firstResponseMs === null) {
			firstResponseMs = performance.now() - start;
		}
	}
	const end = performance.now();
	await client.shutdown();
	return {
		transport,
		mode,
		tool,
		iterations,
		daemonReadyMs,
		firstResponseMs,
		elapsedMs: end - start,
		perIterationMs: (end - start) / iterations,
	};
}

const result = transport === "spawn" ? await runSpawnLoop() : await runDaemonLoop();
console.log(JSON.stringify(result));

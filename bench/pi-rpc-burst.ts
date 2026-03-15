import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

const ROOT_DIR = "/home/frensiqatipi1/bun-stdin-bench";
const mode = process.argv[2] ?? "direct";
const iterations = Number(process.argv[3] ?? 100);
const requestFile = process.argv[4] ?? `${ROOT_DIR}/payloads-rpc/empty.get-state.jsonl`;

if (!Number.isFinite(iterations) || iterations <= 0) {
	throw new Error(`Invalid iterations: ${process.argv[3]}`);
}

const requestTemplate = JSON.parse(readFileSync(requestFile, "utf8").trim());

const child =
	mode === "cli"
		? spawn(
				"bun",
				[
					"/home/frensiqatipi1/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/dist/cli.js",
					"--mode",
					"rpc",
					"--no-session",
					"--no-extensions",
					"--no-skills",
					"--no-prompt-templates",
					"--no-themes",
				],
				{
					cwd: ROOT_DIR,
					env: { ...process.env, PI_SKIP_VERSION_CHECK: "1" },
					stdio: ["pipe", "pipe", "inherit"],
				},
			)
		: spawn(`${ROOT_DIR}/bin/pi-rpc-direct`, [], {
				cwd: ROOT_DIR,
				env: {
					...process.env,
					PI_SKIP_VERSION_CHECK: "1",
					PI_PACKAGE_DIR:
						"/home/frensiqatipi1/.bun/install/global/node_modules/@mariozechner/pi-coding-agent",
				},
				stdio: ["pipe", "pipe", "inherit"],
			});

const inflight = new Map<string, (value: any) => void>();
let buffer = "";

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
	buffer += chunk;
	for (;;) {
		const newlineIndex = buffer.indexOf("\n");
		if (newlineIndex === -1) {
			break;
		}
		let line = buffer.slice(0, newlineIndex);
		buffer = buffer.slice(newlineIndex + 1);
		if (line.endsWith("\r")) {
			line = line.slice(0, -1);
		}
		if (!line) {
			continue;
		}
		const message = JSON.parse(line);
		if (message.type !== "response") {
			continue;
		}
		const resolver = inflight.get(message.id ?? "");
		if (resolver) {
			inflight.delete(message.id ?? "");
			resolver(message);
		}
	}
});

const waitForResponse = (id: string, payload: Record<string, unknown>) => {
	return new Promise<any>((resolve, reject) => {
		inflight.set(id, resolve);
		child.stdin.write(`${JSON.stringify({ ...payload, id })}\n`, (error) => {
			if (error) {
				inflight.delete(id);
				reject(error);
			}
		});
	});
};

const ensureSuccess = (response: any) => {
	if (!response?.success) {
		throw new Error(`RPC failed: ${JSON.stringify(response)}`);
	}
};

const warmup = await waitForResponse("warmup", requestTemplate);
ensureSuccess(warmup);

const start = performance.now();
const promises: Promise<any>[] = [];
for (let i = 0; i < iterations; i += 1) {
	promises.push(waitForResponse(`bench-${i}`, requestTemplate));
}
const responses = await Promise.all(promises);
const end = performance.now();

for (const response of responses) {
	ensureSuccess(response);
}

child.stdin.end();
await new Promise<void>((resolve, reject) => {
	child.once("exit", (code) => {
		if (code === 0) {
			resolve();
			return;
		}
		reject(new Error(`Child exited with code ${code}`));
	});
	child.once("error", reject);
});

console.log(
	JSON.stringify({
		mode,
		iterations,
		requestFile,
		elapsedMs: end - start,
		perRequestMs: (end - start) / iterations,
	})
);

import { performance } from "node:perf_hooks";
import {
	createOpencodeClient,
	createOpencodeServer,
} from "/home/frensiqatipi1/.config/opencode/node_modules/@opencode-ai/sdk/dist/v2/index.js";

const mode = process.argv[2] ?? "baseline";
const directory = process.argv[3] ?? "/home/frensiqatipi1/bun-stdin-bench";
const command =
	process.argv[4] ??
	`cat /home/frensiqatipi1/bun-stdin-bench/payloads/lines-10k.txt > /dev/null`;
const serverTimeoutMs = Number(process.env.SERVER_TIMEOUT_MS ?? 15000);
const pollIntervalMs = Number(process.env.PTY_POLL_INTERVAL_MS ?? 50);

const configDirByMode: Record<string, string | undefined> = {
	baseline: "/home/frensiqatipi1/bun-stdin-bench/opencode-baseline",
	optimized: "/home/frensiqatipi1/bun-stdin-bench/opencode-optimized",
};

const configDir = configDirByMode[mode];

if (!(mode in configDirByMode)) {
	throw new Error(`Unsupported mode: ${mode}`);
}

if (configDir) {
	process.env.OPENCODE_CONFIG_DIR = configDir;
} else {
	delete process.env.OPENCODE_CONFIG_DIR;
}

const start = performance.now();
const port = 20000 + Math.floor(Math.random() * 20000);
const server = await createOpencodeServer({ timeout: serverTimeoutMs, port });
const ready = performance.now();
const client = createOpencodeClient({ baseUrl: server.url });
let ptyID: string | undefined;

const cleanup = async () => {
	if (!ptyID) {
		server.close();
		return;
	}

	try {
		const removed = await client.pty.remove({ ptyID, directory });
		if (!removed.data && removed.error?.name !== "NotFoundError") {
			console.error(`Failed to remove PTY ${ptyID}: ${JSON.stringify(removed.error)}`);
		}
	} catch (error) {
		console.error(`Failed to remove PTY ${ptyID}: ${error}`);
	} finally {
		server.close();
	}
};

try {
	const ptyResult = await client.pty.create({
		directory,
		cwd: directory,
		command: "bash",
		args: ["-lc", command],
		title: `bench-${mode}`,
	});
	if (!ptyResult.data) {
		throw new Error(`Failed to create PTY: ${JSON.stringify(ptyResult.error)}`);
	}

	ptyID = ptyResult.data.id;
	const deadline = performance.now() + serverTimeoutMs;

	for (;;) {
		const state = await client.pty.get({ ptyID, directory });
		if (!state.data) {
			if (state.error?.name === "NotFoundError") {
				break;
			}
			throw new Error(`Failed to fetch PTY state: ${JSON.stringify(state.error)}`);
		}
		if (state.data.status === "exited") {
			break;
		}
		if (performance.now() > deadline) {
			throw new Error(`PTY did not exit in time for mode=${mode}`);
		}
		await Bun.sleep(pollIntervalMs);
	}

	const end = performance.now();
	const startupMs = ready - start;
	const totalMs = end - start;
	const shellMs = totalMs - startupMs;

	console.log(
		JSON.stringify({
			mode,
			startupMs,
			shellMs,
			totalMs,
			serverUrl: server.url,
		})
	);
} finally {
	await cleanup();
}

process.exit(0);

process.env.PI_PACKAGE_DIR ??= "/home/frensiqatipi1/.bun/install/global/node_modules/@mariozechner/pi-coding-agent";

import { join } from "node:path";
import { spawn } from "node:child_process";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
	getAgentDir,
	AuthStorage,
	ModelRegistry,
} from "/home/frensiqatipi1/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/dist/index.js";

class BufferedJsonlWriter {
	private buffer = "";
	private writing = false;
	private waiters: Array<() => void> = [];

	enqueue(value: unknown) {
		this.buffer += `${JSON.stringify(value)}\n`;
		this.kick();
	}

	private kick() {
		if (this.writing || this.buffer.length === 0) {
			return;
		}
		this.writing = true;
		queueMicrotask(() => this.flush());
	}

	private flush() {
		const chunk = this.buffer;
		this.buffer = "";
		process.stdout.write(chunk, () => {
			this.writing = false;
			if (this.buffer.length > 0) {
				this.kick();
				return;
			}
			const waiters = this.waiters;
			this.waiters = [];
			for (const resolve of waiters) {
				resolve();
			}
		});
	}

	async drain() {
		if (!this.writing && this.buffer.length === 0) {
			return;
		}
		await new Promise<void>((resolve) => {
			this.waiters.push(resolve);
			this.kick();
		});
	}
}

type ParsedArgs = {
	provider?: string;
	modelId?: string;
	thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	messages: string[];
	extensionPaths: string[];
	noSession: boolean;
	noExtensions: boolean;
	noSkills: boolean;
	noPromptTemplates: boolean;
	noThemes: boolean;
	noTools: boolean;
	toolsList?: string[];
};

function parseArgs(argv: string[]): ParsedArgs {
	const parsed: ParsedArgs = {
		messages: [],
		extensionPaths: [],
		noSession: false,
		noExtensions: false,
		noSkills: false,
		noPromptTemplates: false,
		noThemes: false,
		noTools: false,
	};

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--mode") {
			const value = argv[++i];
			if (value !== "json") throw new Error(`Unsupported mode for fast json runner: ${value}`);
			continue;
		}
		if (arg === "--provider") {
			parsed.provider = argv[++i];
			continue;
		}
		if (arg === "--model") {
			parsed.modelId = argv[++i];
			continue;
		}
		if (arg === "--thinking") {
			parsed.thinkingLevel = argv[++i] as ParsedArgs["thinkingLevel"];
			continue;
		}
		if (arg === "--no-session") {
			parsed.noSession = true;
			continue;
		}
		if (arg === "--no-extensions") {
			parsed.noExtensions = true;
			continue;
		}
		if (arg === "--no-skills") {
			parsed.noSkills = true;
			continue;
		}
		if (arg === "--no-prompt-templates") {
			parsed.noPromptTemplates = true;
			continue;
		}
		if (arg === "--no-themes") {
			parsed.noThemes = true;
			continue;
		}
		if (arg === "--no-tools") {
			parsed.noTools = true;
			continue;
		}
		if (arg === "--tools") {
			parsed.toolsList = argv[++i].split(",").map((value) => value.trim()).filter(Boolean);
			continue;
		}
		if (arg === "-e" || arg === "--extension") {
			parsed.extensionPaths.push(argv[++i]);
			continue;
		}
		if (arg.startsWith("-")) {
			throw new Error(`Unsupported argument for fast json runner: ${arg}`);
		}
		parsed.messages.push(arg);
	}

	return parsed;
}

async function bindPrintExtensions(session: Awaited<ReturnType<typeof createAgentSession>>["session"]) {
	await session.bindExtensions({
		commandContextActions: {
			waitForIdle: () => session.agent.waitForIdle(),
			newSession: async (options) => {
				const success = await session.newSession({ parentSession: options?.parentSession });
				if (success && options?.setup) {
					await options.setup(session.sessionManager);
				}
				return { cancelled: !success };
			},
			fork: async (entryId) => {
				const result = await session.fork(entryId);
				return { cancelled: result.cancelled };
			},
			navigateTree: async (targetId, options) => {
				const result = await session.navigateTree(targetId, {
					summarize: options?.summarize,
					customInstructions: options?.customInstructions,
					replaceInstructions: options?.replaceInstructions,
					label: options?.label,
				});
				return { cancelled: result.cancelled };
			},
			switchSession: async (sessionPath) => {
				const success = await session.switchSession(sessionPath);
				return { cancelled: !success };
			},
			reload: async () => {
				await session.reload();
			},
		},
		onError: (err) => {
			console.error(`Extension error (${err.extensionPath}): ${err.error}`);
		},
	});
}

async function main() {
	const parsed = parseArgs(process.argv.slice(2));
	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const writer = new BufferedJsonlWriter();
	const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
	const modelRegistry = new ModelRegistry(authStorage, join(agentDir, "models.json"));
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		additionalExtensionPaths: parsed.extensionPaths,
		noExtensions: parsed.noExtensions,
		noSkills: parsed.noSkills,
		noPromptTemplates: parsed.noPromptTemplates,
		noThemes: parsed.noThemes,
	});
	await resourceLoader.reload();
	const sessionManager = parsed.noSession ? SessionManager.inMemory(cwd) : SessionManager.create(cwd);
	const model = parsed.provider && parsed.modelId ? modelRegistry.find(parsed.provider, parsed.modelId) : undefined;
	if (parsed.provider && parsed.modelId && !model) {
		throw new Error(`Model not found: ${parsed.provider}/${parsed.modelId}`);
	}
	const tools = parsed.noTools ? [] : undefined;
	const { session, modelFallbackMessage } = await createAgentSession({
		cwd,
		agentDir,
		authStorage,
		modelRegistry,
		model,
		thinkingLevel: parsed.thinkingLevel,
		tools,
		resourceLoader,
		sessionManager,
		settingsManager,
	});
	if (!session.model && modelFallbackMessage) {
		throw new Error(modelFallbackMessage);
	}
	await bindPrintExtensions(session);
	const header = session.sessionManager.getHeader();
	if (header) writer.enqueue(header);
		session.subscribe((event) => {
		writer.enqueue(event);
	});
	for (const message of parsed.messages) {
		await session.prompt(message);
	}
	await writer.drain();
}

try {
	await main();
} catch (error) {
	const stock = process.env.TIA_STOCK_PI_BIN;
	if (stock) {
		const child = spawn(stock, process.argv.slice(2), { stdio: "inherit", env: process.env });
		const code = await new Promise<number>((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", (exitCode) => resolve(exitCode ?? 1));
		});
		process.exit(code);
	}
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}

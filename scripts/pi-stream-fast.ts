process.env.PI_PACKAGE_DIR ??=
  "/home/frensiqatipi1/.bun/install/global/node_modules/@mariozechner/pi-coding-agent";

import { join } from "node:path";
import {
  AuthStorage,
  createAgentSession,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "/home/frensiqatipi1/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/dist/index.js";
import { createExtensionRuntime } from "/home/frensiqatipi1/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/index.js";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

type ParsedArgs = {
  provider?: string;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
  messages: string[];
};

function isThinkingLevel(value: string): value is ThinkingLevel {
  return ["off", "minimal", "low", "medium", "high", "xhigh"].includes(value);
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { messages: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--mode") {
      const value = argv[++i];
      if (value !== "json") throw new Error(`Unsupported mode for direct stream runner: ${value}`);
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
      const value = argv[++i];
      if (!isThinkingLevel(value)) throw new Error(`Unsupported thinking level: ${value}`);
      parsed.thinkingLevel = value;
      continue;
    }
    if (
      arg === "--no-session" ||
      arg === "--no-extensions" ||
      arg === "--no-skills" ||
      arg === "--no-prompt-templates" ||
      arg === "--no-themes" ||
      arg === "--no-tools"
    ) {
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unsupported argument for direct stream runner: ${arg}`);
    }
    parsed.messages.push(arg);
  }
  return parsed;
}

class SlimStreamWriter {
  private outBuffer = "";
  private deltaBuffer = new Map<number, string>();
  private writing = false;
  private waiters: Array<() => void> = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  enqueue(event: unknown) {
    this.outBuffer += `${JSON.stringify(event)}\n`;
    if (this.outBuffer.length >= 16384) {
      this.flushSoon(true);
      return;
    }
    this.flushSoon(false);
  }

  enqueueDelta(index: number, delta: string) {
    this.deltaBuffer.set(index, `${this.deltaBuffer.get(index) ?? ""}${delta}`);
    if ((this.deltaBuffer.get(index)?.length ?? 0) >= 96) {
      this.flushDeltas();
      this.flushSoon(true);
      return;
    }
    this.flushSoon(false);
  }

  flushDeltaIndex(index: number) {
    const delta = this.deltaBuffer.get(index);
    if (!delta) return;
    this.deltaBuffer.delete(index);
    this.enqueue({ t: "d", i: index, s: delta });
  }

  flushDeltas() {
    for (const index of [...this.deltaBuffer.keys()].sort((a, b) => a - b)) {
      this.flushDeltaIndex(index);
    }
  }

  private flushSoon(immediate: boolean) {
    if (this.timer) {
      if (!immediate) return;
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (immediate) {
      queueMicrotask(() => this.flush());
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 4);
  }

  private flush() {
    this.flushDeltas();
    if (this.writing || this.outBuffer.length === 0) {
      return;
    }
    this.writing = true;
    const chunk = this.outBuffer;
    this.outBuffer = "";
    process.stdout.write(chunk, () => {
      this.writing = false;
      if (this.outBuffer.length > 0 || this.deltaBuffer.size > 0) {
        this.flushSoon(true);
        return;
      }
      const waiters = this.waiters;
      this.waiters = [];
      for (const resolve of waiters) resolve();
    });
  }

  async drain() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.flush();
    if (!this.writing && this.outBuffer.length === 0 && this.deltaBuffer.size === 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
      this.flushSoon(true);
    });
  }
}

const parsed = parseArgs(process.argv.slice(2));
const cwd = process.cwd();
const agentDir = getAgentDir();
const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
const modelRegistry = new ModelRegistry(authStorage, join(agentDir, "models.json"));
const settingsManager = SettingsManager.create(cwd, agentDir);
const resourceLoader: any = {
  getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
  getSkills: () => ({ skills: [], diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () => "",
  getAppendSystemPrompt: () => [],
  getPathMetadata: () => new Map(),
  extendResources: () => {},
  reload: async () => {},
};
const model =
  parsed.provider && parsed.modelId
    ? modelRegistry.find(parsed.provider, parsed.modelId)
    : undefined;
if (parsed.provider && parsed.modelId && !model) {
  throw new Error(`Model not found: ${parsed.provider}/${parsed.modelId}`);
}
const { session, modelFallbackMessage } = await createAgentSession({
  cwd,
  agentDir,
  authStorage,
  modelRegistry,
  model,
  thinkingLevel: parsed.thinkingLevel,
  tools: [],
  resourceLoader,
  sessionManager: SessionManager.inMemory(cwd),
  settingsManager,
});
if (!session.model && modelFallbackMessage) {
  throw new Error(modelFallbackMessage);
}

const writer = new SlimStreamWriter();
writer.enqueue({ t: "session", model: session.model?.id, provider: session.model?.provider });

session.subscribe((event: any) => {
  if (event?.type === "message_update") {
    const inner = event.assistantMessageEvent;
    if (inner?.type === "text_start") {
      writer.enqueue({ t: "s", i: inner.contentIndex });
      return;
    }
    if (inner?.type === "text_delta") {
      writer.enqueueDelta(inner.contentIndex, inner.delta ?? "");
      return;
    }
    if (inner?.type === "text_end") {
      writer.flushDeltaIndex(inner.contentIndex);
      writer.enqueue({ t: "e", i: inner.contentIndex });
    }
    return;
  }
  if (event?.type === "turn_end") {
    writer.flushDeltas();
    writer.enqueue({
      t: "done",
      usage: event.message?.usage,
      stopReason: event.message?.stopReason,
    });
  }
});

for (const message of parsed.messages) {
  await session.prompt(message);
}
await writer.drain();

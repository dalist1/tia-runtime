process.env.PI_PACKAGE_DIR ??= "__PI_PACKAGE_DIR__";

import { join } from "node:path";
import { AuthStorage } from "__PI_PACKAGE_DIR__/dist/core/auth-storage.js";
import { getAgentDir } from "__PI_PACKAGE_DIR__/dist/config.js";
import { ModelRegistry } from "__PI_PACKAGE_DIR__/dist/core/model-registry.js";
import { findInitialModel } from "__PI_PACKAGE_DIR__/dist/core/model-resolver.js";
import { SettingsManager } from "__PI_PACKAGE_DIR__/dist/core/settings-manager.js";
import { streamSimple } from "__PI_PACKAGE_DIR__/../pi-ai/dist/stream.js";
import type {
  AssistantMessage,
  Context,
  SimpleStreamOptions,
} from "__PI_PACKAGE_DIR__/../pi-ai/dist/types.js";

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

function requireValue(argv: string[], index: number, flag: string) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { messages: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--mode") {
      const value = requireValue(argv, i, arg);
      i += 1;
      if (value !== "json") throw new Error(`Unsupported mode for direct stream runner: ${value}`);
      continue;
    }
    if (arg.startsWith("--mode=")) {
      const value = arg.slice("--mode=".length);
      if (value !== "json") throw new Error(`Unsupported mode for direct stream runner: ${value}`);
      continue;
    }
    if (arg === "--provider") {
      parsed.provider = requireValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg.startsWith("--provider=")) {
      parsed.provider = arg.slice("--provider=".length);
      continue;
    }
    if (arg === "--model") {
      parsed.modelId = requireValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg.startsWith("--model=")) {
      parsed.modelId = arg.slice("--model=".length);
      continue;
    }
    if (arg === "--thinking") {
      const value = requireValue(argv, i, arg);
      i += 1;
      if (!isThinkingLevel(value)) throw new Error(`Unsupported thinking level: ${value}`);
      parsed.thinkingLevel = value;
      continue;
    }
    if (arg.startsWith("--thinking=")) {
      const value = arg.slice("--thinking=".length);
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
      arg === "--no-tools" ||
      arg === "--no-context-files" ||
      arg === "--print" ||
      arg === "-p"
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
    this.appendRaw(`${JSON.stringify(event)}\n`);
  }

  enqueueTextStart(index: number) {
    this.appendRaw(`{"t":"s","i":${index}}\n`);
  }

  enqueueTextEnd(index: number) {
    this.flushDeltaIndex(index);
    this.appendRaw(`{"t":"e","i":${index}}\n`);
  }

  enqueueDelta(index: number, delta: string) {
    this.deltaBuffer.set(index, `${this.deltaBuffer.get(index) ?? ""}${delta}`);
    if ((this.deltaBuffer.get(index)?.length ?? 0) >= 96) {
      this.flushDeltaIndex(index);
      this.flushSoon(true);
      return;
    }
    this.flushSoon(false);
  }

  flushDeltaIndex(index: number) {
    const delta = this.deltaBuffer.get(index);
    if (!delta) return;
    this.deltaBuffer.delete(index);
    this.appendRaw(`{"t":"d","i":${index},"s":${JSON.stringify(delta)}}\n`, false);
  }

  flushDeltas() {
    for (const index of [...this.deltaBuffer.keys()].sort((a, b) => a - b)) {
      this.flushDeltaIndex(index);
    }
  }

  private appendRaw(line: string, schedule = true) {
    this.outBuffer += line;
    if (!schedule) return;
    if (this.outBuffer.length >= 16384) {
      this.flushSoon(true);
      return;
    }
    this.flushSoon(false);
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

function resolveReasoning(
  level: ThinkingLevel | undefined,
  model: { reasoning?: boolean },
): SimpleStreamOptions["reasoning"] {
  if (!model.reasoning || !level || level === "off") return undefined;
  return level;
}

const parsed = parseArgs(process.argv.slice(2));
const cwd = process.cwd();
const agentDir = getAgentDir();
const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
const settingsManager = SettingsManager.create(cwd, agentDir);

const initialModel = await findInitialModel({
  cliProvider: parsed.provider,
  cliModel: parsed.modelId,
  scopedModels: [],
  isContinuing: false,
  defaultProvider: settingsManager.getDefaultProvider(),
  defaultModelId: settingsManager.getDefaultModel(),
  defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
  modelRegistry,
});
const model = initialModel.model;
if (!model) {
  throw new Error(initialModel.fallbackMessage ?? "No configured model available");
}
const thinkingLevel = parsed.thinkingLevel ?? initialModel.thinkingLevel;
const auth = await modelRegistry.getApiKeyAndHeaders(model);
if (!auth.ok) {
  throw new Error(auth.error);
}

const providerRetrySettings = settingsManager.getProviderRetrySettings();
const streamOptions: SimpleStreamOptions = {
  apiKey: auth.apiKey,
  headers: auth.headers,
  reasoning: resolveReasoning(thinkingLevel, model),
  thinkingBudgets: settingsManager.getThinkingBudgets(),
  transport: settingsManager.getTransport(),
  timeoutMs: providerRetrySettings.timeoutMs,
  maxRetries: providerRetrySettings.maxRetries,
  maxRetryDelayMs: providerRetrySettings.maxRetryDelayMs,
};

const writer = new SlimStreamWriter();
writer.enqueue({ t: "session", model: model.id, provider: model.provider });

const messages: Context["messages"] = [];

async function prompt(message: string) {
  messages.push({ role: "user", content: message, timestamp: Date.now() });
  const context: Context = { systemPrompt: "", messages, tools: [] };
  const stream = streamSimple(model, context, streamOptions);
  let finalMessage: AssistantMessage | undefined;

  for await (const event of stream) {
    if (event?.type === "text_start") {
      writer.enqueueTextStart(event.contentIndex);
      continue;
    }
    if (event?.type === "text_delta") {
      writer.enqueueDelta(event.contentIndex, event.delta ?? "");
      continue;
    }
    if (event?.type === "text_end") {
      writer.enqueueTextEnd(event.contentIndex);
      continue;
    }
    if (event?.type === "done") {
      finalMessage = event.message;
      continue;
    }
    if (event?.type === "error") {
      finalMessage = event.error;
    }
  }

  finalMessage ??= await stream.result();
  writer.flushDeltas();
  writer.enqueue({
    t: "done",
    usage: finalMessage?.usage,
    stopReason: finalMessage?.stopReason,
    error: finalMessage?.errorMessage,
  });
  if (finalMessage) messages.push(finalMessage);
}

for (const message of parsed.messages) {
  await prompt(message);
}
await writer.drain();

import { createReadStream, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import {
  createBashTool,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExtensionAPI,
  formatSize,
  getAgentDir,
} from "@mariozechner/pi-coding-agent";

const FAST_TOOLS_DIR = join(getAgentDir(), "fast-tools");
const FASTDRAIN_BIN = join(FAST_TOOLS_DIR, "fastdrain");
const FASTCOPY_BIN = join(FAST_TOOLS_DIR, "fastcopy");
const READ_PROGRESS_MIN_LINES = 128;
const READ_PROGRESS_MIN_BYTES = 8 * 1024;
const READ_PROGRESS_MIN_INTERVAL_MS = 120;

type TextToolUpdate = {
  content: Array<{ type: "text"; text: string }>;
  details?: any;
};

type ToolUpdateFn = ((update: TextToolUpdate) => void) | undefined;

type OptimizedBashStep = {
  description: string;
  run: () => Promise<void>;
};

const readSchema = Type.Object({
  path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
  offset: Type.Optional(
    Type.Number({ description: "Line number to start reading from (1-indexed)" }),
  ),
  limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

const writeSchema = Type.Object({
  path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
  content: Type.String({ description: "Content to write to the file" }),
});

const editSchema = Type.Object({
  path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
  oldText: Type.String({ description: "Exact text to find and replace (must match exactly)" }),
  newText: Type.String({ description: "New text to replace the old text with" }),
});

const bashSchema = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  timeout: Type.Optional(
    Type.Number({ description: "Timeout in seconds (optional, no default timeout)" }),
  ),
});

function expandPath(path: string) {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return `${homedir()}${path.slice(1)}`;
  }
  return path.startsWith("@") ? path.slice(1) : path;
}

function resolvePath(cwd: string, path: string) {
  return resolve(cwd, expandPath(path));
}

function emitTextUpdate(onUpdate: ToolUpdateFn, text: string, details?: any) {
  onUpdate?.({ content: [{ type: "text", text }], details });
}

function ensureNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new Error("Operation aborted");
  }
}

async function fastRead(
  cwd: string,
  pathArg: string,
  offset?: number,
  limit?: number,
  signal?: AbortSignal,
  onUpdate?: ToolUpdateFn,
) {
  ensureNotAborted(signal);

  const absolutePath = resolvePath(cwd, pathArg);
  const startLine = Math.max(1, offset ?? 1);
  const maxLines = limit ?? DEFAULT_MAX_LINES;
  let currentLine = 1;
  let output = "";
  let outputLines = 0;
  let outputBytes = 0;
  let carry = "";
  let lastProgressAt = 0;
  let lastProgressLines = 0;
  let lastProgressBytes = 0;

  const maybeEmitProgress = (force = false) => {
    if (!onUpdate || outputLines === 0) {
      return;
    }

    const now = Date.now();
    if (
      !force &&
      outputLines - lastProgressLines < READ_PROGRESS_MIN_LINES &&
      outputBytes - lastProgressBytes < READ_PROGRESS_MIN_BYTES &&
      now - lastProgressAt < READ_PROGRESS_MIN_INTERVAL_MS
    ) {
      return;
    }

    lastProgressAt = now;
    lastProgressLines = outputLines;
    lastProgressBytes = outputBytes;
    emitTextUpdate(onUpdate, output);
  };

  for await (const chunk of createReadStream(absolutePath, {
    encoding: "utf8",
    highWaterMark: 64 * 1024,
  })) {
    ensureNotAborted(signal);

    const combined = carry + chunk;
    const lines = combined.split("\n");
    carry = lines.pop() ?? "";

    for (const lineBody of lines) {
      const line = `${lineBody}\n`;
      if (currentLine >= startLine) {
        if (outputLines >= maxLines) {
          const endLine = startLine + outputLines - 1;
          const nextOffset = endLine + 1;
          return {
            content: [
              {
                type: "text",
                text: `${output}\n\n[Showing lines ${startLine}-${endLine}. Use offset=${nextOffset} to continue.]`,
              },
            ],
            details: { truncation: { truncated: true, truncatedBy: "lines", outputLines } },
          };
        }

        const nextBytes = Buffer.byteLength(line, "utf8");
        if (outputBytes + nextBytes > DEFAULT_MAX_BYTES) {
          if (outputLines === 0) {
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
          const endLine = startLine + outputLines - 1;
          const nextOffset = endLine + 1;
          return {
            content: [
              {
                type: "text",
                text: `${output}\n\n[Showing lines ${startLine}-${endLine} (${formatSize(outputBytes)} limit). Use offset=${nextOffset} to continue.]`,
              },
            ],
            details: { truncation: { truncated: true, truncatedBy: "bytes", outputLines } },
          };
        }

        output += line;
        outputLines += 1;
        outputBytes += nextBytes;
        maybeEmitProgress();
      }
      currentLine += 1;
    }
  }

  ensureNotAborted(signal);

  if (startLine > currentLine) {
    throw new Error(`Offset ${offset} is beyond end of file (${currentLine} lines total)`);
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
      outputBytes += nextBytes;
      maybeEmitProgress(true);
    }
  }

  return { content: [{ type: "text", text: output }], details: undefined };
}

async function fastWrite(cwd: string, pathArg: string, content: string, signal?: AbortSignal) {
  ensureNotAborted(signal);
  const absolutePath = resolvePath(cwd, pathArg);
  mkdirSync(dirname(absolutePath), { recursive: true });
  await Bun.write(absolutePath, content);
  ensureNotAborted(signal);
  return {
    content: [{ type: "text", text: `Successfully wrote ${content.length} bytes to ${pathArg}` }],
    details: undefined,
  };
}

async function fastEdit(
  cwd: string,
  pathArg: string,
  oldText: string,
  newText: string,
  signal?: AbortSignal,
) {
  ensureNotAborted(signal);
  const absolutePath = resolvePath(cwd, pathArg);
  const content = await Bun.file(absolutePath).text();
  ensureNotAborted(signal);
  const firstIndex = content.indexOf(oldText);
  if (firstIndex === -1) {
    throw new Error(
      `Could not find the exact text in ${pathArg}. The old text must match exactly including all whitespace and newlines.`,
    );
  }
  const secondIndex = content.indexOf(oldText, firstIndex + oldText.length);
  if (secondIndex !== -1) {
    throw new Error(
      `Found multiple occurrences of the text in ${pathArg}. The text must be unique.`,
    );
  }
  const updated =
    content.slice(0, firstIndex) + newText + content.slice(firstIndex + oldText.length);
  if (updated === content) {
    throw new Error(`No changes made to ${pathArg}. The replacement produced identical content.`);
  }
  await Bun.write(absolutePath, updated);
  ensureNotAborted(signal);
  return {
    content: [{ type: "text", text: `Successfully replaced text in ${pathArg}.` }],
    details: undefined,
  };
}

async function runBinary(cmd: string, args: string[]) {
  const proc = Bun.spawn([cmd, ...args], { stdout: "ignore", stderr: "ignore" });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`${cmd} exited with code ${exitCode}`);
  }
}

function planOptimizedBash(cwd: string, command: string): OptimizedBashStep[] | null {
  const parts = command
    .split("&&")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    return null;
  }

  const steps: OptimizedBashStep[] = [];

  for (const part of parts) {
    const catMatch = part.match(/^cat\s+(\S+)\s*>\s*\/dev\/null$/);
    if (catMatch) {
      const file = resolvePath(cwd, catMatch[1]);
      steps.push({
        description: `drain ${catMatch[1]}`,
        run: async () => {
          if (existsSync(FASTDRAIN_BIN)) {
            await runBinary(FASTDRAIN_BIN, [file]);
          } else {
            await Bun.file(file).arrayBuffer();
          }
        },
      });
      continue;
    }

    const cpMatch = part.match(/^cp\s+(\S+)\s+(\S+)$/);
    if (cpMatch) {
      const src = resolvePath(cwd, cpMatch[1]);
      const dst = resolvePath(cwd, cpMatch[2]);
      steps.push({
        description: `copy ${cpMatch[1]} -> ${cpMatch[2]}`,
        run: async () => {
          mkdirSync(dirname(dst), { recursive: true });
          if (existsSync(FASTCOPY_BIN)) {
            await runBinary(FASTCOPY_BIN, [src, dst]);
          } else {
            await Bun.write(dst, Bun.file(src));
          }
        },
      });
      continue;
    }

    const rmMatch = part.match(/^rm\s+(\S+)$/);
    if (rmMatch) {
      const target = resolvePath(cwd, rmMatch[1]);
      steps.push({
        description: `rm ${rmMatch[1]}`,
        run: async () => {
          rmSync(target, { force: true });
        },
      });
      continue;
    }

    return null;
  }

  return steps;
}

async function tryOptimizedBash(
  cwd: string,
  command: string,
  signal?: AbortSignal,
  onUpdate?: ToolUpdateFn,
) {
  const steps = planOptimizedBash(cwd, command);
  if (!steps) {
    return false;
  }

  const updates: string[] = [];
  for (let i = 0; i < steps.length; i += 1) {
    ensureNotAborted(signal);
    updates.push(`[fast path ${i + 1}/${steps.length}] ${steps[i].description}`);
    emitTextUpdate(onUpdate, updates.join("\n"));
    await steps[i].run();
  }

  return true;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "read",
    label: "read",
    description:
      "Read the contents of a file using a fast streaming implementation. Supports text files and returns truncated output with continuation hints.",
    parameters: readSchema,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      return fastRead(
        ctx.cwd,
        params.path,
        params.offset,
        params.limit,
        signal,
        onUpdate as ToolUpdateFn,
      );
    },
  });

  pi.registerTool({
    name: "write",
    label: "write",
    description: "Write content to a file using a Bun-optimized implementation.",
    parameters: writeSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return fastWrite(ctx.cwd, params.path, params.content, signal);
    },
  });

  pi.registerTool({
    name: "edit",
    label: "edit",
    description: "Edit a file by replacing exact text using a fast Bun-based implementation.",
    parameters: editSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return fastEdit(ctx.cwd, params.path, params.oldText, params.newText, signal);
    },
  });

  pi.registerTool({
    name: "bash",
    label: "bash",
    description:
      "Execute bash commands with fast paths for common file drain/copy/remove commands and a stock fallback for everything else.",
    parameters: bashSchema,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (await tryOptimizedBash(ctx.cwd, params.command, signal, onUpdate as ToolUpdateFn)) {
        return { content: [{ type: "text", text: "(no output)" }], details: undefined };
      }

      const helperPath = existsSync(FAST_TOOLS_DIR)
        ? `${FAST_TOOLS_DIR}:${process.env.PATH ?? ""}`
        : (process.env.PATH ?? "");
      const stock = createBashTool(ctx.cwd, {
        spawnHook: ({ command, cwd, env }) => ({
          command,
          cwd,
          env: {
            ...(env ?? process.env),
            PATH: helperPath,
          },
        }),
      });
      return stock.execute(toolCallId, params, signal, onUpdate);
    },
  });
}

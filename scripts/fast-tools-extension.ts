import { createReadStream, existsSync, lstatSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
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
const FASTREAD_BIN = join(FAST_TOOLS_DIR, "fastread-window");
const FASTEDIT_BIN = join(FAST_TOOLS_DIR, "fastedit");
const FASTWRITE_BIN = join(FAST_TOOLS_DIR, "fastwrite");
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

type ReplacementEdit = {
  oldText: string;
  newText: string;
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

const replacementEditSchema = Type.Object({
  oldText: Type.String({
    description:
      "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with another edit.",
  }),
  newText: Type.String({ description: "Replacement text for this targeted edit." }),
});

const editSchema = Type.Object({
  path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
  edits: Type.Optional(
    Type.Array(replacementEditSchema, {
      description:
        "One or more exact-text replacements. Each oldText is matched against the original file, not incrementally.",
    }),
  ),
  oldText: Type.Optional(
    Type.String({ description: "Deprecated compatibility field. Prefer edits[].oldText." }),
  ),
  newText: Type.Optional(
    Type.String({ description: "Deprecated compatibility field. Prefer edits[].newText." }),
  ),
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

const fileMutationQueues = new Map<string, Promise<void>>();

async function withFileMutationQueue<T>(path: string, task: () => Promise<T>): Promise<T> {
  const previous = fileMutationQueues.get(path) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => current);
  fileMutationQueues.set(path, queued);

  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (fileMutationQueues.get(path) === queued) {
      fileMutationQueues.delete(path);
    }
  }
}

function firstMismatchIndex(expected: string, actual: string) {
  const limit = Math.min(expected.length, actual.length);
  for (let i = 0; i < limit; i += 1) {
    if (expected.charCodeAt(i) !== actual.charCodeAt(i)) return i;
  }
  return expected.length === actual.length ? -1 : limit;
}

function writeVerificationError(pathArg: string, label: string, expected: string, actual: string) {
  const mismatch = firstMismatchIndex(expected, actual);
  const expectedBytes = Buffer.byteLength(expected, "utf8");
  const actualBytes = Buffer.byteLength(actual, "utf8");
  const suffix =
    mismatch === -1
      ? "length metadata mismatch"
      : `first mismatch at character ${mismatch} (expected code ${expected.charCodeAt(mismatch)}, got ${actual.charCodeAt(mismatch)})`;
  return new Error(
    `Write verification failed for ${pathArg} after ${label}: expected ${expected.length} chars/${expectedBytes} bytes, got ${actual.length} chars/${actualBytes} bytes; ${suffix}.`,
  );
}

async function verifyWrittenText(
  absolutePath: string,
  pathArg: string,
  expected: string,
  label: string,
) {
  const actual = await Bun.file(absolutePath).text();
  if (actual !== expected) {
    throw writeVerificationError(pathArg, label, expected, actual);
  }
}

function isSymlink(path: string) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

async function runBinaryCapture(
  cmd: string,
  args: string[],
  onChunk?: (chunk: Uint8Array) => void,
) {
  const proc = Bun.spawn([cmd, ...args], { stdout: "pipe", stderr: "pipe" });
  const stderrPromise = new Response(proc.stderr).text();
  const reader = proc.stdout.getReader();
  const chunks: Uint8Array[] = [];

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    onChunk?.(value);
  }

  const stderrText = await stderrPromise;
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(stderrText.trim() || `${cmd} exited with code ${exitCode}`);
  }

  return new Blob(chunks).text();
}

async function runBinaryWithInput(cmd: string, args: string[], input: string) {
  const proc = Bun.spawn([cmd, ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();
  await proc.stdin.write(input);
  proc.stdin.end();
  const [stdoutText, stderrText, exitCode] = await Promise.all([
    stdoutPromise,
    stderrPromise,
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(stderrText.trim() || `${cmd} exited with code ${exitCode}`);
  }
  return stdoutText;
}

async function fastReadNative(
  absolutePath: string,
  startLine: number,
  maxLines: number,
  onUpdate?: ToolUpdateFn,
) {
  let output = "";
  let lastProgressAt = 0;
  let lastProgressBytes = 0;
  const decoder = new TextDecoder();
  return runBinaryCapture(
    FASTREAD_BIN,
    [absolutePath, String(startLine), String(maxLines)],
    (chunk) => {
      output += decoder.decode(chunk, { stream: true });
      if (!onUpdate || output.length === 0) return;
      const now = Date.now();
      if (
        output.length - lastProgressBytes < READ_PROGRESS_MIN_BYTES &&
        now - lastProgressAt < READ_PROGRESS_MIN_INTERVAL_MS
      ) {
        return;
      }
      lastProgressAt = now;
      lastProgressBytes = output.length;
      emitTextUpdate(onUpdate, output);
    },
  ).then((text) => {
    if (onUpdate && text.length > 0 && text.length !== lastProgressBytes) {
      emitTextUpdate(onUpdate, text);
    }
    return { content: [{ type: "text", text }], details: undefined };
  });
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
  if (existsSync(FASTREAD_BIN)) {
    return fastReadNative(absolutePath, startLine, maxLines, onUpdate);
  }
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

  const appendLine = (line: string) => {
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
    return null;
  };

  for await (const chunk of createReadStream(absolutePath, {
    encoding: "utf8",
    highWaterMark: 64 * 1024,
  })) {
    ensureNotAborted(signal);

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
      if (result) {
        return result;
      }

      lineStart = newlineIndex + 1;
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
  const absolutePath = resolvePath(cwd, pathArg);

  return withFileMutationQueue(absolutePath, async () => {
    ensureNotAborted(signal);
    mkdirSync(dirname(absolutePath), { recursive: true });

    if (existsSync(FASTWRITE_BIN)) {
      await runBinaryWithInput(FASTWRITE_BIN, [absolutePath], content);
      ensureNotAborted(signal);
      await verifyWrittenText(absolutePath, pathArg, content, "native write");
    } else if (isSymlink(absolutePath)) {
      await Bun.write(absolutePath, content);
      ensureNotAborted(signal);
      await verifyWrittenText(absolutePath, pathArg, content, "symlink-preserving write");
    } else {
      const tmpPath = `${absolutePath}.tmp.${process.pid}.${Date.now()}.${randomUUID()}`;
      try {
        await Bun.write(tmpPath, content);
        ensureNotAborted(signal);
        await verifyWrittenText(tmpPath, pathArg, content, "temporary write");
        renameSync(tmpPath, absolutePath);
        ensureNotAborted(signal);
        await verifyWrittenText(absolutePath, pathArg, content, "final rename");
      } catch (error) {
        rmSync(tmpPath, { force: true });
        throw error;
      }
    }

    const bytes = Buffer.byteLength(content, "utf8");
    return {
      content: [
        { type: "text", text: `Successfully wrote and verified ${bytes} bytes to ${pathArg}` },
      ],
      details: { verified: true, bytes },
    };
  });
}

function normalizeEditParams(params: any): ReplacementEdit[] {
  const edits: ReplacementEdit[] = [];

  if (Array.isArray(params.edits)) {
    for (const edit of params.edits) {
      if (typeof edit?.oldText !== "string" || typeof edit?.newText !== "string") {
        throw new Error("Edit tool input is invalid. Each edit needs string oldText and newText.");
      }
      edits.push({ oldText: edit.oldText, newText: edit.newText });
    }
  }

  if (typeof params.oldText === "string" || typeof params.newText === "string") {
    if (typeof params.oldText !== "string" || typeof params.newText !== "string") {
      throw new Error("Edit tool input is invalid. oldText and newText must be provided together.");
    }
    edits.push({ oldText: params.oldText, newText: params.newText });
  }

  if (edits.length === 0) {
    throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
  }

  return edits;
}

async function fastEdit(
  cwd: string,
  pathArg: string,
  edits: ReplacementEdit[],
  signal?: AbortSignal,
) {
  const absolutePath = resolvePath(cwd, pathArg);

  return withFileMutationQueue(absolutePath, async () => {
    ensureNotAborted(signal);
    if (existsSync(FASTEDIT_BIN) && edits.length === 1) {
      const oldTextPath = join(tmpdir(), `tia-fastedit-old-${process.pid}-${randomUUID()}`);
      const newTextPath = join(tmpdir(), `tia-fastedit-new-${process.pid}-${randomUUID()}`);
      try {
        await Bun.write(oldTextPath, edits[0].oldText);
        await Bun.write(newTextPath, edits[0].newText);
        await runBinary(FASTEDIT_BIN, [absolutePath, oldTextPath, newTextPath]);
        return {
          content: [{ type: "text", text: `Successfully replaced 1 block(s) in ${pathArg}.` }],
          details: undefined,
        };
      } finally {
        rmSync(oldTextPath, { force: true });
        rmSync(newTextPath, { force: true });
      }
    }

    const content = await Bun.file(absolutePath).text();
    ensureNotAborted(signal);

    const replacements = edits.map((edit, index) => {
      if (edit.oldText.length === 0) {
        throw new Error(`Edit ${index + 1} in ${pathArg} has empty oldText.`);
      }

      const firstIndex = content.indexOf(edit.oldText);
      if (firstIndex === -1) {
        throw new Error(
          `Could not find edit ${index + 1} in ${pathArg}. The old text must match exactly including all whitespace and newlines.`,
        );
      }

      const secondIndex = content.indexOf(edit.oldText, firstIndex + edit.oldText.length);
      if (secondIndex !== -1) {
        throw new Error(
          `Found multiple occurrences for edit ${index + 1} in ${pathArg}. The old text must be unique.`,
        );
      }

      return {
        index,
        start: firstIndex,
        end: firstIndex + edit.oldText.length,
        newText: edit.newText,
      };
    });

    replacements.sort((a, b) => a.start - b.start || a.index - b.index);
    let updated = "";
    let cursor = 0;
    for (const replacement of replacements) {
      if (replacement.start < cursor) {
        throw new Error(
          `Edit ${replacement.index + 1} in ${pathArg} overlaps another replacement. Merge nearby changes into one edit.`,
        );
      }
      updated += content.slice(cursor, replacement.start);
      updated += replacement.newText;
      cursor = replacement.end;
    }
    updated += content.slice(cursor);

    if (updated === content) {
      throw new Error(`No changes made to ${pathArg}. The replacement produced identical content.`);
    }

    await Bun.write(absolutePath, updated);
    ensureNotAborted(signal);
    return {
      content: [
        { type: "text", text: `Successfully replaced ${edits.length} block(s) in ${pathArg}.` },
      ],
      details: undefined,
    };
  });
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
      const typedOnUpdate: ToolUpdateFn = onUpdate;
      return fastRead(ctx.cwd, params.path, params.offset, params.limit, signal, typedOnUpdate);
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
      return fastEdit(ctx.cwd, params.path, normalizeEditParams(params), signal);
    },
  });

  pi.registerTool({
    name: "bash",
    label: "bash",
    description:
      "Execute bash commands with fast paths for common file drain/copy/remove commands and a stock fallback for everything else.",
    parameters: bashSchema,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const typedOnUpdate: ToolUpdateFn = onUpdate;
      if (await tryOptimizedBash(ctx.cwd, params.command, signal, typedOnUpdate)) {
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

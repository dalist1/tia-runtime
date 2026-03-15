#!/usr/bin/env bash

set -euo pipefail

ACTION="${1:-install}"
PACKAGE_NAME="@mariozechner/pi-coding-agent"
COMPILED_NAME="pi-compiled"
ORIGINAL_NAME="pi-original"
LEGACY_ORIGINAL_NAME="pi-node"
EXPECTED_THEME_TARGET="dist/modes/interactive/theme"
EXPECTED_EXPORT_TARGET="dist/core/export-html"
AGENT_DIR="${PI_CODING_AGENT_DIR:-${HOME}/.pi/agent}"
EXTENSION_PATH="${AGENT_DIR}/extensions/fast-tools.ts"
FAST_TOOLS_DIR="${AGENT_DIR}/fast-tools"
FASTDRAIN_BIN="${FAST_TOOLS_DIR}/fastdrain"
FASTCOPY_BIN="${FAST_TOOLS_DIR}/fastcopy"

usage() {
	cat <<'EOF'
Usage:
  install-fast-pi-max.sh install    # Compiled pi + global fast-tools extension
  install-fast-pi-max.sh uninstall  # Restore original launcher and remove fast-tools extension
  install-fast-pi-max.sh status     # Show current install status
EOF
}

die() {
	printf 'Error: %s\n' "$*" >&2
	exit 1
}

need_cmd() {
	command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

realpath_py() {
	python3 - "$1" <<'PY'
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
}

is_pi_package_dir() {
	local dir="$1"
	local package_json="${dir}/package.json"
	[[ -f "${package_json}" ]] || return 1
	python3 - "${package_json}" <<'PY'
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    data = json.load(f)
raise SystemExit(0 if data.get('name') == '@mariozechner/pi-coding-agent' else 1)
PY
}

find_pi_package_dir() {
	local path="$1"
	local dir
	if [[ -d "${path}" ]]; then
		dir="${path}"
	else
		dir="$(dirname "${path}")"
	fi
	while true; do
		if is_pi_package_dir "${dir}"; then
			printf '%s\n' "${dir}"
			return 0
		fi
		if [[ "${dir}" == "/" ]]; then
			break
		fi
		dir="$(dirname "${dir}")"
	done
	return 1
}

clone_entry() {
	local src="$1"
	local dst="$2"
	if [[ -L "${src}" ]]; then
		ln -sfn "$(readlink "${src}")" "${dst}"
	else
		cp "${src}" "${dst}"
		chmod +x "${dst}"
	fi
}

ensure_backup() {
	if [[ -e "${ORIGINAL_PATH}" ]]; then
		return
	fi
	if [[ -e "${LEGACY_ORIGINAL_PATH}" ]]; then
		clone_entry "${LEGACY_ORIGINAL_PATH}" "${ORIGINAL_PATH}"
		return
	fi
	clone_entry "${PI_BIN_PATH}" "${ORIGINAL_PATH}"
}

ensure_asset_path() {
	local destination="$1"
	local relative_target="$2"
	if [[ -e "${destination}" && ! -L "${destination}" ]]; then
		return
	fi
	ln -sfn "${relative_target}" "${destination}"
}

compile_pi() {
	bun build --compile "${PACKAGE_DIR}/dist/cli.js" --outfile "${COMPILED_PATH}"
}

install_launcher() {
	ensure_backup
	compile_pi
	ensure_asset_path "${PACKAGE_DIR}/theme" "${EXPECTED_THEME_TARGET}"
	ensure_asset_path "${PACKAGE_DIR}/export-html" "${EXPECTED_EXPORT_TARGET}"
	ln -sfn "${COMPILED_PATH}" "${PI_BIN_PATH}"
	"${PI_BIN_PATH}" --version >/dev/null
}

write_extension() {
	mkdir -p "$(dirname "${EXTENSION_PATH}")"
	cat > "${EXTENSION_PATH}" <<'EOF'
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createReadStream } from "node:fs";
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

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
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
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

function resolvePath(cwd: string, path: string) {
	return resolve(cwd, path);
}

async function fastRead(cwd: string, pathArg: string, offset?: number, limit?: number) {
	const absolutePath = resolvePath(cwd, pathArg);
	const startLine = Math.max(1, offset ?? 1);
	const maxLines = limit ?? DEFAULT_MAX_LINES;
	let currentLine = 1;
	let output = "";
	let outputLines = 0;
	let outputBytes = 0;
	let carry = "";

	for await (const chunk of createReadStream(absolutePath, { encoding: "utf8", highWaterMark: 64 * 1024 })) {
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
							{ type: "text", text: `${output}\n\n[Showing lines ${startLine}-${endLine}. Use offset=${nextOffset} to continue.]` },
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
			}
			currentLine += 1;
		}
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
		}
	}

	return { content: [{ type: "text", text: output }], details: undefined };
}

async function fastWrite(cwd: string, pathArg: string, content: string) {
	const absolutePath = resolvePath(cwd, pathArg);
	mkdirSync(dirname(absolutePath), { recursive: true });
	await Bun.write(absolutePath, content);
	return {
		content: [{ type: "text", text: `Successfully wrote ${content.length} bytes to ${pathArg}` }],
		details: undefined,
	};
}

async function fastEdit(cwd: string, pathArg: string, oldText: string, newText: string) {
	const absolutePath = resolvePath(cwd, pathArg);
	const content = await Bun.file(absolutePath).text();
	const firstIndex = content.indexOf(oldText);
	if (firstIndex === -1) {
		throw new Error(`Could not find the exact text in ${pathArg}. The old text must match exactly including all whitespace and newlines.`);
	}
	const secondIndex = content.indexOf(oldText, firstIndex + oldText.length);
	if (secondIndex !== -1) {
		throw new Error(`Found multiple occurrences of the text in ${pathArg}. The text must be unique.`);
	}
	const updated = content.slice(0, firstIndex) + newText + content.slice(firstIndex + oldText.length);
	if (updated === content) {
		throw new Error(`No changes made to ${pathArg}. The replacement produced identical content.`);
	}
	await Bun.write(absolutePath, updated);
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

async function tryOptimizedBash(cwd: string, command: string) {
	const parts = command
		.split("&&")
		.map((part) => part.trim())
		.filter(Boolean);

	for (const part of parts) {
		const catMatch = part.match(/^cat\s+(\S+)\s*>\s*\/dev\/null$/);
		if (catMatch) {
			const file = resolvePath(cwd, catMatch[1]);
			if (existsSync(FASTDRAIN_BIN)) {
				await runBinary(FASTDRAIN_BIN, [file]);
			} else {
				await Bun.file(file).arrayBuffer();
			}
			continue;
		}

		const cpMatch = part.match(/^cp\s+(\S+)\s+(\S+)$/);
		if (cpMatch) {
			const src = resolvePath(cwd, cpMatch[1]);
			const dst = resolvePath(cwd, cpMatch[2]);
			mkdirSync(dirname(dst), { recursive: true });
			if (existsSync(FASTCOPY_BIN)) {
				await runBinary(FASTCOPY_BIN, [src, dst]);
			} else {
				await Bun.write(dst, Bun.file(src));
			}
			continue;
		}

		const rmMatch = part.match(/^rm\s+(\S+)$/);
		if (rmMatch) {
			rmSync(resolvePath(cwd, rmMatch[1]), { force: true });
			continue;
		}

		return false;
	}

	return parts.length > 0;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "read",
		label: "read",
		description:
			"Read the contents of a file using a fast streaming implementation. Supports text files and returns truncated output with continuation hints.",
		parameters: readSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return fastRead(ctx.cwd, params.path, params.offset, params.limit);
		},
	});

	pi.registerTool({
		name: "write",
		label: "write",
		description: "Write content to a file using a Bun-optimized implementation.",
		parameters: writeSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return fastWrite(ctx.cwd, params.path, params.content);
		},
	});

	pi.registerTool({
		name: "edit",
		label: "edit",
		description: "Edit a file by replacing exact text using a fast Bun-based implementation.",
		parameters: editSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return fastEdit(ctx.cwd, params.path, params.oldText, params.newText);
		},
	});

	pi.registerTool({
		name: "bash",
		label: "bash",
		description:
			"Execute bash commands with fast paths for common file drain/copy/remove commands and a stock fallback for everything else.",
		parameters: bashSchema,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (await tryOptimizedBash(ctx.cwd, params.command)) {
				return { content: [{ type: "text", text: "(no output)" }], details: undefined };
			}
			const helperPath = existsSync(FAST_TOOLS_DIR) ? `${FAST_TOOLS_DIR}:${process.env.PATH ?? ""}` : process.env.PATH ?? "";
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
EOF
}

build_helpers() {
	mkdir -p "${FAST_TOOLS_DIR}"
	if ! command -v gcc >/dev/null 2>&1; then
		return 0
	fi

	cat > "${FAST_TOOLS_DIR}/fastdrain.c" <<'EOF'
#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

enum { BUFFER_SIZE = 1 << 20 };

static int drain_fd(int fd) {
	void *buffer = NULL;
	uint64_t total = 0;

	if (posix_memalign(&buffer, 4096, BUFFER_SIZE) != 0) {
		perror("posix_memalign");
		return 1;
	}

#ifdef POSIX_FADV_SEQUENTIAL
	(void)posix_fadvise(fd, 0, 0, POSIX_FADV_SEQUENTIAL);
#endif

	for (;;) {
		ssize_t bytes_read = read(fd, buffer, BUFFER_SIZE);
		if (bytes_read == 0) break;
		if (bytes_read < 0) {
			if (errno == EINTR) continue;
			perror("read");
			free(buffer);
			return 1;
		}
		total += (uint64_t)bytes_read;
	}

	free(buffer);
	if (total == UINT64_MAX) return 1;
	return 0;
}

int main(int argc, char **argv) {
	int fd = STDIN_FILENO;
	if (argc > 2) return 1;
	if (argc == 2) {
		fd = open(argv[1], O_RDONLY | O_CLOEXEC);
		if (fd < 0) {
			perror("open");
			return 1;
		}
	}
	int status = drain_fd(fd);
	if (fd != STDIN_FILENO) close(fd);
	return status;
}
EOF

	cat > "${FAST_TOOLS_DIR}/fastcopy.c" <<'EOF'
#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/sendfile.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

int main(int argc, char **argv) {
	if (argc != 3) return 1;
	int src_fd = open(argv[1], O_RDONLY | O_CLOEXEC);
	if (src_fd < 0) return 1;
	struct stat st;
	if (fstat(src_fd, &st) != 0) return 1;
	int dst_fd = open(argv[2], O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, st.st_mode & 0777);
	if (dst_fd < 0) return 1;
	if (sendfile(dst_fd, src_fd, NULL, (size_t)st.st_size) < 0 && errno != EINVAL && errno != ENOSYS) return 1;
	close(dst_fd);
	close(src_fd);
	return 0;
}
EOF

	gcc -O3 -pipe -march=native -s -o "${FASTDRAIN_BIN}" "${FAST_TOOLS_DIR}/fastdrain.c"
	gcc -O3 -pipe -march=native -s -o "${FASTCOPY_BIN}" "${FAST_TOOLS_DIR}/fastcopy.c"
	chmod +x "${FASTDRAIN_BIN}" "${FASTCOPY_BIN}"
	rm -f "${FAST_TOOLS_DIR}/fastdrain.c" "${FAST_TOOLS_DIR}/fastcopy.c"
}

install_all() {
	install_launcher
	write_extension
	build_helpers || true
	printf 'Installed compiled pi launcher and fast-tools extension.\n'
	printf '  pi:         %s\n' "${PI_BIN_PATH}"
	printf '  backup:     %s\n' "${ORIGINAL_PATH}"
	printf '  extension:  %s\n' "${EXTENSION_PATH}"
	printf '  fast tools: %s\n' "${FAST_TOOLS_DIR}"
}

uninstall_all() {
	[[ -e "${ORIGINAL_PATH}" ]] || die "Original launcher backup not found at ${ORIGINAL_PATH}"
	clone_entry "${ORIGINAL_PATH}" "${PI_BIN_PATH}"
	rm -f "${EXTENSION_PATH}"
	rm -f "${FASTDRAIN_BIN}" "${FASTCOPY_BIN}"
	rmdir "${FAST_TOOLS_DIR}" 2>/dev/null || true
	"${PI_BIN_PATH}" --version >/dev/null
	printf 'Restored original pi launcher and removed fast-tools extension.\n'
}

status_all() {
	local current_real compiled_real
	current_real="$(realpath_py "${PI_BIN_PATH}")"
	compiled_real="$(realpath_py "${COMPILED_PATH}")"
	printf 'pi path:        %s\n' "${PI_BIN_PATH}"
	printf 'pi resolved:    %s\n' "${current_real}"
	printf 'package dir:    %s\n' "${PACKAGE_DIR}"
	printf 'compiled path:  %s\n' "${COMPILED_PATH}"
	printf 'backup path:    %s\n' "${ORIGINAL_PATH}"
	printf 'extension path: %s\n' "${EXTENSION_PATH}"
	printf 'fast tools dir: %s\n' "${FAST_TOOLS_DIR}"
	if [[ -e "${COMPILED_PATH}" ]]; then printf 'compiled build: present\n'; else printf 'compiled build: missing\n'; fi
	if [[ -e "${ORIGINAL_PATH}" ]]; then printf 'backup:         present\n'; else printf 'backup:         missing\n'; fi
	if [[ -f "${EXTENSION_PATH}" ]]; then printf 'extension:      present\n'; else printf 'extension:      missing\n'; fi
	if [[ -x "${FASTDRAIN_BIN}" ]]; then printf 'fastdrain:      present\n'; else printf 'fastdrain:      missing\n'; fi
	if [[ -x "${FASTCOPY_BIN}" ]]; then printf 'fastcopy:       present\n'; else printf 'fastcopy:       missing\n'; fi
	if [[ "${current_real}" == "${compiled_real}" ]]; then printf 'default mode:   compiled\n'; else printf 'default mode:   original/custom\n'; fi
}

need_cmd python3
need_cmd pi
PI_BIN_PATH="$(command -v pi)"
BIN_DIR="$(dirname "${PI_BIN_PATH}")"
PI_RESOLVED="$(realpath_py "${PI_BIN_PATH}")"
PACKAGE_DIR="$(find_pi_package_dir "${PI_RESOLVED}")" || die "Could not locate ${PACKAGE_NAME} package directory from ${PI_RESOLVED}"
COMPILED_PATH="${PACKAGE_DIR}/${COMPILED_NAME}"
ORIGINAL_PATH="${BIN_DIR}/${ORIGINAL_NAME}"
LEGACY_ORIGINAL_PATH="${BIN_DIR}/${LEGACY_ORIGINAL_NAME}"

case "${ACTION}" in
	install)
		need_cmd bun
		install_all
		;;
	uninstall|revert)
		uninstall_all
		;;
	status)
		status_all
		;;
	-h|--help|help)
		usage
		;;
	*)
		usage >&2
		die "Unsupported action: ${ACTION}"
		;;
esac

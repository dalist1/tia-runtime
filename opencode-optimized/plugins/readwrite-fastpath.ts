import type { Plugin } from "@opencode-ai/plugin";

const helperBin = "/home/frensiqatipi1/bun-stdin-bench/opencode-optimized/bin";

export const ReadWriteFastpathPlugin: Plugin = async () => {
	return {
		"shell.env": async (_input, output) => {
			const currentPath = output.env.PATH ?? process.env.PATH ?? "";
			output.env.PATH = `${helperBin}:${currentPath}`;
		},
	};
};

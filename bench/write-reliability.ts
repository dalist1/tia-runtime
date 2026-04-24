import { lstatSync, mkdirSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

const iterations = Number(process.argv[2] ?? 25);
if (!Number.isFinite(iterations) || iterations <= 0) {
	throw new Error(`Invalid iterations: ${process.argv[2]}`);
}

const fileQueues = new Map<string, Promise<void>>();

async function withFileQueue<T>(path: string, task: () => Promise<T>) {
	const previous = fileQueues.get(path) ?? Promise.resolve();
	let release = () => {};
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	const queued = previous.catch(() => undefined).then(() => current);
	fileQueues.set(path, queued);
	await previous.catch(() => undefined);
	try {
		return await task();
	} finally {
		release();
		if (fileQueues.get(path) === queued) fileQueues.delete(path);
	}
}

function isSymlink(path: string) {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

async function assertText(path: string, expected: string) {
	const actual = await readFile(path, "utf8");
	if (actual !== expected) {
		throw new Error(
			`write mismatch for ${path}: expected ${expected.length} chars/${Buffer.byteLength(expected, "utf8")} bytes, got ${actual.length} chars/${Buffer.byteLength(actual, "utf8")} bytes`,
		);
	}
}

async function verifiedWrite(path: string, content: string) {
	return withFileQueue(path, async () => {
		mkdirSync(dirname(path), { recursive: true });
		if (isSymlink(path)) {
			await writeFile(path, content, "utf8");
			await assertText(path, content);
			return;
		}

		const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}.${randomUUID()}`;
		try {
			await writeFile(tmpPath, content, "utf8");
			await assertText(tmpPath, content);
			renameSync(tmpPath, path);
			await assertText(path, content);
		} catch (error) {
			rmSync(tmpPath, { force: true });
			throw error;
		}
	});
}

const cases = [
	{ name: "empty", content: "" },
	{ name: "ascii", content: "hello write\nsecond line\n" },
	{ name: "crlf", content: "first\r\nsecond\r\nthird\r\n" },
	{ name: "unicode", content: "emoji 😄\naccent café\nmath ∑λπ\n" },
	{ name: "markdown", content: "```ts\nconst value = `template`;\n```\n" },
	{ name: "json-quotes", content: JSON.stringify({ text: "quotes \\\" and slash \\\\ and newline\\n" }, null, 2) + "\n" },
	{ name: "large", content: `${"x".repeat(1024 * 1024)}\nEND\n` },
];

const root = await mkdtemp(join(tmpdir(), "tia-write-reliability-"));
const start = performance.now();
let writes = 0;
try {
	for (let i = 0; i < iterations; i += 1) {
		for (const item of cases) {
			const path = join(root, "nested", String(i), `${item.name}.txt`);
			await verifiedWrite(path, item.content);
			writes += 1;
		}

		const shrinkPath = join(root, "overwrite", `${i}.txt`);
		await verifiedWrite(shrinkPath, "long-content\n".repeat(100));
		await verifiedWrite(shrinkPath, "short\n");
		await assertText(shrinkPath, "short\n");
		writes += 2;
	}

	const concurrentPath = join(root, "concurrent", "same-file.txt");
	const concurrentContents = Array.from(
		{ length: 12 },
		(_, index) => `concurrent-${index}\n${"z".repeat(index * 17)}\n`,
	);
	await Promise.all(concurrentContents.map((content) => verifiedWrite(concurrentPath, content)));
	const concurrentFinal = await readFile(concurrentPath, "utf8");
	if (!concurrentContents.includes(concurrentFinal)) {
		throw new Error("concurrent write final content did not match any requested content");
	}
	writes += concurrentContents.length;

	const symlinkTarget = join(root, "symlink-target.txt");
	const symlinkPath = join(root, "symlink-path.txt");
	await writeFile(symlinkTarget, "before\n", "utf8");
	symlinkSync(symlinkTarget, symlinkPath);
	await verifiedWrite(symlinkPath, "after via symlink\n");
	await assertText(symlinkTarget, "after via symlink\n");
	if (readlinkSync(symlinkPath) !== symlinkTarget) {
		throw new Error("symlink write replaced the symlink instead of preserving it");
	}
	writes += 1;
} finally {
	rmSync(root, { recursive: true, force: true });
}

const elapsedMs = performance.now() - start;
console.log(
	JSON.stringify({
		ok: true,
		iterations,
		cases: cases.length,
		writes,
		elapsedMs,
		perWriteMs: elapsedMs / writes,
	}),
);

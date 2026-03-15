const path = process.argv[2];

if (!path) {
	throw new Error("Missing file path argument.");
}

let byteCount = 0;

for await (const chunk of Bun.file(path).stream()) {
	byteCount += chunk.byteLength;
}

if (byteCount < 0) {
	throw new Error("Unreachable");
}

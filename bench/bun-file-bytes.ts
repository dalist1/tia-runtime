const path = process.argv[2];

if (!path) {
	throw new Error("Missing file path argument.");
}

const bytes = await Bun.file(path).bytes();

if (bytes.byteLength < 0) {
	throw new Error("Unreachable");
}

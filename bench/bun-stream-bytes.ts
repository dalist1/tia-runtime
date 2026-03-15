let byteCount = 0;

for await (const chunk of Bun.stdin.stream()) {
	byteCount += chunk.byteLength;
}

if (byteCount < 0) {
	throw new Error("Unreachable");
}

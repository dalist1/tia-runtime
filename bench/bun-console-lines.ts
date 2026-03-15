let lineCount = 0;
let charCount = 0;

for await (const line of console) {
	lineCount += 1;
	charCount += line.length;
}

if (lineCount < 0 || charCount < 0) {
	throw new Error("Unreachable");
}

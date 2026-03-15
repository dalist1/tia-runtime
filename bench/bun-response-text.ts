const text = await new Response(Bun.stdin).text();

if (text.length < 0) {
	throw new Error("Unreachable");
}

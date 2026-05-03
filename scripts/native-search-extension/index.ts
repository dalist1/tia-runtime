import { runNativeSearchTool } from "./tool.ts";

const nativeSearchSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description:
        "Search terms. Include one or more URLs here or pass sites for bounded native website search.",
    },
    sites: {
      type: "array",
      items: { type: "string" },
      description:
        "Optional site roots or URLs to search. Required unless query includes URLs or TIA_NATIVE_SEARCH_SEEDS is set.",
    },
    maxResults: {
      type: "number",
      description: "Maximum ranked results to return (default 5, hard max 10).",
    },
    maxSites: {
      type: "number",
      description: "Maximum distinct site roots/seeds to use (default 5, hard max 12).",
    },
    maxPages: {
      type: "number",
      description:
        "Maximum final candidate pages/URLs to fetch across all sites (default 12, hard max 50).",
    },
    pagesPerSite: {
      type: "number",
      description:
        "Maximum discovered pages retained per site before global balancing (default 8, hard max 25).",
    },
    strategy: {
      type: "string",
      enum: ["balanced", "deep", "direct"],
      description:
        "Search planning strategy. balanced (default) round-robins across sites/sources; deep prioritizes highest-scoring URLs; direct fetches explicit URLs/seeds without discovery.",
    },
    includePlan: {
      type: "boolean",
      description:
        "Include the bounded divide-and-conquer search plan before results. Default true.",
    },
    fetchContent: {
      type: "boolean",
      description:
        "Include extracted readable content in the answer. Ranking still fetches bounded pages. Default true.",
    },
    contentChars: {
      type: "number",
      description: "Maximum extracted characters per result (default 6000, hard max 20000).",
    },
    timeoutMs: {
      type: "number",
      description: "Per-request timeout in milliseconds (default 8000).",
    },
  },
  required: ["query"],
  additionalProperties: false,
};

export default function (pi: any) {
  pi.registerTool({
    name: "native_search",
    label: "native_search",
    description:
      "Vanilla site-bounded web search with a divide-and-conquer planner. Broadens across supplied sites/URLs, balances candidate fetches across origins, uses a Zig backend for fetch/extract/rank/output, and uses no third-party search APIs/tools/libraries.",
    parameters: nativeSearchSchema,
    async execute(_toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any) {
      return runNativeSearchTool(params, signal, (text, details) => {
        onUpdate?.({ content: [{ type: "text", text }], details });
      });
    },
  });
}

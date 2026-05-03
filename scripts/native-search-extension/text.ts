export function nowMs() {
  return Date.now();
}

export function normalizeHttpUrl(urlString: string) {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error(`Invalid URL: ${urlString}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Only http(s) URLs are supported: ${urlString}`);
  }
  url.username = "";
  url.password = "";
  url.hash = "";
  return url.toString();
}

export function extractUrls(text: string) {
  const urls: string[] = [];
  const urlPattern = /https?:\/\/[^\s<>)"']+/gi;
  for (const match of text.matchAll(urlPattern)) {
    let candidate = match[0].replace(/[),.;:!?]+$/g, "");
    try {
      candidate = normalizeHttpUrl(candidate);
      urls.push(candidate);
    } catch {
      // Ignore malformed URL-shaped text.
    }
  }
  return unique(urls);
}

export function unique<T>(items: T[]) {
  return Array.from(new Set(items));
}

export function decodeHtmlEntities(text: string) {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    ndash: "–",
    mdash: "—",
    hellip: "…",
    copy: "©",
    reg: "®",
    trade: "™",
  };
  return text.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/gi, (match, entity) => {
    const key = String(entity).toLowerCase();
    if (key.startsWith("#x")) {
      const codePoint = Number.parseInt(key.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    if (key.startsWith("#")) {
      const codePoint = Number.parseInt(key.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return named[key] ?? match;
  });
}

export function cleanInlineText(text: string) {
  return decodeHtmlEntities(text.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenizeQuery(query: string) {
  const withoutUrls = query.replace(/https?:\/\/[^\s<>)"']+/gi, " ");
  const tokens = withoutUrls
    .toLowerCase()
    .replace(/[^a-z0-9_+.#-]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
  return unique(tokens).slice(0, 16);
}

export function absolutizeUrl(href: string, baseUrl: string) {
  if (!href || /^(javascript|mailto|tel):/i.test(href)) return "";
  try {
    return normalizeHttpUrl(new URL(href, baseUrl).toString());
  } catch {
    return "";
  }
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "how",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

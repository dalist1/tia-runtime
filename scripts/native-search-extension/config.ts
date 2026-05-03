export const DEFAULT_MAX_RESULTS = 5;
export const HARD_MAX_RESULTS = 10;
export const DEFAULT_PAGES_PER_SITE = 8;
export const HARD_MAX_PAGES_PER_SITE = 25;
export const DEFAULT_MAX_PAGES = 12;
export const HARD_MAX_PAGES = 50;
export const DEFAULT_CONTENT_CHARS = 6000;
export const HARD_MAX_CONTENT_CHARS = 20000;
export const DEFAULT_TIMEOUT_MS = 8000;
export const DEFAULT_MAX_FETCH_BYTES = 1536 * 1024;
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_ORIGIN_INTERVAL_MS = 1200;
const DEFAULT_CONCURRENCY = 3;
export const DEFAULT_MAX_SITES = 5;
export const HARD_MAX_SITES = 12;
export const MAX_DISCOVERY_DOCS_PER_SITE = 7;

export const SEARCH_USER_AGENT =
  process.env.TIA_NATIVE_SEARCH_USER_AGENT ??
  "tia-runtime-native-search/0.1 (+https://github.com/dalist1/tia-runtime; respectful low-rate fetcher)";

function envNumber(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

export function clampInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
) {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export function cacheTtlMs() {
  return envNumber("TIA_NATIVE_SEARCH_CACHE_TTL_MS", DEFAULT_CACHE_TTL_MS, 0, 60 * 60 * 1000);
}

export function baseOriginIntervalMs() {
  return envNumber(
    "TIA_NATIVE_SEARCH_ORIGIN_INTERVAL_MS",
    DEFAULT_ORIGIN_INTERVAL_MS,
    0,
    60 * 1000,
  );
}

export function searchConcurrency() {
  return envNumber("TIA_NATIVE_SEARCH_CONCURRENCY", DEFAULT_CONCURRENCY, 1, 6);
}

export function envSeedSites() {
  return (process.env.TIA_NATIVE_SEARCH_SEEDS ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

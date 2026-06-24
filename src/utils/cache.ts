import type { S3MediaItem } from "./s3";

// Presigned URLs expire after 1 hour; cache them for 50 min to avoid
// serving near-expired URLs. The key insight: same URL = browser HTTP cache
// hit = zero S3 egress on repeat loads.
const URL_TTL_MS  = 50 * 60 * 1000;
const LIST_TTL_MS =  5 * 60 * 1000;

interface CachedItem {
  key: string;
  name: string;
  size: number;
  lastModified?: string; // ISO string — Date doesn't survive JSON
  type: "image" | "video" | "other";
}

interface ListEntry {
  items: CachedItem[];
  fetchedAt: number;
}

interface UrlEntry {
  url: string;
  expiresAt: number;
}

type UrlStore = Record<string, UrlEntry>;

function listStorageKey(bucket: string) { return `s3store_list_${bucket}`; }
function urlStorageKey(bucket: string)  { return `s3store_urls_${bucket}`; }

// ── Object list ──────────────────────────────────────────────────────────────

export function getCachedList(bucket: string): S3MediaItem[] | null {
  try {
    const raw = localStorage.getItem(listStorageKey(bucket));
    if (!raw) return null;
    const entry: ListEntry = JSON.parse(raw);
    if (Date.now() - entry.fetchedAt > LIST_TTL_MS) return null;
    return entry.items.map(i => ({
      ...i,
      lastModified: i.lastModified ? new Date(i.lastModified) : undefined,
    }));
  } catch { return null; }
}

export function setCachedList(bucket: string, items: S3MediaItem[]) {
  try {
    const entry: ListEntry = {
      fetchedAt: Date.now(),
      items: items.map(i => ({
        key: i.key,
        name: i.name,
        size: i.size,
        type: i.type,
        lastModified: i.lastModified?.toISOString(),
      })),
    };
    localStorage.setItem(listStorageKey(bucket), JSON.stringify(entry));
  } catch { /* quota errors — silently skip */ }
}

export function clearCachedList(bucket: string) {
  localStorage.removeItem(listStorageKey(bucket));
}

/** Returns milliseconds since the list was cached, or null if no cache. */
export function getListCacheAge(bucket: string): number | null {
  try {
    const raw = localStorage.getItem(listStorageKey(bucket));
    if (!raw) return null;
    const entry: ListEntry = JSON.parse(raw);
    return Date.now() - entry.fetchedAt;
  } catch { return null; }
}

// ── Presigned URLs ───────────────────────────────────────────────────────────

export function getCachedUrl(bucket: string, key: string): string | null {
  try {
    const raw = localStorage.getItem(urlStorageKey(bucket));
    if (!raw) return null;
    const store: UrlStore = JSON.parse(raw);
    const entry = store[key];
    if (!entry || Date.now() > entry.expiresAt) return null;
    return entry.url;
  } catch { return null; }
}

export function setCachedUrl(bucket: string, key: string, url: string) {
  try {
    const storageKey = urlStorageKey(bucket);
    const raw = localStorage.getItem(storageKey);
    const store: UrlStore = raw ? JSON.parse(raw) : {};
    store[key] = { url, expiresAt: Date.now() + URL_TTL_MS };
    localStorage.setItem(storageKey, JSON.stringify(store));
  } catch { /* quota errors — silently skip */ }
}

export function clearUrlCache(bucket: string) {
  localStorage.removeItem(urlStorageKey(bucket));
}

/** Remove expired URL entries to keep localStorage lean. */
export function pruneUrlCache(bucket: string) {
  try {
    const storageKey = urlStorageKey(bucket);
    const raw = localStorage.getItem(storageKey);
    if (!raw) return;
    const store: UrlStore = JSON.parse(raw);
    const now = Date.now();
    let changed = false;
    for (const key of Object.keys(store)) {
      if (now > store[key].expiresAt) { delete store[key]; changed = true; }
    }
    if (changed) localStorage.setItem(storageKey, JSON.stringify(store));
  } catch { /* ignore */ }
}

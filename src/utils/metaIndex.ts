/**
 * Metadata index backed by a Parquet file stored in the user's S3 bucket.
 *
 * Layout in S3:  ${prefix}s3store-meta.parquet
 * Schema:        key, date_taken, gps_lat, gps_lng, city, country, country_code
 *
 * At 20 k photos the Parquet file is ~200–400 KB (vs ~4 MB JSON) because
 * Parquet uses columnar dictionary encoding — city/country repeat thousands of
 * times and compress to nearly nothing.
 *
 * Migration: if no Parquet exists yet but a legacy s3store-meta.json does,
 * the JSON is read once, converted to Parquet, and uploaded automatically.
 */

import { tableFromArrays } from "apache-arrow";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getS3Client } from "./s3";
import type { S3Credentials } from "./s3";
import { getDuckDB } from "./duckdb";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MetaEntry {
  dateTaken?: string;
  gpsLat?: string;
  gpsLng?: string;
  city?: string;
  country?: string;
  countryCode?: string;
  area?: string;    // neighbourhood / suburb / district
  street?: string;  // road name
}

export type MetaIndex = Record<string, MetaEntry>;

// ── Constants ─────────────────────────────────────────────────────────────────

const PARQUET_FILE = "s3store-meta.parquet";
const JSON_FILE    = "s3store-meta.json"; // legacy — read-only for migration
const CACHE_TTL_MS = 5 * 60 * 1000;

const s3ParquetKey = (prefix?: string) => (prefix ?? "") + PARQUET_FILE;
const s3JsonKey    = (prefix?: string) => (prefix ?? "") + JSON_FILE;
const lsCacheKey   = (bucket: string)  => `s3store_metaidx_${bucket}`;

// ── localStorage cache ────────────────────────────────────────────────────────

function readCache(bucket: string): MetaIndex | null {
  try {
    const raw = localStorage.getItem(lsCacheKey(bucket));
    if (!raw) return null;
    const { data, ts } = JSON.parse(raw);
    return Date.now() - ts < CACHE_TTL_MS ? (data as MetaIndex) : null;
  } catch { return null; }
}

function writeCache(bucket: string, data: MetaIndex) {
  try {
    localStorage.setItem(lsCacheKey(bucket), JSON.stringify({ data, ts: Date.now() }));
  } catch {}
}

export function clearMetaIndexCache(bucket: string) {
  localStorage.removeItem(lsCacheKey(bucket));
}

// ── S3 I/O ────────────────────────────────────────────────────────────────────

async function fetchParquetBytes(creds: S3Credentials): Promise<Uint8Array | null> {
  try {
    const res = await getS3Client(creds).send(
      new GetObjectCommand({ Bucket: creds.bucketName, Key: s3ParquetKey(creds.prefix) })
    );
    return (res.Body as any).transformToByteArray();
  } catch { return null; }
}

async function uploadParquet(creds: S3Credentials, bytes: Uint8Array): Promise<void> {
  await getS3Client(creds).send(new PutObjectCommand({
    Bucket: creds.bucketName,
    Key: s3ParquetKey(creds.prefix),
    Body: bytes,
    ContentType: "application/vnd.apache.parquet",
  }));
}

/** One-time migration: read legacy JSON index from S3. */
async function readLegacyJson(creds: S3Credentials): Promise<MetaIndex> {
  try {
    const res = await getS3Client(creds).send(
      new GetObjectCommand({ Bucket: creds.bucketName, Key: s3JsonKey(creds.prefix) })
    );
    const text = await (res.Body as any).transformToString();
    return JSON.parse(text) as MetaIndex;
  } catch { return {}; }
}

// ── DuckDB / Parquet codec ────────────────────────────────────────────────────

const n = (v?: string): string | null => v ?? null; // undefined → Arrow null

const CREATE_TABLE_SQL = `
  CREATE TABLE _s3meta (
    key VARCHAR, date_taken VARCHAR, gps_lat VARCHAR, gps_lng VARCHAR,
    city VARCHAR, country VARCHAR, country_code VARCHAR,
    area VARCHAR, street VARCHAR
  )
`;

/** MetaIndex → Parquet bytes. Uses Arrow bulk insert + DuckDB COPY. */
async function encodeParquet(index: MetaIndex): Promise<Uint8Array> {
  const db   = await getDuckDB();
  const conn = await db.connect();

  try {
    // Always start fresh to avoid table state from a previous failed call
    await conn.query("DROP TABLE IF EXISTS _s3meta");

    // Create table explicitly — never rely on insertArrowTable's create:true
    // option, which fails silently in some DuckDB-WASM builds.
    await conn.query(CREATE_TABLE_SQL);

    const keys = Object.keys(index);

    if (keys.length > 0) {
      // Arrow batch insert into the pre-created table
      const arrow = tableFromArrays({
        key:          keys                                    as any,
        date_taken:   keys.map(k => n(index[k].dateTaken))   as any,
        gps_lat:      keys.map(k => n(index[k].gpsLat))      as any,
        gps_lng:      keys.map(k => n(index[k].gpsLng))      as any,
        city:         keys.map(k => n(index[k].city))         as any,
        country:      keys.map(k => n(index[k].country))      as any,
        country_code: keys.map(k => n(index[k].countryCode))  as any,
        area:         keys.map(k => n(index[k].area))         as any,
        street:       keys.map(k => n(index[k].street))       as any,
      });
      await conn.insertArrowTable(arrow as any, { name: "_s3meta" });
    }

    // Write compressed Parquet into DuckDB's virtual FS
    await conn.query(
      "COPY _s3meta TO 'meta_out.parquet' (FORMAT PARQUET, COMPRESSION ZSTD)"
    );

    return await db.copyFileToBuffer("meta_out.parquet");
  } finally {
    await conn.query("DROP TABLE IF EXISTS _s3meta").catch(() => {});
    await db.dropFile("meta_out.parquet").catch(() => {});
    await conn.close();
  }
}

/** Parquet bytes → MetaIndex. Registers the buffer with DuckDB and queries it. */
async function decodeParquet(bytes: Uint8Array): Promise<MetaIndex> {
  const db   = await getDuckDB();
  await db.registerFileBuffer("meta_in.parquet", bytes);
  const conn = await db.connect();

  try {
    const result = await conn.query("SELECT * FROM read_parquet('meta_in.parquet')");
    const index: MetaIndex = {};
    const str = (v: unknown) => (v !== null && v !== undefined ? String(v) : undefined);

    for (const row of result.toArray() as any[]) {
      const key = str(row.key);
      if (!key) continue;
      index[key] = {
        dateTaken:   str(row.date_taken),
        gpsLat:      str(row.gps_lat),
        gpsLng:      str(row.gps_lng),
        city:        str(row.city),
        country:     str(row.country),
        countryCode: str(row.country_code),
        area:        str(row.area),
        street:      str(row.street),
      };
    }
    return index;
  } finally {
    await conn.close();
    await db.dropFile("meta_in.parquet").catch(() => {});
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function loadMetaIndex(creds: S3Credentials): Promise<MetaIndex> {
  // 1. Warm cache hit — zero S3 calls
  const cached = readCache(creds.bucketName);
  if (cached) return cached;

  // 2. Parquet exists in S3 — decode via DuckDB
  const bytes = await fetchParquetBytes(creds);
  if (bytes) {
    const index = await decodeParquet(bytes);
    writeCache(creds.bucketName, index);
    return index;
  }

  // 3. First run — migrate from legacy JSON if present, then write Parquet
  const legacy = await readLegacyJson(creds);
  if (Object.keys(legacy).length > 0) {
    console.info("[s3store] Migrating s3store-meta.json → s3store-meta.parquet");
    const parquetBytes = await encodeParquet(legacy);
    await uploadParquet(creds, parquetBytes);
  }
  writeCache(creds.bucketName, legacy);
  return legacy;
}

/**
 * Merges `entries` into the existing index, re-encodes as Parquet, and
 * uploads to S3. Called once per upload batch — not per file — to avoid
 * read-modify-write races.
 */
export async function batchUpsertMetaEntries(
  creds: S3Credentials,
  entries: Record<string, MetaEntry>
): Promise<void> {
  if (Object.keys(entries).length === 0) return;

  clearMetaIndexCache(creds.bucketName);
  const existing = await loadMetaIndex(creds);
  const merged: MetaIndex = { ...existing, ...entries };

  const bytes = await encodeParquet(merged);
  await uploadParquet(creds, bytes);
  writeCache(creds.bucketName, merged);
}

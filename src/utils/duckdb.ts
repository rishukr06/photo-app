import * as duckdb from "@duckdb/duckdb-wasm";

let _db: duckdb.AsyncDuckDB | null = null;
let _initPromise: Promise<duckdb.AsyncDuckDB> | null = null;

async function init(): Promise<duckdb.AsyncDuckDB> {
  // selectBundle picks the best available bundle (EH > MVP) without needing
  // COOP/COEP headers (those are only required for the threaded COI bundle).
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());

  // Inline the worker script so we don't need to serve extra static files.
  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker!}");`], { type: "text/javascript" })
  );
  const worker = new Worker(workerUrl);
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);
  _db = db;
  return db;
}

export async function getDuckDB(): Promise<duckdb.AsyncDuckDB> {
  if (_db) return _db;
  if (!_initPromise) _initPromise = init();
  return _initPromise;
}

/** Fire-and-forget warm-up so the WASM is ready before the first real use. */
export function warmDuckDB(): void {
  getDuckDB().catch(() => {});
}

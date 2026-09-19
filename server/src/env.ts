export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  KV: KVNamespace;
  REALTIME: DurableObjectNamespace;
  ASSETS: Fetcher;
  ENVIRONMENT: string;
}

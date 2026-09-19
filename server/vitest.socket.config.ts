import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';
import path from 'node:path';

export default defineWorkersConfig(async () => {
  const migrationsPath = path.resolve(__dirname, 'migrations');
  const migrations = await readD1Migrations(migrationsPath);

  return {
    test: {
      globals: true,
      include: ['test/socket.test.ts'],
      isolate: false,
      maxWorkers: 1,
      poolOptions: {
        workers: {
          isolatedStorage: false,
          singleWorker: true,
          wrangler: { configPath: './wrangler.toml' },
          miniflare: {
            d1Databases: ['DB'],
            r2Buckets: ['BUCKET'],
            kvNamespaces: ['KV'],
            bindings: {
              TEST_MIGRATIONS: migrations,
            },
          },
        },
      },
    },
  };
});

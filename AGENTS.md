# AGENTS.md

## Project Goal

WorkersImmich is an experimental Cloudflare-native backend for Immich. It uses the Immich v3.2.2 web client and API model while replacing the NestJS, PostgreSQL, filesystem, Redis, and Socket.IO server stack with Hono, D1, R2, KV, and Durable Objects.

The first engineering constraint is client compatibility. A route is not complete merely because it returns a successful response. Existing Immich web and mobile clients depend on exact paths, methods, permissions, status codes, response fields, nullability, date formats, event names, and sync semantics.

Read these documents before changing behavior:

- `docs/COMPATIBILITY.md`
- `docs/FEATURE_STATUS.md`
- `README.md`

`docs/IMPLEMENTATION_PLAN.md` and `docs/TECH_CONVERSIONS.md` are historical design documents. They are useful context, but they are not current status. For example, realtime support was originally listed as removed and is now implemented with a Durable Object.

## Active Runtime

The active Worker path is:

1. `server/src/index.ts` registers middleware and Hono routes.
2. `server/src/context.ts` creates D1, R2, KV, crypto, and realtime dependencies.
3. `server/src/services.ts` registers active services.
4. `server/src/routes/` defines the live API surface.
5. `server/src/services/` contains active business logic.
6. `server/src/repositories/` contains D1, R2, and supporting data access.
7. `server/src/realtime.ts` implements the Socket.IO-compatible Durable Object.

Many retained NestJS controllers, decorators, modules, upstream tests, and PostgreSQL-oriented files are not on the active Worker execution path. Do not infer feature support from those files. Do not modify them to implement Worker behavior unless the active Hono code imports them.

The web application is under `web/` and uses `@immich/sdk` v3.2.2. There is no mobile application source in this repository, so mobile compatibility must be checked through API and sync contracts plus testing with an upstream client.

## Compatibility Rules

- Treat Immich v3.2.2 as the current protocol baseline.
- Compare client-visible changes with the matching upstream v3.2.2 controller, DTO, service, SDK call, and web usage.
- Preserve request and response field names, types, nullability, enum values, status codes, and error behavior.
- Preserve Socket.IO event names, target scope, argument order, and payload shape.
- Preserve sync entity names, checkpoint behavior, ordering, deletion records, and NDJSON framing.
- Keep unsupported capabilities disabled in server feature responses and hidden in the web UI.
- Never expose D1 rows directly when an Immich response mapper exists.
- Never return password, PIN, API-key, shared-link secret, or internal storage data through user-bearing responses.
- Add a regression test for every compatibility or authorization bug.
- Do not add backward-compatibility shims unless a shipped client, persisted record, or explicit requirement needs one.

## Cloudflare Constraints

### D1

- D1 uses SQLite, not PostgreSQL.
- Interactive Kysely transactions are not supported by the current D1 driver.
- Use `D1Database.batch()` when multiple writes must be atomic.
- Keep each statement below D1's 100 bound-parameter limit. Account for repeated `IN` lists and values outside the list.
- Generate IDs in application code when the D1 schema has no UUID default.
- Store timestamps as ISO 8601 strings.
- Convert SQLite integer booleans at response boundaries.
- Parse JSON stored as text before mapping responses.
- Do not introduce PostgreSQL operators, casts, extensions, lateral joins, or array syntax.

### R2

- Database paths are R2 object keys, not local filesystem paths.
- Delete originals and every derivative when permanently deleting an asset.
- Keep quota accounting consistent with R2 writes, replacement, and deletion.
- Do not assume FFmpeg, native image libraries, or filesystem tools are available.

### KV And Durable Objects

- KV is eventually consistent and should not be the source of truth for authorization.
- Durable Objects provide realtime connection coordination, not durable application records.
- Authenticate WebSocket upgrades and revalidate session expiry and revocation.

## Resource Configuration

Preserve the configured bindings in `server/wrangler.toml` unless the task explicitly changes infrastructure:

- D1 binding `DB`, database `immich`
- R2 binding `BUCKET`, bucket `immich`
- KV binding `KV`
- Durable Object binding `REALTIME`, class `RealtimeHub`
- Static asset binding `ASSETS`

Do not replace committed resource IDs with placeholders or local values.

## Development Workflow

1. Identify whether the code is on the active Hono path.
2. Find the equivalent Immich v3.2.2 contract and current web SDK usage.
3. Make the smallest Worker-compatible change.
4. Add or update a top-level Worker integration test.
5. Run focused tests while iterating.
6. Run the complete server and Socket.IO suites.
7. Run a Wrangler dry-run to validate the production bundle and bindings.
8. Update feature documentation when support status changes.

Do not revert unrelated work in a dirty worktree. Realtime, PIN, locked-folder, and infrastructure changes may coexist in the same uncommitted diff.

## Verification Commands

Run server commands from `server/`:

```sh
npm test -- --run test/<file>.test.ts
npm run test:all
npx wrangler deploy --dry-run
```

Run web commands from `web/`:

```sh
npm run check:svelte
npm run check:typescript
npm run build
```

The active server suite is the set of top-level files under `server/test/` plus `server/test/socket.test.ts` through its dedicated config. The retained `server/test/medium/` tree is not part of the Worker test run and currently depends on upstream NestJS infrastructure.

Repository-wide TypeScript checks include retained legacy code and are not currently a clean signal. A Wrangler dry-run is required for the active production bundle, but it does not replace route-level tests or client smoke tests.

## Documentation Rules

- Keep `docs/FEATURE_STATUS.md` honest and evidence-based.
- Use `Verified` only when an active test exercises the behavior.
- Use `Partial` when a route exists but omits required semantics.
- Use `Unavailable` when the active Worker exposes no working implementation.
- Record important client-facing limitations even if the server returns success.
- Update the roadmap when a partial feature becomes complete or is intentionally removed.

# Immich v3.2.2 Migration Findings

## Purpose

This document records the completed migration research so implementation does not repeat the same discovery work. Read it with `V3_MIGRATION_PLAN.md` before changing the v3 port.

The exact upstream sources used for comparison are:

- Immich v2.5.2 commit `eadb2f89af5f877ca3e34f4140acb176f541082e`
- Immich v3.2.2 commit `60b51cb3bc909e72fe963f4dfb1947515cb9ab3b`
- The v3.2.2 OpenAPI specification at `open-api/immich-openapi-specs.json`
- The published `@immich/sdk` version `3.2.2`

Local research used clean checkouts named `immich-v2.5.2` and `immich-v3.2.2`. References beginning with `upstream/` below are paths inside the v3.2.2 checkout, not files that should be copied into the Worker server.

## Active Worker Boundary

The active implementation starts at:

- Worker and route registration: `server/src/index.ts`
- Active service registration: `server/src/services.ts`
- D1, R2, KV, crypto, and realtime dependencies: `server/src/context.ts`
- Hono routes: `server/src/routes/`
- Worker services: `server/src/services/`
- Worker repositories: `server/src/repositories/`
- D1 schema types: `server/src/schema.ts`
- Socket.IO-compatible Durable Object: `server/src/realtime.ts`

Retained NestJS controllers, PostgreSQL schema files, medium tests, and other inactive upstream files are not evidence of Worker support. Removing those files is optional cleanup, not a prerequisite for the v3 protocol port.

## Confirmed Port Strategy

- Port directly from v2.5.2 to v3.2.2.
- Do not preserve v2 routes, sync entities, or realtime payloads.
- Treat the D1 database as disposable and replace the initial schema instead of writing a production data migration.
- Replace the upstream-owned web client and translations wholesale rather than merging hundreds of files.
- Preserve Cloudflare-specific runtime integration and keep unsupported capabilities disabled and hidden.
- Pin the server, web application, and SDK to exactly `3.2.2`.

## D1 Schema Findings

### Migration layout

- Rewrite `server/migrations/0001_initial.sql` as the complete v3-compatible initial schema.
- Fold required update-ID triggers into `0001_initial.sql` and delete `0002_add_updateid_triggers.sql`.
- Update `server/src/schema.ts`; this is the active Kysely schema, despite the older plan referring to a schema directory.
- Recreate local D1 databases after the rewrite. No v2 data upgrade path is required.

### Assets and edits

- Store asset duration as a nullable integer.
- Remove `deviceId` and `deviceAssetId` from active asset models, DTOs, queries, and responses.
- Include the v3 asset-file fields required by enabled R2-backed routes.
- Add `updatedAt` and `updateId` to `asset_edit`.
- Add the asset-edit deletion audit records required by v3 sync.
- Asset-edit changes must update `asset.isEdited` and advance its sync cursor.
- Do not add OCR, face, notification, workflow, plugin, external-library, or native-transcoding tables while those features are unavailable.

Authoritative upstream references:

- `upstream/server/src/schema/tables/asset-edit.table.ts`
- `upstream/server/src/schema/functions.ts`

### Albums

- Remove `album.ownerId` as the ownership source of truth.
- Represent ownership with one `album_user` relation whose role is `owner`.
- Add `Owner` to the active `AlbumUserRole` enum.
- Make the stored album description nullable.
- Map a null description to the v3 DTO value expected by clients where the response schema still requires a string.
- Non-owner album membership changes must advance the album sync cursor.
- Explicit relation deletions must create audits; cascade cleanup must not create misleading child deletion records.

Authoritative upstream references:

- `upstream/server/src/schema/tables/album.table.ts`
- `upstream/server/src/schema/tables/album-user.table.ts`
- `upstream/server/src/schema/functions.ts`

### IDs and atomicity

- Use one canonical lowercase, hyphenated UUIDv7 representation for create IDs, update IDs, audit IDs, and sync snapshots.
- Do not retain the current SQL raw-hex IDs or the current service-generated non-v7 timestamp IDs.
- Replace active interactive Kysely transactions with `D1Database.batch()` where multiple writes must be atomic, including sync reset and asset-edit replacement.
- Keep every D1 statement below 100 bound parameters.
- Store timestamps as ISO 8601 strings and booleans as SQLite integers.
- Add indexes for every active v3 Worker query rather than copying unused PostgreSQL indexes.

## Sync v3 Findings

### Routes and validation

- Delete the legacy `/sync/full-sync` and `/sync/delta-sync` routes and their service branches.
- Keep the v3 stream and acknowledgement API only.
- Apply the declared Zod validators to stream and acknowledgement routes; the current routes bypass some schemas.
- Use `application/jsonlines+json` for stream responses, not `application/x-ndjson`.
- Preserve one JSON object per line and a trailing newline.
- Unknown request types must fail instead of being ignored.
- Deprecated `AssetsV1`, `PartnerAssetsV1`, `AlbumAssetsV1`, and `AssetFacesV1` requests must return HTTP 400.
- Recognize `PeopleV1`, `AssetFacesV2`, and `AssetOcrV1`, but emit correctly framed empty results while those features cannot contain records.

Authoritative upstream references:

- `upstream/server/src/controllers/sync.controller.ts`
- `upstream/server/src/services/sync.service.ts`
- `upstream/server/src/dtos/sync.dto.ts`

### Checkpoints and snapshots

- Copy the exact request ordering from `upstream/server/src/services/sync.service.ts`.
- Bound ordinary entity reads with `updateId < nowId` and `updateId > acknowledgedId`.
- Bound backfill reads with `updateId <= beforeUpdateId`.
- Generate the snapshot UUIDv7 from the current time minus one millisecond, matching upstream ordering semantics.
- Do not silently stop after 1,000 records. Page with keyset continuation until the bounded result set is exhausted or the stream is cancelled.
- `GET /sync/ack` returns only `{ type, ack }`, never internal checkpoint columns.
- Reset clears pending-reset state and checkpoints before streaming; it must not set `isPendingSyncReset` to true again.
- Use D1 batch operations for reset and multi-ack writes.
- Relation backfills use composite acknowledgements and finish with an `extraId: "complete"` record.

Authoritative upstream references:

- `upstream/server/src/repositories/sync.repository.ts`
- `upstream/server/src/repositories/sync-checkpoint.repository.ts`
- `upstream/server/src/repositories/session.repository.ts`

### Entities and security

- Implement `AssetsV2` and `AssetV2`; `SyncAssetV2` includes `createdAt` and nullable integer duration.
- Implement `AlbumsV2`, `AlbumV2`, `AlbumAssetsV2`, and album-asset create, update, delete, and backfill records.
- Implement `PartnerAssetsV2` and partner backfill records.
- Implement `AssetEditsV1` and edit deletion records.
- Preserve retained v3 stack, memory, metadata, user, and relationship entities.
- Continue excluding locked assets from non-elevated sessions and prevent all cross-user leakage.
- The v3 `pinCode` sync shape is nullable string, but the stored bcrypt hash must never be returned. Use only a non-secret configured marker or null if the field is required.
- Reuse the v3 sync asset, EXIF, album, and edit mappers for realtime payloads.

## Realtime v3 Findings

The authoritative event declarations are in `upstream/server/src/repositories/websocket.repository.ts`.

### Required contract changes

| Event | v3.2.2 behavior |
|---|---|
| `on_server_version` | Sent to the user room and includes `prerelease` |
| `on_upload_success` | Owner only after supported upload processing completes |
| `AssetUploadReadyV2` | Owner only with `{ asset: SyncAssetV2, exif }` |
| `AssetEditReadyV2` | Owner only with `{ asset, edit[] }` |
| `on_album_update` | Sent after asset additions/removals and shared-link album uploads to all album users |
| `on_asset_stack_update` | Owner room with zero runtime arguments |
| `on_session_delete` | Session room after approximately 500 ms |
| Config and user deletion | Broadcast according to upstream targeting |

Implementation requirements:

- Replace `AssetUploadReadyV1` with `AssetUploadReadyV2`.
- Replace `AssetEditReadyV1` with `AssetEditReadyV2`.
- Add `on_album_update` producers only at the upstream-equivalent mutation points.
- Add `prerelease: null` to the server-version payload.
- Send server-version events to all sockets in the authenticated user room, not only the newly connected socket.
- Delay session-deletion delivery long enough for the client to receive it before optionally closing the socket.
- Remove generic `on_asset_update` emissions where upstream v3 does not produce them.
- Do not add HLS events while realtime transcoding is disabled.
- Do not create fake producers for unavailable notifications, maintenance, ML, or transcoding features.

Relevant upstream producers:

- `upstream/server/src/services/notification.service.ts`
- `upstream/server/src/services/job.service.ts`
- `upstream/server/src/services/version.service.ts`
- `upstream/server/src/services/album.service.ts`
- `upstream/server/src/services/asset-media.service.ts`

## Web and SDK Findings

### Clean replacement

Replace these paths from the exact upstream v3.2.2 tree:

- `web/src/`
- `web/static/`
- `web/tests/`
- `web/eslint.config.js`
- `web/lint-env.js`
- `web/.prettierrc`
- `web/.prettierignore`
- `web/svelte.config.js`
- `web/tsconfig.json`
- `web/vite.config.ts`
- Root `i18n/*.json`

The v2-to-v3 web delta changes hundreds of files and includes case-only renames, so a file-by-file merge is unsafe on macOS.

### Standalone adaptations

- Start from the v3.2.2 `web/package.json` dependency set.
- Replace upstream `"@immich/sdk": "workspace:*"` with exact `"@immich/sdk": "3.2.2"`.
- Keep the v3 UI dependency, including `@immich/ui` `^0.86.0`.
- Convert pnpm-specific scripts to npm where necessary.
- Remove or adapt monorepo-only `web/mise.toml` and `web/bin/immich-web` behavior.
- Keep a standalone Node pin compatible with upstream v3; upstream uses Node 24.15.0.
- Generate a fresh `web/package-lock.json` with npm.
- Delete and regenerate `web/build`; never overlay a v3 build on the v2 output.

### Behavior already present upstream

No custom PIN or locked-folder web patch needs to be replayed. V3.2.2 already contains:

- Locked-route elevation checks
- PIN prompt and session unlock
- PIN setup, change, and reset UI
- Locked visibility actions
- The corrected PIN reset boolean condition
- The later event-manager and editor fixes previously carried by this fork

The current committed v2 build is stale and still contains the old inverted PIN reset condition even though the source was fixed. Regenerating `web/build` is therefore mandatory.

### Cloudflare behavior to preserve

- Preserve the `ASSETS` binding and SPA routing in `server/wrangler.toml`.
- Preserve the static adapter output with `fallback: 'index.html'` and precompression; upstream v3 already supports both.
- Preserve SPA mode in the root Svelte layout.
- Add a path-sensitive Worker API 404 before static asset fallback. Otherwise an unknown `/api/*` route can return `index.html` with HTTP 200.

### Translations

- Replace translations with all v3.2.2 locale JSON files.
- Delete stale `i18n/package.json` and `i18n/.prettierrc`.
- Do not keep `zh_SIMPLIFIED.json`; v3 uses `zh_Hans.json`.
- V3 dynamically loads every JSON file in `i18n`, so non-locale JSON files must not remain there.

## Unsupported UI Gates

The current fork has no comprehensive custom capability-gating layer to carry forward. Add v3 gates for unsupported Worker features rather than implementing placeholder APIs.

- Hide people and face actions and block direct routes while facial recognition is disabled.
- Hide duplicate and large-file utilities when their required search operations are unavailable.
- Hide places and geolocation routes while map and geodata APIs are unavailable.
- Hide workflows and plugins in utilities and command menus and block direct routes.
- Hide unsupported admin libraries, queues, maintenance, backups, ML, notification, and job controls.
- Disable unconditional notification refresh and hide the notification bell.
- Hide asset editor and no-op metadata, thumbnail, and transcode job actions.
- Guard direct search and explore routes, not only their navigation links.
- Return `realtimeTranscoding: false` in v3 feature responses.

## Version and Discovery Requirements

- Set server and web package versions to `3.2.2`.
- Set `SERVER_VERSION` to `3.2.2`.
- Pin `@immich/sdk` to exactly `3.2.2`.
- Return this exact server-version object:

```json
{ "major": 3, "minor": 2, "patch": 2, "prerelease": null }
```

- Add required v3 feature fields, including `realtimeTranscoding: false`.
- Align `/public/config`, `/config`, `/admin/config`, and their defaults routes with v3.2.2.
- Remove obsolete v2 discovery routes such as `/server/theme`.

## Regression Coverage

### Sync

Focused top-level Worker tests must cover:

1. Exact content type, request ordering, NDJSON framing, trailing newline, and completion record.
2. API-key rejection plus unknown and deprecated request-type errors.
3. Initial asset, album owner/member, metadata, and asset-edit payloads.
4. Base64 binary fields, integer duration, ISO dates, nullability, and SQLite boolean conversion.
5. ACK list/write/delete shape, limits, selective deletion, and reset behavior.
6. Representative incremental update and hard-delete convergence.
7. Album and partner relationship backfills with composite and `complete` acknowledgements.
8. More than 1,000 rows to prove pagination.
9. Snapshot isolation for mutations created after stream capture.
10. Locked-asset and cross-user isolation.
11. Reader cancellation stopping further pages.

### Realtime

Socket tests must cover:

1. Exact v3 server version including `prerelease: null`.
2. Same-user multi-socket room targeting.
3. Exact `AssetUploadReadyV2` payload and absence of V1 events.
4. Exact `AssetEditReadyV2` payload and absence of V1 events.
5. `on_album_update` delivery to every album user, including shared-link uploads.
6. Scalar and array argument shapes for lifecycle events.
7. Zero arguments for `on_asset_stack_update`.
8. Locked updates delivered only to elevated sessions.
9. Delayed session-delete delivery and any post-delivery disconnect.
10. Broadcast behavior for config and user deletion.

### Web

Add focused tests for:

- PIN reset with password login enabled and disabled
- Unsupported navigation and command entries
- Direct-route guards
- No notification or plugin requests when disabled
- Playback behavior when `realtimeTranscoding` is false
- Unknown `/api/*` paths returning an API 404 rather than SPA HTML

## Verification

Run from `server/`:

```sh
npm run test:all
npx wrangler deploy --dry-run
```

Run from `web/`:

```sh
npm ci
npm run check:svelte
npm run check:typescript
npm test -- --run
npm run build
```

Worker integration tests cover the protocol side of admin signup/login, timeline and upload, thumbnail/original downloads, albums, shared-link login and downloads, PIN and locked folders, initial and incremental sync, and realtime upload and album updates. Real-browser and upstream v3.2.2 mobile-client smoke tests remain external validation as documented in `COMPATIBILITY.md`.

# Immich v3.2.2 Port Plan

This document records the v3.2.2 port that has now been implemented for the enabled Worker surface. Validated implementation details, exact upstream references, web preservation rules, and regression coverage are recorded in `V3_MIGRATION_FINDINGS.md`. Use `FEATURE_STATUS.md` for current product limitations rather than treating every upstream Immich feature as unfinished migration work.

## Current Progress

- Imported and built the exact v3.2.2 web source, tests, static assets, SDK, and translations.
- Switched server/package version reporting and core discovery to v3.2.2.
- Added v3 public config and removed the obsolete server-theme route.
- Ported core asset upload/responses to the device-ID-free v3 shape with nullable integer duration.
- Removed v2-only asset existence, device, random, and original-replacement routes.
- Added `AssetUploadReadyV2`, v3 server-version events, and album update events.
- Removed legacy full/delta sync routes and added a tested `AssetsV2` JSON Lines stream baseline.
- Replaced `album.ownerId` with the v3 owner-role album membership model, nullable stored descriptions, owner-first responses, and `isOwned`/`isShared` filtering.
- Replaced the fresh D1 schema with v3 UUIDv7 cursors, relationship create cursors, edit/audit tables, and active deletion triggers.
- Completed the enabled v3 sync families, bounded paging, partner/shared-album backfills, composite acknowledgements, deletion convergence, and locked-folder isolation.
- Added v3 shared-link cookie login and downloads, API-key rotation, configuration visibility, asset-edit sync, and repaired tag, memory, stack, and user response contracts.
- Added API-level smoke coverage for signup/login, upload and timeline retrieval, media download, albums, shared links, PIN/locked assets, sync, and realtime.

The remaining migration closure work is external client validation: run the exact web build in a real browser and run an upstream v3.2.2 mobile client against the Worker. Capability-gating unsupported pages is intentionally not part of the current scope. Media processing, advanced timeline behavior, forced cleanup, UI gating, and other items listed as deferred in `FEATURE_STATUS.md` predate this port and are not regressions introduced by v3.

## Goal

Rebase WorkersImmich on the latest stable Immich release, v3.2.2. Treat this repository as a fresh project with no deployed databases, existing users, or v2 clients to preserve.

This is a direct port, not a production migration:

- Replace the v2.5.2 web client and SDK with v3.2.2.
- Change the active Hono Worker API to the v3.2.2 contract.
- Replace the current D1 schema and migrations where that is simpler than upgrading them.
- Implement v3 sync and realtime behavior directly; do not retain v2 protocol compatibility.
- Keep unsupported features disabled and hidden.
- Update all version references to v3.2.2 when the port is complete.

## Upstream Baseline

Use the exact `immich-app/immich@v3.2.2` tag as the source of truth:

- `open-api/immich-openapi-specs.json`
- Active upstream controllers, DTOs, services, and repositories
- Sync request ordering, entities, and checkpoint semantics
- Socket.IO events and payloads
- `web/`, `i18n/`, and `packages/sdk`

Do not port upstream NestJS, PostgreSQL, Redis, filesystem, queue, or native-media infrastructure. Translate required behavior to Hono, D1, R2, KV, and Durable Objects.

## 1. Replace The D1 Schema

Rewrite `server/migrations/0001_initial.sql` as the complete v3-compatible initial schema. Delete `0002_add_updateid_triggers.sql` and fold any still-required triggers into the new initial migration. Additional migration files are unnecessary unless they make the schema easier to maintain.

Update the active Kysely schema under `server/src/schema/` to match.

Required schema changes include:

- Store asset duration as a nullable integer.
- Remove `deviceId` and `deviceAssetId` from the asset model.
- Make album descriptions nullable.
- Include the v3 asset-file and asset-edit fields used by enabled routes.
- Include audit/update tables needed by v3 sync.
- Support v3 album ownership and album-user relationships.
- Support partner and album-asset backfills and deletion records.
- Include v3 user preference fields used by the web client.
- Include API-key rotation state.
- Keep PIN and locked-folder fields already added by this fork.
- Keep timestamps as ISO 8601 strings and booleans as SQLite integers.
- Add indexes for active Worker queries.

Do not add unused PostgreSQL-oriented tables for unavailable features such as ML, OCR, workflows, plugins, external libraries, notifications, or native video transcoding.

After rewriting the migration, recreate the local D1 database rather than attempting to upgrade old data.

## 2. Port The Server Contract

Use the v3.2.2 OpenAPI specification to update active routes, DTO validation, response mappers, permissions, status codes, and errors.

### Discovery And Configuration

- Return `{ major, minor, patch, prerelease }` from `/server/version`.
- Add required v3 feature fields, including `realtimeTranscoding: false`.
- Implement `/public/config`, `/config`, and `/admin/config` with their required defaults routes.
- Remove obsolete v2 routes such as `/server/theme`.
- Keep unsupported capabilities false and omit secrets from public/user responses.

### Assets And Timeline

- Remove device identifiers from asset requests and responses.
- Return nullable integer duration everywhere, including timeline and sync.
- Update the v3 nested people shape.
- Add `createdAt` and v3 ordering to timeline responses.
- Remove v2 asset routes absent from v3:
  - `GET /assets/device/{deviceId}`
  - `POST /assets/exist`
  - `GET /assets/random`
  - `PUT /assets/{id}/original`
- Add only the v3 asset-file APIs required by the web or mobile client and supported by R2.

### Search

- Port v3 cursor pagination, structured filters, ordering, and `nextCursor`.
- Implement the subset required by enabled web pages.
- Keep search disabled in feature responses until that subset works correctly.
- Reject unsupported filters rather than ignoring them.

### Asset Edits And Downloads

- Replace the v2 edit DTOs with `AssetEditsCreateDto` and `AssetEditsResponseDto`.
- Persist and return edit IDs.
- Accept `archiveName` and `edited` in archive download requests.
- Reject edited-media downloads while rendered edits remain unavailable.

### Shared Links

- Add `POST /shared-links/login`.
- Use the v3 shared-link token cookie format.
- Update `GET /shared-links/me` to use cookie tokens.
- Remove `token` from shared-link responses.
- Remove `changeExpiryTime`; use nullable `expiresAt`.
- Apply shared-link authorization to media and archive downloads.

### Users, Preferences, Tags, And API Keys

- Add v3 required preference fields and defaults.
- Add nullable `clusterGroupId` to admin user responses while cluster groups are unavailable.
- Implement tag renaming.
- Return the complete v3 API-key creation response.
- Add API-key rotation and immediately invalidate the old secret.
- Add v3 bulk response fields and the `validation` error reason.

### Remove V2-Only Behavior

- Delete legacy full and delta sync routes.
- Delete obsolete DTOs and service branches instead of maintaining compatibility shims.
- Remove tests that only exercise removed v2 operations.

## 3. Port Sync To V3

Replace the v2 sync implementation with the v3.2.2 stream contract and request ordering.

Implement the v3 request and entity types used by the client, including:

- `AssetsV2` and `AssetV2`
- `AlbumsV2` and `AlbumV2`
- `AlbumAssetsV2` and its create, update, delete, and backfill records
- `PartnerAssetsV2` and its backfill records
- `AssetEditsV1` and deletion records
- Existing stack, memory, metadata, user, and relationship entities retained by v3

Recognize `AssetFacesV2` and `AssetOcrV1`, but return correctly framed empty results while those features are disabled and cannot have records.

Preserve:

- NDJSON framing
- V3 request ordering
- Reset, acknowledgement, and completion records
- Checkpoint continuation
- Update and deletion convergence
- Locked-asset and cross-user isolation

Validate request types. Unknown types must fail instead of being silently ignored.

Add one focused top-level `server/test/sync.test.ts` covering initial sync, acknowledgement, a representative incremental update, deletion, album membership, unknown types, and NDJSON framing. A large migration fixture or dual-v2/v3 test matrix is not needed.

## 4. Port Realtime To V3

Update the Durable Object event contract to match v3.2.2:

- Replace `AssetUploadReadyV1` with `AssetUploadReadyV2`.
- Replace `AssetEditReadyV1` with `AssetEditReadyV2`.
- Add `on_album_update`.
- Use the same v3 sync asset mappers for event payloads.
- Add `prerelease` to `on_server_version`.
- Remove v2-only event payloads.
- Do not add HLS events while realtime transcoding is disabled.

Update `server/test/socket.test.ts` with focused assertions for the changed event names, payloads, targets, and version response.

## 5. Replace The Web Client And SDK

The web tree has been replaced with upstream v3.2.2. Keep future web changes limited to standalone npm/Cloudflare integration and explicit unsupported-feature gates.

- Replace `web/src`, `web/static`, web tests, and web build configuration with v3.2.2.
- Replace root `i18n/` with v3.2.2 translations.
- Use the exact `@immich/sdk` version `3.2.2` if published.
- If the package is unavailable, vendor the built v3.2.2 SDK from upstream `packages/sdk`.
- Do not use upstream's `workspace:*` dependency in this standalone repository.
- Regenerate `web/package-lock.json` with npm.
- Delete and regenerate `web/build`; do not overlay builds.

Preserve only WorkersImmich-specific behavior:

- Static Svelte adapter output and SPA fallback.
- `server/wrangler.toml` asset routing.
- PIN and locked-folder behavior not already present upstream.
- Any deliberate UI gating for unsupported Worker features.

Do not replay current event-manager or editor patches that already exist upstream in v3.2.2.

Review new v3 pages and controls. Hide unsupported features rather than creating placeholder endpoints that return success.

## 6. Update Versions And Documentation

Update all pins to exactly `3.2.2`:

- `server/src/constants.ts`
- `server/package.json` and lockfile
- `web/package.json` and lockfile
- `@immich/sdk`

Update:

- `docs/COMPATIBILITY.md`
- `docs/FEATURE_STATUS.md`
- `README.md`
- Version assertions in server and Socket.IO tests

The final version response must be:

```json
{ "major": 3, "minor": 2, "patch": 2, "prerelease": null }
```

## Verification

Add focused regression coverage for changed v3 contracts. Do not build an extensive migration or dual-version harness.

Required server checks:

```sh
cd server
npm run test:all
npx wrangler deploy --dry-run
```

Automated web checks:

```sh
cd web
npm ci
npm run check:svelte
npm run check:typescript
npm run build
```

The Worker integration suite now covers the API/protocol side of these core flows. Repeat them through a real browser or upstream mobile client where noted in `COMPATIBILITY.md`:

1. Initial admin signup and login.
2. Timeline load and image upload.
3. Thumbnail and original download.
4. Album creation and asset membership.
5. Shared-link login and download.
6. PIN and locked-folder access.
7. Initial and incremental mobile sync.
8. Realtime upload and album updates.

## Implemented Work Order

Steps 1 through 7 are complete for the enabled Worker surface. Step 8 is complete for automated protocol checks; real-browser and upstream-mobile validation remain external.

1. Replace the D1 schema and active Kysely types.
2. Port discovery/config and core server DTOs/routes.
3. Port shared links, API keys, edits, timeline, and search.
4. Replace sync with the v3 protocol.
5. Replace realtime V1 events with V2 events.
6. Replace the web client, SDK, and translations.
7. Remove remaining v2 code and update versions/docs.
8. Run verification and smoke tests.

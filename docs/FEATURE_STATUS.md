# Feature Status And Roadmap

## Scope

This document describes the active Hono/Cloudflare Worker implementation. It does not count retained NestJS controllers, PostgreSQL repositories, or upstream medium tests as working features unless they are used by `server/src/index.ts` and `server/src/services.ts`.

Status labels:

- **Verified**: exercised by the active Worker integration suite.
- **Implemented**: active code exists, but coverage is incomplete.
- **Partial**: a route or workflow exists but important client-visible behavior is missing or degraded.
- **Unavailable**: no working active implementation exists.

## Verified Core

| Area | Status | Current scope |
|---|---|---|
| Authentication | Verified | Admin signup, password login, logout, token validation, password changes, API-key CRUD and rotation, PIN lifecycle, and session elevation. |
| Users | Verified | Current user, preferences, user listing, admin creation, duplicate protection, admin lookup, role enforcement, and the required per-user cluster-group identifier. Cluster-group people APIs remain unavailable. |
| Basic assets | Verified | JPEG upload, checksum duplicate detection, direct metadata update, statistics, device IDs, original download, and soft delete. |
| Albums | Verified | Create, list, fetch, update, delete, statistics, owner-role membership, v3 owned/shared filtering, and add/remove assets. |
| Locked assets | Verified | Elevation checks plus isolation from albums, links, default search, folder view, stacks, indirect Live Photo access, and owner/cross-user sync. PIN elevation changes force sync reset convergence. |
| Realtime | Verified for core events | Socket.IO-compatible authentication, Engine.IO handshake, owner-targeted asset events, and session revocation. |
| Server discovery | Verified | V3.2.2 ping, version including prerelease, feature flags, public config, media types, about, API 404 behavior, and `/.well-known/immich`. |

The active suite currently has 125 API tests and 4 Socket.IO tests. Coverage is strongest for the areas above.

## Partial Features

### Assets And Media

| Feature | Status | Remaining work |
|---|---|---|
| Image derivatives | Partial | Development and test environments can copy original bytes when image resizing is not configured. Production needs a verified Cloudflare Images or equivalent transform path with correct formats and metadata. |
| Video | Partial | Originals can be stored and served, but there is no transcoding or video thumbnail generation. |
| RAW, HEIC, and other non-browser images | Partial | Files can be accepted, but preview generation is incomplete and may not produce usable timeline media. |
| Live Photos | Partial | Relationships can be updated, but upload and sync behavior is not complete enough for a compatibility claim. |
| Sidecars | Partial | Sidecar bytes can be stored, but EXIF write-back and complete sidecar lifecycle behavior are not implemented. |
| Asset copy | Partial | Favorite state is copied; albums, shared links, stacks, and sidecars are stubs. |
| Asset editing | Partial | Edit create, replacement, removal, edited-file cleanup, and mobile sync convergence are verified. Edited media is not rendered and the expected completion event is not produced. |
| Asset jobs | Partial | Job endpoints accept requests, but refresh metadata, regenerate thumbnail, and transcode operations are no-ops. |
| Permanent deletion | Partial, deferred | Empty trash is bind-safe, repairs stacks, atomically removes D1 relationships/assets, decrements original-byte quota usage, and generates sync tombstones. Immediate forced asset cleanup is intentionally deferred. R2 objects are deleted before the D1 batch because the services cannot share a transaction; an R2 failure leaves D1 and quota unchanged, while a later D1 failure can leave retry-safe missing objects until the request is retried. The old v2 original-replacement endpoint does not exist in v3 and is not remaining work. |

### Timeline, Search, And Organization

| Feature | Status | Remaining work |
|---|---|---|
| Timeline | Partial | Basic own-user buckets work. Partner inclusion, stack collapsing, trash semantics, people filters, and some query options are incomplete. |
| Search | Partial and disabled | Metadata search routes exist, but only a subset of filters is implemented, album results are incomplete, and the server advertises search as disabled. |
| Partners | Partial | Relationship CRUD, direct access, and mobile asset/EXIF/stack sync backfills exist. Main timeline inclusion and upstream mobile smoke testing remain incomplete. |
| Stacks | Partial | Active CRUD routes use v3 response mapping and permanent deletion repairs the primary asset. Update/delete coverage and timeline collapsing remain. |
| Tags | Partial | CRUD, v3 response mapping, subtree rename, hierarchy closure/reparent invariants, and bind-safe bulk assignment are verified. Upstream client smoke testing remains. |
| Activities | Implemented | Basic activity paths exist and sanitized responses are covered indirectly. Collaboration and realtime coverage remain incomplete. |
| Folder view | Partial | Folder routes work on stored object keys, but R2-generated paths are not equivalent to meaningful external-library source folders. |

### Sharing And Memories

| Feature | Status | Remaining work |
|---|---|---|
| Shared links | Partial | Album and individual links, v3 DTO validation, password-cookie login, owner-only membership changes, and shared archive authorization are verified. Upstream client smoke testing remains. |
| Archive downloads | Partial | JSON and web form ZIP requests, sanitized names, shared-link authorization, and D1 bind-safe asset queries are verified. Edited assets and large-stream backpressure remain incomplete. |
| Memories | Partial | CRUD, query filters, pagination, validation, response mapping, and asset membership exist. Automatic "On this day" generation has no scheduled implementation. |

### Mobile Sync

| Feature | Status | Remaining work |
|---|---|---|
| Sync routes | Partial | Snapshot-bounded keyset paging, V2 assets/albums, exact EXIF and asset-edit entities, partner/shared-album backfills, composite checkpoints, deletion audits, locked owner-family isolation, validation, framing, and deprecated-type rejection are integration-tested. Legacy full/delta routes have been removed; unsupported entity families and upstream mobile smoke testing remain. |
| People and faces | Unavailable by design | Sync request types return no entities because ML people/faces are not implemented. |
| Partner and shared-album backfills | Partial | Partner assets, EXIF, and stacks plus album users, assets, EXIF, and album-to-asset relations implement resumable composite backfills and completion markers. Integration tests exercise partner asset and every shared-album backfill shape; partner EXIF/stack backfill coverage and mobile smoke testing remain. |
| Deletion convergence | Partial | Active hard deletes and explicit removals generate audit records, with album and memory cascade suppression verified for representative paths. Exhaustive route-level coverage and mobile convergence testing remain. |
| Sync testing | Partial | NDJSON tests cover snapshot bounds, paging beyond 1,000 rows, V2 albums, EXIF, edits, cross-user isolation, hard-delete tombstones, partner resume, unelevated/elevated locked-family isolation, lock transition convergence, favorite masking, and shared-album composite backfills. An upstream mobile client is not run in CI. |

### Administration And Configuration

| Feature | Status | Remaining work |
|---|---|---|
| System configuration | Partial | V3 public, user, admin, and legacy admin visibility contracts are validated and tested. Unsupported infrastructure settings remain present but forced disabled and are not consumed by active services. |
| Custom CSS | Implemented | `/custom.css` serves the configured admin theme stylesheet. |
| Storage statistics | Partial | Capacity is hardcoded and derivative R2 usage is not fully represented. |
| User deletion | Partial, deferred | Soft deletion works. Resumable forced account cleanup is intentionally deferred and a forced user can remain in `removing`; this is inherited product debt rather than unfinished v3 contract migration. |
| Admin web UI | Partial | The preserved UI still exposes libraries, jobs, maintenance, backup, and configuration controls that are absent or incomplete. |
| Licensing | Partial | Storage and validation are simplified and are not equivalent to upstream license verification. |

## Unavailable API Families

The following upstream feature families do not have a complete active Worker implementation:

- Facial recognition, people, face import, OCR, smart search, and duplicate detection
- Map search, geodata, and reverse geocoding
- External library scanning and filesystem watching
- Background job and queue administration
- OAuth/OIDC login
- Email delivery and notification producers, persistence, and mutations. The authenticated notification inbox route is available and returns an empty list.
- Database backup and restore APIs
- Maintenance mode worker APIs
- Plugin and workflow execution
- Native video transcoding

Some of these are intentionally outside the current proof-of-concept. Others could be implemented with Cloudflare Queues, Cron Triggers, Images, Stream, Workers AI, Vectorize, or an external service.

## Web UI Gaps

The web client is preserved largely intact, so route absence alone does not hide unsupported features. Capability gating is intentionally deferred for the current scope; unsupported pages or controls may remain visible and fail against unavailable API families.

Priority UI gaps include:

- Notification actions beyond the empty inbox compatibility route
- External libraries
- Job and queue administration
- Maintenance and database backup pages
- Asset editing and no-op job actions
- System settings whose configuration branches are not supported

Search, map, people, duplicate, and ML-driven features remain disabled in server feature responses. Additional web route and control gating is not currently planned.

## Migration Closure

The enabled API surface is ported to v3.2.2 and has protocol-level smoke coverage. Remaining migration validation is:

1. Run the exact v3.2.2 web build through the documented core flows in a real browser. There is currently no browser E2E runner.
2. Run an upstream v3.2.2 mobile client against initial/incremental sync, deletion convergence, and partner/shared-album backfills. No mobile client is available in this repository.

## Deferred Product Backlog

These limitations existed in the v2 Worker baseline or depend on infrastructure outside the direct v3 port. They are documented but are not migration blockers:

1. Add production image derivatives, video transcoding and thumbnails, and usable RAW/HEIC previews, or explicitly reject unsupported media.
2. Complete partner and stack-aware timeline behavior and the remaining timeline filters.
3. Complete Live Photo and sidecar upload, download, sync, and deletion behavior.
4. Render edited media and emit the expected completion event; harden large ZIP streaming backpressure.
5. Add scheduled memory generation and optional deferred cleanup with Queues or Cron Triggers.
6. Implement resumable forced asset/user cleanup if it becomes a product requirement.
7. Complete asset-copy relationship semantics, storage accounting, and the remaining route-level mutation tests.
8. Optionally capability-gate unsupported web pages and no-op actions; this is explicitly deferred and not required for the current scope.

### Optional Cloudflare-Native Expansion

1. Use Cloudflare Queues and Cron Triggers for deferred media work, cleanup, and memory generation.
2. Use Cloudflare Images or an external image service for dependable derivatives.
3. Use Cloudflare Stream or an external transcoder for video.
4. Add a Workers-compatible OIDC implementation.
5. Add an external email and notification provider.
6. Evaluate Workers AI, Vectorize, or an external ML service for optional ML features.
7. Document D1-managed backup and restore instead of emulating PostgreSQL backup internals.

## Definition Of Complete

A feature should move to **Verified** only when:

1. Its active Hono routes match the v3.2.2 contract.
2. Authorization, cross-user isolation, validation, and error paths are tested.
3. D1, R2, quota, audit, and relationship side effects are correct.
4. Required realtime and mobile sync effects are implemented.
5. The preserved web client completes the workflow without hidden server errors.
6. An upstream mobile client completes the workflow when applicable.
7. Bulk behavior stays within D1 and Worker limits.
8. The full server suite, Socket.IO suite, web build, and Wrangler dry-run pass.

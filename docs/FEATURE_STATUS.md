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
| Authentication | Verified | Admin signup, password login, logout, token validation, password changes, API-key permissions, PIN lifecycle, and session elevation. |
| Users | Verified | Current user, preferences, user listing, admin creation, duplicate protection, admin lookup, and role enforcement. |
| Basic assets | Verified | JPEG upload, checksum duplicate detection, direct metadata update, statistics, device IDs, original download, and soft delete. |
| Albums | Verified | Create, list, fetch, update, delete, statistics, and add/remove assets. |
| Locked assets | Verified | Elevation checks plus isolation from albums, links, default search, folder view, stacks, indirect Live Photo access, and cross-user sync. |
| Realtime | Verified for core events | Socket.IO-compatible authentication, Engine.IO handshake, owner-targeted asset events, and session revocation. |
| Server discovery | Verified | Ping, version, feature flags, public config, media types, about, and `/.well-known/immich`. |

The active suite currently has 66 API tests and 4 Socket.IO tests. Coverage is strongest for the areas above.

## Partial Features

### Assets And Media

| Feature | Status | Remaining work |
|---|---|---|
| Image derivatives | Partial | Development and test environments can copy original bytes when image resizing is not configured. Production needs a verified Cloudflare Images or equivalent transform path with correct formats and metadata. |
| Video | Partial | Originals can be stored and served, but there is no transcoding or video thumbnail generation. |
| RAW, HEIC, and other non-browser images | Partial | Files can be accepted, but preview generation is incomplete and may not produce usable timeline media. |
| Live Photos | Partial | Relationships can be updated, but upload and sync behavior is not complete enough for a compatibility claim. |
| Sidecars | Partial | Sidecar bytes can be stored, but EXIF write-back and complete sidecar lifecycle behavior are not implemented. |
| Asset replacement | Partial | The route exists, but active resource access does not currently implement `AssetReplace`, and quota replacement accounting needs validation. |
| Asset copy | Partial | Favorite state is copied; albums, shared links, stacks, and sidecars are stubs. |
| Asset editing | Partial | Edit instructions can be stored, but edited media is not rendered and the expected completion event is not produced. |
| Asset jobs | Partial | Job endpoints accept requests, but refresh metadata, regenerate thumbnail, and transcode operations are no-ops. |
| Permanent deletion | Partial | Empty trash removes rows and R2 objects inline. Forced deletion, quota decrementing, audit records, and failure recovery need completion. |

### Timeline, Search, And Organization

| Feature | Status | Remaining work |
|---|---|---|
| Timeline | Partial | Basic own-user buckets work. Partner inclusion, stack collapsing, trash semantics, people filters, and some query options are incomplete. |
| Search | Partial and disabled | Metadata search routes exist, but only a subset of filters is implemented, album results are incomplete, and the server advertises search as disabled. |
| Partners | Partial | Relationship CRUD and direct access exist. Main timeline inclusion and mobile partner backfills remain incomplete. |
| Stacks | Partial | Active CRUD routes exist. Creation, retrieval, large merges, and locked-primary behavior are tested; update/delete coverage and timeline collapsing remain. |
| Tags | Partial | CRUD and assignment exist. Hierarchy closure, descendants, response mapping, and comprehensive tests remain. |
| Activities | Implemented | Basic activity paths exist and sanitized responses are covered indirectly. Collaboration and realtime coverage remain incomplete. |
| Folder view | Partial | Folder routes work on stored object keys, but R2-generated paths are not equivalent to meaningful external-library source folders. |

### Sharing And Memories

| Feature | Status | Remaining work |
|---|---|---|
| Shared links | Partial | Basic album and individual links work. Password cookie persistence, shared-link archive downloads, and complete validation need work. |
| Archive downloads | Partial | Authenticated ZIP routes exist. Shared-link authentication and large archive behavior need coverage. |
| Memories | Partial | CRUD and asset membership exist. Responses need complete mapping, and automatic "On this day" generation has no scheduled implementation. |

### Mobile Sync

| Feature | Status | Remaining work |
|---|---|---|
| Sync routes | Partial | Full, delta, and streaming infrastructure exist, but the incomplete entity and audit behavior below prevents a compatibility claim. |
| People and faces | Unavailable by design | Sync request types return no entities because ML people/faces are not implemented. |
| Partner and shared-album backfills | Partial | Partner assets, partner EXIF, partner stacks, album assets, and album EXIF request types are stubs. |
| Deletion convergence | Partial | Audit tables exist, but active mutations do not consistently write every required audit record. Hard deletes and relationship removals can fail to converge on clients. |
| Sync testing | Partial | Cross-user authorization is covered. End-to-end initial sync, incremental updates, hard deletes, and relationship removals need NDJSON tests. |

### Administration And Configuration

| Feature | Status | Remaining work |
|---|---|---|
| System configuration | Partial | A reduced configuration is stored, but many settings are hardcoded or not consumed by active services. |
| Custom CSS | Unavailable | `/custom.css` currently returns an empty stylesheet. |
| Storage statistics | Partial | Capacity is hardcoded and derivative R2 usage is not fully represented. |
| User deletion | Partial | Soft deletion works, but forced deletion has no background cleanup and can remain in `removing`. |
| Admin web UI | Partial | The preserved UI still exposes libraries, jobs, maintenance, backup, and configuration controls that are absent or incomplete. |
| Licensing | Partial | Storage and validation are simplified and are not equivalent to upstream license verification. |

## Unavailable API Families

The following upstream feature families do not have a complete active Worker implementation:

- Facial recognition, people, face import, OCR, smart search, and duplicate detection
- Map search, geodata, and reverse geocoding
- External library scanning and filesystem watching
- Background job and queue administration
- OAuth/OIDC login
- Email and user notifications
- Database backup and restore APIs
- Maintenance mode worker APIs
- Plugin and workflow execution
- Native video transcoding

Some of these are intentionally outside the current proof-of-concept. Others could be implemented with Cloudflare Queues, Cron Triggers, Images, Stream, Workers AI, Vectorize, or an external service.

## Web UI Gaps

The web client is preserved largely intact, so route absence alone does not hide unsupported features. Before production use, unsupported pages and actions must either be implemented or capability-gated.

Priority UI gaps include:

- Notification bell and notification requests
- External libraries
- Job and queue administration
- Maintenance and database backup pages
- Asset editing and no-op job actions
- System settings whose configuration branches are not supported

Search, map, people, duplicate, and ML-driven pages should remain hidden by server capability flags. Automated web tests should verify that unsupported direct routes and controls do not reappear.

## Roadmap

### P0: Correctness And Honest Client Behavior

1. Build an API contract matrix against Immich v2.5.2 and add web/mobile smoke tests.
2. Complete sync audit writes, hard-delete convergence, relationship removals, and partner/shared-album backfills.
3. Correct permanent deletion, quota decrementing, asset replacement accounting, and forced user deletion.
4. Provide a real derivative pipeline or disable media formats and UI actions that cannot produce valid previews.
5. Capability-gate unsupported web pages and no-op actions.
6. Align the system configuration response with the settings UI or reduce the UI to the supported contract.

### P1: Core Feature Completion

1. Complete partner and stack-aware timeline behavior.
2. Complete password-protected shared links and shared archive downloads.
3. Complete Live Photo and sidecar upload, download, sync, and deletion behavior.
4. Complete memory response mapping and add scheduled memory generation.
5. Complete tag hierarchy and descendant semantics.
6. Add tests for trash emptying, ZIP downloads, memories, tags, timeline options, configuration, and media variants.

### P2: Cloudflare-Native Expansion

1. Use Cloudflare Queues and Cron Triggers for deferred media work, cleanup, and memory generation.
2. Use Cloudflare Images or an external image service for dependable derivatives.
3. Use Cloudflare Stream or an external transcoder for video.
4. Add a Workers-compatible OIDC implementation.
5. Add an external email and notification provider.
6. Evaluate Workers AI, Vectorize, or an external ML service for optional ML features.
7. Document D1-managed backup and restore instead of emulating PostgreSQL backup internals.

## Definition Of Complete

A feature should move to **Verified** only when:

1. Its active Hono routes match the v2.5.2 contract.
2. Authorization, cross-user isolation, validation, and error paths are tested.
3. D1, R2, quota, audit, and relationship side effects are correct.
4. Required realtime and mobile sync effects are implemented.
5. The preserved web client completes the workflow without hidden server errors.
6. An upstream mobile client completes the workflow when applicable.
7. Bulk behavior stays within D1 and Worker limits.
8. The full server suite, Socket.IO suite, web build, and Wrangler dry-run pass.

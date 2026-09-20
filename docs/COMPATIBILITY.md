# Compatibility

## Baseline

WorkersImmich currently targets the Immich v2.5.2 API and client model. The preserved web application declares `@immich/sdk` v2.5.2. Mobile source is not included in this repository.

This project is not yet a drop-in replacement for an upstream Immich v2.5.2 server. Core workflows are implemented, but several API groups and background-processing features remain partial or unavailable. See `FEATURE_STATUS.md` for the detailed matrix.

## What Compatibility Means

A compatible endpoint must preserve all of the following:

- HTTP path and method
- Authentication and permission rules
- Request fields, defaults, validation, and unknown-field behavior
- Status code and error response shape
- Response fields, types, nullability, enum values, and date encoding
- Pagination, ordering, and filtering semantics
- Side effects such as audit records, quota changes, relationship cleanup, and realtime events
- Mobile sync checkpoints, entity framing, backfills, and deletion convergence
- Socket.IO event name, recipient, argument order, and payload

Matching only the route name or returning HTTP 200 is not sufficient.

## Current Confidence

| Area | Confidence | Evidence and limits |
|---|---|---|
| Password authentication | Integration tested | Signup, login, logout, token validation, and password changes are covered in `server/test/auth.test.ts`. |
| PIN and locked assets | Integration tested | PIN lifecycle, elevation, albums, links, search, stacks, folder paths, and indirect live-photo access are covered. |
| Users and preferences | Integration tested | Core self-service and admin operations are covered in `server/test/users.test.ts`. |
| Basic image assets | Integration tested | Upload, duplicate detection, metadata update, statistics, original download, and soft delete are covered. Derivatives and non-image formats remain limited. |
| Albums | Integration tested | Core CRUD and asset membership are covered. Collaboration edge cases are not comprehensive. |
| Realtime | Integration tested for core events | Authentication, Engine.IO handshake, asset lifecycle targeting, and session revocation are covered. All upstream event families are not covered. |
| Web SPA | Partial | The upstream UI is largely preserved, but it still exposes some features that the Worker does not fully support. |
| Mobile sync | Partial | Streaming routes exist, but partner/shared-album backfills, people/faces, and deletion convergence are incomplete. |
| Media processing | Partial | Original files work. Video transcoding, video thumbnails, RAW previews, and dependable image derivatives are not complete. |
| Full upstream API | Incomplete | OAuth, notifications, libraries, jobs, backups, maintenance, plugins, ML, and map APIs are absent or intentionally disabled. |

## Automated Verification

The current active server verification is:

```sh
cd server
npm run test:all
npx wrangler deploy --dry-run
```

At the time this document was written, the suite contained 66 top-level API tests and 4 Socket.IO tests. Test counts will change as coverage grows.

This suite does not prove complete client compatibility. It does not run an upstream mobile application, and it does not cover every page in the preserved web client.

## Required Client Checks

Before describing a release as web compatible, smoke-test these flows with the v2.5.2 web build:

1. Initial admin signup and login
2. Timeline loading and pagination
3. Image upload, original download, thumbnail display, and deletion
4. Album create, edit, membership, and sharing
5. Session management and API keys
6. PIN setup, lock, unlock, and locked-folder browsing
7. Shared links, including password-protected links and archive download
8. Search and filter pages that remain enabled
9. Admin settings pages that remain visible
10. Realtime asset and session updates

Before describing a release as mobile compatible, test with an upstream v2.5.2 mobile client:

1. Server discovery, login, and token refresh behavior
2. Initial full sync
3. Incremental sync after create, update, relationship removal, and hard delete
4. Upload retry and duplicate handling
5. Partner and shared-album backfills
6. Album, stack, memory, favorite, archive, trash, and locked visibility changes
7. Live Photos and sidecars
8. Thumbnail and video playback behavior
9. Session revocation and realtime refresh

## Change Checklist

For every client-visible backend change:

1. Locate the matching Immich v2.5.2 controller and DTO.
2. Locate the SDK method and web caller.
3. Check whether mobile sync or realtime also represents the entity.
4. Preserve status codes and response mapping.
5. Test valid, invalid, unauthorized, and cross-user cases.
6. Test D1-specific limits for bulk operations.
7. Run the full Worker and Socket.IO suites.
8. Run the web build when response types or UI behavior change.
9. Update `FEATURE_STATUS.md` if support or limitations changed.

## Version Policy

Do not mix behavior from newer Immich releases into the v2.5.2 contract without an explicit version upgrade. Upgrade work should update the server version, SDK version, route and DTO comparisons, sync protocol expectations, tests, and this document together.

The clean port to Immich v3.2.2 is defined in `V3_MIGRATION_PLAN.md`. The v2.5.2 baseline remains authoritative until that port is complete.

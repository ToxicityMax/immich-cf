# Compatibility

## Baseline

WorkersImmich targets the Immich v3.2.2 API and client model. The web application and `@immich/sdk` are based on the exact v3.2.2 release. Mobile source is not included in this repository.

This project is not a drop-in replacement for a complete upstream Immich v3.2.2 server. The enabled Worker surface has been ported to v3, including discovery, configuration visibility, API-key rotation, core image upload, v3 asset responses, album ownership, password-protected shared links, bounded sync and backfills, deletion audits, and core V2 realtime events. Unsupported API families and inherited Worker product limitations remain intentionally unavailable or partial. See `FEATURE_STATUS.md` and `V3_MIGRATION_FINDINGS.md`.

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
| API keys | Integration tested | CRUD response shape, permission delegation, rotation, old-secret invalidation, validation, and current-key lookup are covered in `server/test/api-keys.test.ts`. |
| Configuration visibility | Integration tested | Public, user, admin, and legacy admin projections, permission checks, update validation, secret isolation, and disabled unsupported branches are covered in `server/test/system-config.test.ts`. |
| PIN and locked assets | Integration tested | PIN lifecycle, elevation, albums, links, search, stacks, folder paths, and indirect live-photo access are covered. |
| Users and preferences | Integration tested | Core self-service, admin operations, and the required `clusterGroupId` response field are covered in `server/test/users.test.ts`. People/cluster-group APIs remain unavailable. |
| Basic image assets | Integration tested | Upload, duplicate detection, metadata update, statistics, original download, and soft delete are covered. Derivatives and non-image formats remain limited. |
| Timeline smoke path | Integration tested | A real Worker test uploads an image, reads its month bucket and v3 columnar bucket response, and downloads thumbnail fallback and original bytes in `server/test/timeline.test.ts`. |
| Albums | Integration tested | Core CRUD, owner-role membership, v3 ownership/shared filtering, and asset membership are covered. Collaboration edge cases are not comprehensive. |
| Organization APIs | Integration tested for repaired contracts | Tags, memories, stacks, partner creation, validation, response mapping, fresh-schema IDs, and stack-primary repair are covered in `server/test/organization.test.ts`. Timeline collapsing and scheduled memory generation remain incomplete. |
| Realtime | Integration tested for core events | Authentication, Engine.IO handshake, asset lifecycle targeting, and session revocation are covered. All upstream event families are not covered. |
| Notifications | Partial | The authenticated v3 inbox query is integration-tested and returns an empty list. Producers, persistence, updates, deletion, and email delivery are unavailable. |
| Web SPA | Partial | The upstream UI is largely preserved, but it still exposes some features that the Worker does not fully support. |
| Mobile sync | Partial | Streaming, partner/shared-album composite backfills, locked isolation, and representative deletion convergence are integration-tested. People/faces remain unavailable, mutation coverage is not exhaustive, and no upstream mobile client runs in CI. |
| Media processing | Partial | Original files work. Video transcoding, video thumbnails, RAW previews, and dependable image derivatives are not complete. |
| Full upstream API | Incomplete | OAuth, full notifications, libraries, jobs, backups, maintenance, plugins, ML, and map APIs are absent or intentionally disabled. |

## Automated Verification

The current active server verification is:

```sh
cd server
npm run test:all
npx wrangler deploy --dry-run
```

At the time this document was written, the suite contained 125 top-level API tests and 4 Socket.IO tests. Test counts will change as coverage grows.

The automated suite exercises every core smoke flow at the Worker protocol level. Web tests run in Happy DOM with mocked SDK calls, not a real browser, and no browser E2E runner is configured. The repository also has no mobile source, emulator, or upstream client binary, so mobile interoperability remains external validation.

## External Client Checks

The API side of these flows is automated, but before describing a release as browser compatible, exercise them through the v3.2.2 web build in a real browser:

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

Before describing a release as mobile compatible, test with an upstream v3.2.2 mobile client. This cannot be completed inside the current repository:

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

1. Locate the matching Immich v3.2.2 controller and DTO.
2. Locate the SDK method and web caller.
3. Check whether mobile sync or realtime also represents the entity.
4. Preserve status codes and response mapping.
5. Test valid, invalid, unauthorized, and cross-user cases.
6. Test D1-specific limits for bulk operations.
7. Run the full Worker and Socket.IO suites.
8. Run the web build when response types or UI behavior change.
9. Update `FEATURE_STATUS.md` if support or limitations changed.

## Version Policy

Do not mix behavior from newer Immich releases into the v3.2.2 contract without an explicit version upgrade. Upgrade work should update the server version, SDK version, route and DTO comparisons, sync protocol expectations, tests, and this document together.

The implemented v3.2.2 port is recorded in `V3_MIGRATION_PLAN.md`; validated contract research is recorded in `V3_MIGRATION_FINDINGS.md`, and current deferred work is tracked in `FEATURE_STATUS.md`.

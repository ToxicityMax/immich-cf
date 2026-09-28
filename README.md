# Immich on Cloudflare Workers

> **This is an experiment and is not meant for actual use.** It is a proof-of-concept exploring whether a complex photo management platform can run on Cloudflare's serverless edge infrastructure. Expect missing features, rough edges, and breaking changes.

This project is a fork of [Immich](https://github.com/immich-app/immich) that replaces the traditional Node.js/PostgreSQL backend with a serverless stack built on Cloudflare Workers. The original SvelteKit web frontend is preserved largely intact.

## Architecture

| Component | Original Immich | This Fork |
|-----------|----------------|-----------|
| Backend framework | NestJS | Hono |
| Database | PostgreSQL | Cloudflare D1 (SQLite) |
| Object storage | Local filesystem / S3 | Cloudflare R2 |
| Cache | Redis | Cloudflare KV |
| Realtime | Socket.IO + Redis | Durable Objects + Socket.IO wire protocol |
| Runtime | Node.js | Cloudflare Workers |

## What works

- Password, API-key, session, and PIN authentication
- Basic JPEG upload, duplicate detection, metadata updates, and original download
- Core album and user management
- Locked-folder access controls
- Authenticated realtime asset and session updates
- Basic shared links, timeline, memories, tags, activities, stacks, and sync routes

Several items in the last line are partial and are not yet drop-in compatible with every upstream web or mobile workflow. Media derivatives, video, mobile sync convergence, large archive streaming, background processing, and parts of the preserved admin UI still need work.

## What was intentionally removed

- ML features (facial recognition, smart search, CLIP, OCR)
- Video transcoding
- Background job processing
- OAuth
- Email notifications
- Telemetry

## Project structure

```
server/          Cloudflare Workers backend (Hono)
  src/
    controllers/ Retained upstream/reference controllers (not active Worker handlers)
    services/    Business logic
    repositories/ Data access layer
    routes/      Hono route definitions
    middleware/  Auth, error handling
    dtos/        Request/response validation
    schema/      Database table types (Kysely)
  migrations/    D1 SQL migrations
  wrangler.toml  Workers configuration

web/             SvelteKit frontend (SPA)
  src/
    routes/      Page routes
    lib/         Components, stores, utilities

i18n/            Internationalization (80+ languages)
docs/            Compatibility, feature status, and roadmap
```

## Documentation

- [Compatibility policy and test expectations](docs/COMPATIBILITY.md)
- [Feature status and remaining roadmap](docs/FEATURE_STATUS.md)
- [Contributor and coding-agent guidance](AGENTS.md)
- [Original conversion plan](docs/IMPLEMENTATION_PLAN.md), retained as historical context
- [Technology conversion analysis](docs/TECH_CONVERSIONS.md), retained as historical context

## Development

### Server

```sh
cd server
npm install
npm run dev    # starts wrangler dev on 0.0.0.0:8787
npm run test:all
```

### Web

```sh
cd web
npm install
npm run dev    # starts vite dev on 0.0.0.0:3000
```

## Deployment

The server is deployed to Cloudflare Workers via `wrangler deploy`. The web frontend is built as a static SPA and served through the Workers assets binding. Required Cloudflare resources:

- **D1 database** for structured data
- **R2 bucket** (`immich`) for photo/video storage
- **KV namespace** for caching
- **Durable Object namespace** for authenticated WebSocket connections and event delivery

## License

GNU Affero General Public License v3 (inherited from upstream Immich).

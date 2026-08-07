# Architecture

## Recommended Runtime

New deployments should use two runtime pieces:

1. static frontend generated from this repository
2. one NestJS backend that provides the routes you enable

That is the intended public architecture.
If you deploy with Docker, the bundled nginx image is only a static file host for the built frontend assets. It is not a separate product-layer service with its own business logic.

## Frontend Responsibilities

- upload and text-paste UX
- auth session state
- history and preview UI
- local encryption and decryption
- ShareX config generation

## Backend Responsibilities

- upload, delete, list, and metadata APIs
- optional auth routes
- optional passkey routes
- token resolution route for clean public links
- optional token-owner lookup

## Public Link Model

User-facing links are path-based:

- `/file/<token>/preview`
- `/file/<token>/raw`
- `/file/<token>/download`
- `/<id>/file`
- `/<id>/file.<ext>`

The frontend keeps share links on the public origin. The backend remains responsible for serving the actual file bytes.

## Legacy Compatibility Resolver

`resolver-server/` exists for deployments that have not moved token resolution into the NestJS backend. Treat it as a migration aid, not the preferred architecture for new installs.

## What Is Optional vs Required

Required:
- frontend static assets from this repository
- the NestJS API in `backend/nestjs`, with SQLite auth state and filesystem uploads

Optional:
- `/auth/*` routes for account mode
- `/auth/passkeys/*` routes for passkeys
- `/token-owner` for token-owner hydration before upload
- native resolver route such as `/api/resolve/*` for extension-free public token links

Compatibility-only:
- `resolver-server/`

Not part of the intended architecture:
- extra app servers beyond the frontend static host and NestJS backend
- undocumented sidecar services required just to make the default install function

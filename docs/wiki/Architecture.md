# Architecture

## Runtime components

yaemipaste has two runtime components:

1. The Vue frontend, built as static files.
2. The native NestJS backend in `backend/nestjs`.

The bundled Nginx container serves the frontend and applies SPA fallback. It
also proxies backend requests. The NestJS service contains the application
logic.

## Data stores

The backend uses two persistent stores:

- SQLite at `DB_PATH` for users, password hashes, upload tokens, sessions,
  passkeys, administrator settings, registration and claim tokens, webhooks,
  and audit records
- The directory at `SERVER__UPLOAD_PATH` for file bytes and file metadata

Use persistent volumes for both stores. Back up both stores together. Replacing
the backend container must not replace either volume.

## Responsibilities

The frontend provides upload and text-paste workflows, account screens,
history, previews, browser-side encryption, ShareX settings, and the admin UI.

The NestJS backend provides:

- Multipart and remote uploads when enabled
- File listing, metadata, deletion, expiry cleanup, and public file delivery
- Registration, login, JWT sessions, upload tokens, password changes, and
  optional passkeys
- Authenticated ShareX settings at `/auth/sharex`
- Administrator claims, users, uploads, settings, webhooks, and audit events

## Routes

Browser pages use paths, not query-string tabs:

- `/files`
- `/history`
- `/login`
- `/register`
- `/admin`
- `/file/<token>/preview` and `/file/<token>/download`
- `/file/<token>/raw` (a direct file response for embeds and media clients)

On the same host, the frontend proxies `/api/*` to the backend root and
`/auth/*` to backend auth routes. Public file links use `/<id>/file` or
`/<id>/file.<ext>`. Normal navigation stays in the preview UI. Explicit raw
and download requests go to the backend.

## Migration-only resolver

`resolver-server/` is an optional compatibility service for migrations that
need older token resolution. It is disabled by default. New deployments should
use the native backend and bundled UI without enabling this service.

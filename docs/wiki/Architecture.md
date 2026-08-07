# Architecture

## Native Runtime

yaemipaste has two runtime components:

1. The Vue frontend, built as static assets.
2. The native NestJS backend in `backend/nestjs`.

The bundled Nginx container serves the frontend, applies SPA fallback, and
proxies backend requests. Business logic remains in the NestJS service.

## Data Model

The backend uses two persistent stores:

- SQLite at `DB_PATH` for users, password hashes, upload tokens, sessions,
  passkeys, admin settings, registration and claim tokens, webhooks, and audit
  records.
- The directory at `SERVER__UPLOAD_PATH` for uploaded bytes and file metadata.

Both paths must use persistent volumes and must be backed up together. Moving
or replacing the backend container must not replace these volumes.

## Responsibilities

The frontend provides upload and text-paste workflows, account screens,
history, previews, browser-side encryption, ShareX settings, and the admin UI.

The NestJS backend provides:

- multipart uploads, remote uploads when enabled, listing, metadata, deletion,
  expiry cleanup, and public file delivery
- registration, login, JWT sessions, upload tokens, password changes, and
  optional passkeys
- authenticated ShareX configuration at `/auth/sharex`
- administrator claims, users, uploads, settings, webhooks, and audit events

## Route Model

Browser pages are paths, not query-selected tabs:

- `/files`
- `/history`
- `/login`
- `/register`
- `/admin`
- `/file/<token>/preview`, `/file/<token>/raw`, and
  `/file/<token>/download`

The same-host frontend proxies `/api/*` to the backend root and `/auth/*` to
backend auth routes. Public stored-file paths use `/<id>/file` or
`/<id>/file.<ext>`; the bundled proxy keeps normal navigation in the preview
UI and sends explicit raw or download requests to the backend.

## Migration-Only Resolver

`resolver-server/` is an optional compatibility service for migrations that
still require older token-resolution behavior. It is disabled by default and
is not part of the native NestJS architecture. New deployments should use the
backend and bundled UI route contract without enabling it.

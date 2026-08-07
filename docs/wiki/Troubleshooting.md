# Troubleshooting

## Every Page Returns 404

`/files`, `/history`, `/login`, `/register`, `/admin`, and `/file/*` are SPA
routes. The public hostname must reach the bundled UI service or a static host
with fallback to `index.html`. Do not route unknown paths directly to the
NestJS API.

If the origin works but the public hostname fails, check DNS `A` and `AAAA`
records, tunnel ingress, CDN origin rules, workers, and cached HTML or 404s.
Compare the origin and edge as shown in `docs/deployment/caddy.md`.

## Uploads Fail

Check `VITE_PASTE_API`, `/api/*` proxying, upload-size limits at every proxy,
`SERVER__UPLOAD_PATH` permissions, available disk space, and the configured
upload policy. ShareX must send multipart field `file` and the account upload
token in the `Authorization` header.

## Login, ShareX, Or Admin Actions Fail

Check that `/auth/*` reaches the NestJS backend without stripping `/auth`.
Verify `DB_PATH` is persistent and writable, `JWT_SECRET` and
`AUTH_ADMIN_BEARER` meet production requirements, and the account is not
suspended. `/auth/sharex` requires a signed-in account and ShareX support to be
enabled; `/auth/admin/*` management routes require administrator authorization.

## History Shows The Stored Name

History display names come from filesystem metadata beside the upload. Confirm
the upload volume and metadata sidecars were migrated together. Do not cache
`/api/meta/*`; stale edge metadata can hide a backend fix even when the origin
returns the correct value.

## Public Preview Or Download Fails

Check the UI handling for `/file/<token>/preview`, `/file/<token>/raw`, and
`/file/<token>/download`, plus proxy handling for `/<id>/file` and
`/<id>/file.<ext>`. Explicit raw/download requests must reach the backend while
normal public-link navigation remains in the SPA.

The service in `resolver-server/` is only for migrations that explicitly need
older resolution behavior. It is not required by the native backend.

## Passkeys Fail

Check HTTPS, `PASSKEYS_ENABLED=1`, RP ID and origin values, and the configured
allowed origins. Direct HTTP IP deployments do not provide the secure browser
context passkeys require.

## Tests Will Not Start

The Playwright suite starts a local Vite server by default. If the environment
blocks local listeners, provide a reachable `PLAYWRIGHT_BASE_URL`. Run API
checks with `npm run api:build && npm run api:test`, frontend end-to-end checks
with `npm run test:e2e:preview`, or the complete release check with
`npm run validate:release`.

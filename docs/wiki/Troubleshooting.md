# Troubleshooting

## Every page returns 404

`/files`, `/history`, `/login`, `/register`, `/admin`, and `/file/*` are SPA
routes. Send the public hostname to the bundled UI service, or serve the
static files with a fallback to `index.html`. Do not send unknown paths to the
NestJS API.

If the origin works but the public hostname fails, check DNS `A` and `AAAA`
records, tunnel ingress, CDN origin rules, workers, and cached HTML or 404
responses. Compare the origin and edge as described in
`docs/deployment/caddy.md`.

## Uploads fail

Check `VITE_PASTE_API`, `/api/*` proxying, upload-size limits at every proxy,
`SERVER__UPLOAD_PATH` permissions, disk space, and the upload policy. ShareX
must send the multipart field `file` and the account upload token in the
`Authorization` header.

## Login, ShareX, or administrator actions fail

Check that `/auth/*` reaches the NestJS backend without removing `/auth`.
Check that `DB_PATH` is persistent and writable. Check that `JWT_SECRET` and
`AUTH_ADMIN_BEARER` meet the production requirements. Check that the account
is not suspended.

`/auth/sharex` requires a signed-in account and enabled ShareX support.
`/auth/admin/*` requires administrator authorization.

## History shows the stored name

History display names come from metadata beside each upload. Migrate the
upload volume and metadata sidecars together. Do not cache `/api/meta/*`.
Stale edge metadata can hide a backend fix.

## Public preview or download fails

Check UI handling for `/file/<token>/preview`, `/file/<token>/raw`, and
`/file/<token>/download`. Also check proxy handling for `/<id>/file` and
`/<id>/file.<ext>`.

Explicit raw and download requests must reach the backend. Normal public-link
navigation must stay in the SPA.

`resolver-server/` is for migrations that need older resolution behavior. It
is not required by the native backend.

## Passkeys fail

Enable passkeys in Admin > Settings. `PASSKEYS_ENABLED=1` sets the initial
value for a new database. The administrator can change the setting later.

Check HTTPS, the RP ID, origin values, and the allowed origins. Direct HTTP IP
deployments do not provide the secure browser context required by passkeys.

## Tests do not start

The Playwright suite starts a local Vite server by default. If the environment
blocks local listeners, set a reachable `PLAYWRIGHT_BASE_URL`.

Run API checks with `npm run api:build && npm run api:test`. Run frontend tests
with `npm run test:e2e:preview`. Run the complete release check with
`npm run validate:release`.

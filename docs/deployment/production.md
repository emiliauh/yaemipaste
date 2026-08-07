# Production Deployment

## Preflight

Use HTTPS and a dedicated public UI origin for internet-facing deployments,
with loopback-bound Compose ports, unique `JWT_SECRET` and
`AUTH_ADMIN_BEARER` values, and encrypted backups. Do not commit `.env` or
generated ShareX configuration. Direct IP access is supported for LAN or
simple deployments by setting `PASTE_URL=http://<ip>:8080` and
`UI_BIND_ADDRESS=0.0.0.0`; it does not provide TLS or browser passkey support.

## Same Host

Set `PASTE_URL=https://paste.example.com`, `PASTE_PUBLIC_API=https://paste.example.com/api`,
and retain `/api`, `/auth`, `/api/resolve`, and `/api/token-owner` frontend
routes. Point Caddy or Nginx at `127.0.0.1:8080`; the bundled UI proxy routes
traffic to the native NestJS backend in `backend/nestjs`. Persist both
`DB_PATH` (SQLite auth and admin state) and `SERVER__UPLOAD_PATH` (uploaded
bytes and metadata).

## Split Host

UI: `https://paste.example.com`. API: `https://api.example.com`.

```dotenv
DEPLOYMENT_MODE=split
PASTE_URL=https://paste.example.com
PASTE_PUBLIC_API=https://api.example.com
VITE_PASTE_API=https://api.example.com
VITE_AUTH_API=https://api.example.com/auth
VITE_FILE_RESOLVE_BASE=https://api.example.com/resolve
VITE_TOKEN_OWNER_PATH=https://api.example.com/token-owner
VITE_PUBLIC_SITE_ORIGIN=https://paste.example.com
CORS_ALLOWED_ORIGINS=https://paste.example.com
CSP_CONNECT_SRC=https://api.example.com
```

On the **UI host**, set `SPLIT_ROLE=ui`, `COMPOSE_PROFILES=ui`, and
`API_UPSTREAM=https://api.example.com`. On the **API host**, set
`SPLIT_ROLE=api` and `COMPOSE_PROFILES=api`. Both hosts need the same
`PASTE_URL`, `PASTE_PUBLIC_API`, `JWT_SECRET`, and `AUTH_ADMIN_BEARER`; only
the API host needs the persistent upload/auth volumes. The UI host does not
start a local NestJS backend.

Keep public file links on `PASTE_URL`. The UI host must proxy public raw paths
(`/<id>/file` and `/<id>/file.ext`) to the API host for `raw`/`download`
requests; preview navigation stays on the UI SPA.

## Route Contract

- `/api/*`: backend root with `/api` stripped.
- `/auth/*`: backend auth routes.
- `/api/resolve/*`: native backend public-link resolution routes.
- `/api/token-owner`: backend token-owner route.
- `/file/<token>/*`: SPA preview/raw/download routes.
- `/<id>/file[.ext]?raw=1|download=true`: backend file bytes.

## Verification

1. Validate Compose and proxy syntax.
2. Check `/`, `/api/`, and `/auth/admin/public-settings`.
3. Upload text and an image; verify history, preview, raw, download, and deletion.
4. Claim/login as administrator and verify server-side authorization.
5. Test ShareX, Turnstile, and passkeys when enabled.
6. Restore a backup to an isolated environment periodically.

Do not cache HTML, `/api/*`, `/auth/*`, metadata, or 404 responses. Cache only
fingerprinted frontend assets. Verify the origin and public edge separately
after any proxy, tunnel, or CDN change.

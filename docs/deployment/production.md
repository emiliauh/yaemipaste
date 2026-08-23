# Production deployment

## Preflight

Use HTTPS and a dedicated public UI origin for an internet-facing deployment.
Bind Compose ports to loopback. Use unique `JWT_SECRET` and
`AUTH_ADMIN_BEARER` values. Encrypt backups. Do not commit `.env` or generated
ShareX settings.

Direct IP access works for LAN or simple deployments with
`PASTE_URL=http://<ip>:8080` and `UI_BIND_ADDRESS=0.0.0.0`. It does not provide
TLS or the secure browser context required by passkeys.

## Same host

Set:

```dotenv
PASTE_URL=https://paste.example.com
PASTE_PUBLIC_API=https://paste.example.com/api
```

Keep the `/api`, `/auth`, `/api/resolve`, and `/api/token-owner` frontend
routes. Point Caddy or Nginx to `127.0.0.1:8080`. The bundled UI proxy sends
backend requests to the native NestJS service in `backend/nestjs`.

Persist both `DB_PATH` and `SERVER__UPLOAD_PATH`. The first stores SQLite auth
and administrator data. The second stores uploaded bytes and metadata.

## Split host

Use `https://paste.example.com` for the UI and `https://api.example.com` for
the API:

```dotenv
DEPLOYMENT_MODE=split
PASTE_URL=https://paste.example.com
PASTE_PUBLIC_API=https://api.example.com
VITE_PASTE_API=https://api.example.com
VITE_AUTH_API=https://api.example.com/auth
VITE_FILE_RESOLVE_BASE=https://api.example.com/resolve
VITE_PUBLIC_SITE_ORIGIN=https://paste.example.com
CORS_ALLOWED_ORIGINS=https://paste.example.com
CSP_CONNECT_SRC=https://api.example.com
```

On the UI host, set `SPLIT_ROLE=ui`, `COMPOSE_PROFILES=ui`, and
`API_UPSTREAM=https://api.example.com`. On the API host, set `SPLIT_ROLE=api`
and `COMPOSE_PROFILES=api`.

Both hosts need the same `PASTE_URL`, `PASTE_PUBLIC_API`, `JWT_SECRET`, and
`AUTH_ADMIN_BEARER`. Only the API host needs the persistent upload and auth
volumes. The UI host does not run a local NestJS backend.

Keep public file links on `PASTE_URL`. The UI host must proxy public raw paths
(`/<id>/file` and `/<id>/file.ext`) to the API host for `raw` and `download`
requests. Preview navigation stays in the UI SPA.

## Route contract

- `/api/*`: backend root, with `/api` removed
- `/auth/*`: backend auth routes
- `/api/resolve/*`: native backend public-link resolution routes
- `/api/token-owner`: backend token-owner route
- `/file/<token>/preview` and `/file/<token>/download`: SPA routes
- `/file/<token>/raw`: direct backend file bytes (including media embeds)
- `/<id>/file[.ext]?raw=1|download=true`: legacy backend file bytes

## Verification

1. Validate Compose and proxy syntax.
2. Check `/`, `/api/`, and `/auth/admin/public-settings`.
3. Upload text and an image. Check history, preview, raw, download, and
   delete behavior.
4. Claim an administrator account and check server-side authorization.
5. Test ShareX, Turnstile, and passkeys when enabled.
6. Restore a backup in an isolated environment at regular intervals.

Do not cache HTML, `/api/*`, `/auth/*`, metadata, or 404 responses. Cache only
fingerprinted frontend assets. Check the origin and public edge separately
after a proxy, tunnel, or CDN change.

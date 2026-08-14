# Environment reference

This file lists the variables in `.env.example`. It explains how each variable
affects the Vue frontend and NestJS backend.

## Quick Start

```bash
cp .env.example .env
```

Edit only the values required by your deployment.

Same-host deployment starts both Compose profiles:

```bash
COMPOSE_PROFILES=ui,api docker compose pull
COMPOSE_PROFILES=ui,api docker compose up -d
```

The standard same-host setup pulls prebuilt UI and API images. Use
`DEPLOYMENT_IMAGE_MODE=build` when you change compile-time `VITE_*` UI settings
or use a split deployment.

The API service is the backend in `backend/nestjs`. It stores auth and
administrator state in SQLite at `DB_PATH`. It stores upload bytes and
metadata under `SERVER__UPLOAD_PATH`.

## Core Frontend Variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `VITE_PASTE_API` | File API base used by the frontend; requires a local UI build when changed | `/api` |
| `VITE_AUTH_API` | Auth API base used by the frontend | `/auth` |
| `VITE_PUBLIC_SITE_ORIGIN` | Explicit public site origin for generated links | empty |
| `VITE_HISTORY_WS` | Optional history websocket override | empty |
| `VITE_FILE_RESOLVE_BASE` | Native API resolution base used by public file links | `/api/resolve` |
| `VITE_ENABLE_SHAREX` | Enable ShareX settings UI and `/auth/sharex` config generation | `1` |
| `VITE_ENABLE_AUTH` | Enable login/register/account UI | `1` |
| `VITE_PUBLIC_META_CACHE_BUST` | Add a query cache key to public metadata requests in production UI builds | `1` for deployed images, `0` for local test builds |
| `VITE_REPOSITORY_URL` | Footer repository link | `https://github.com/emiliauh/yaemipaste` |
| `VITE_MAX_EXPIRY_DAYS` | Max expiry day option shown in UI | `14` |

## Backend Variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `PASTE_URL` | Required public UI origin used for file links | empty |
| `DB_PATH` | Auth DB path inside the backend container | `/var/lib/yaemipaste-auth/users.db` |
| `JWT_SECRET` | Required session-signing secret; production requires `openssl rand -hex 32` format (64 lowercase hex characters) | empty |
| `TURNSTILE_SECRET_KEY` | Server-side Turnstile secret. If set without a matching `VITE_TURNSTILE_SITE_KEY`, the login page shows an explicit "Security check is misconfigured on the server" message rather than blocking silently. Keep both empty to disable Turnstile, or set both together. | empty |
| `VITE_TURNSTILE_SITE_KEY` | Login Turnstile site key. The `VITE_` prefix remains for environment-file compatibility, but the **backend** reads this value at runtime. The UI gets the current value from `/auth/admin/public-settings` on each page load. Change it in `.env`, then run `docker compose up -d`; no rebuild is needed. | empty |
| `PASTE_PUBLIC_API` | Public API upload URL written into ShareX configs | empty |
| `ALLOW_ANONYMOUS_UPLOADS` | Allow uploads without an account or token | `0` for new installs |
| `REMOTE_UPLOADS_ENABLED` | Allow backend URL-fetch uploads | `0` for new installs |
| `PASSKEYS_ENABLED` | Initial value for the administrator-controlled passkey setting; Admin > Settings can change it at runtime without a rebuild | `0` |
| `PASSKEY_RP_NAME` | Passkey display name | `yaemipaste` |
| `PASSKEY_RP_ID` | Passkey RP ID override | empty |
| `PASSKEY_ORIGINS` | Allowed passkey origins CSV | empty |
| `PASSKEY_ALLOW_ANY_PORT` | Relaxed local passkey port matching | `0` |
| `PASSKEY_ALLOW_SUBDOMAINS` | Relaxed passkey subdomain matching | `0` |

## Host / Compose Variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `DEPLOYMENT_MODE` | `same` or `split` topology marker | `same` |
| `SPLIT_ROLE` | `ui` or `api` on split hosts | empty |
| `COMPOSE_PROFILES` | Services started by Compose | `ui,api` |
| `DEPLOYMENT_IMAGE_MODE` | `pull` prebuilt images, or `build` from local source | `pull` |
| `YAEMIPASTE_IMAGE_TAG` | UI/API image tag; the installer defaults to the branch tag, while production should use a SHA tag | `nestjs-rewrite` |
| `YAEMIPASTE_UI_IMAGE` | UI image repository or mirror | `ghcr.io/emiliauh/yaemipaste-ui` |
| `YAEMIPASTE_API_IMAGE` | API image repository or mirror | `ghcr.io/emiliauh/yaemipaste-api` |
| `UI_BIND_ADDRESS` | UI host bind address | `127.0.0.1` |
| `UI_PORT` | Host port for the static frontend container | `8080` |
| `API_PUBLISH_BIND` | API host bind address | `127.0.0.1` |
| `API_PUBLISH_PORT` | API host port for a split reverse proxy | `8000` |
| `CORS_ALLOWED_ORIGINS` | Exact CSV UI origins permitted by a split API | empty |
| `CSP_CONNECT_SRC` | Extra exact browser connection origins; `self` is automatic | empty |
| `CSP_TURNSTILE_SRC` | Turnstile CSP origin when enabled | empty |
| `API_UPSTREAM` | UI container API/raw upstream | `http://paste-api:8000` |
| `MAX_CONCURRENT_UPLOADS_PER_CLIENT` | Maximum in-flight multipart uploads per trusted client IP | `4` |
| `MAX_UPLOAD_DIR_SIZE` | Total upload-directory quota; use `0` only with an external quota | `10GiB` |
| `RESOLVER_ENABLED` | Enable the optional migration-only compatibility resolver | `0` |
| `RESOLVER_PORT` | Migration resolver loopback port | `3101` |
| `RESOLVER_PUBLIC_ORIGIN` | Public origin used by migration resolver redirects | `http://localhost:8080` |
| `RESOLVER_CACHE_TTL_MS` | Migration resolver cache TTL | `30000` |

## Installer / Admin Variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `AUTH_ADMIN_BASE_URL` | Base URL for installer admin calls | `http://localhost:8080/auth/admin` |
| `AUTH_BOOTSTRAP_PATH` | First-user bootstrap path | `/bootstrap` |
| `AUTH_TOKEN_CREATE_PATH` | Token creation path | `/tokens` |
| `AUTH_TOKEN_REVOKE_PATH` | Token revoke path template | `/tokens/%s` |
| `AUTH_ADMIN_CLAIM_INIT_PATH` | One-time admin claim token initialization path | `/claim/init` |
| `AUTH_REGISTER_URL` | Public register endpoint used when token-based registration is chosen | `http://localhost:8080/auth/register` |
| `AUTH_ADMIN_BEARER` | Admin bearer used by installer lifecycle commands; production requires `openssl rand -hex 32` format (64 lowercase hex characters) | empty |

## Recommended Public Configuration

For a new deployment, use these values:
- keep `VITE_PASTE_API=/api`
- keep `VITE_AUTH_API=/auth`
- use `VITE_FILE_RESOLVE_BASE=/api/resolve`
- keep `RESOLVER_ENABLED=0`
- keep `PASTE_URL` aligned with the frontend origin
- set `JWT_SECRET` and `AUTH_ADMIN_BEARER` with `openssl rand -hex 32`
- set upload policy flags before upgrading an existing deployment

## Migration-Only Resolver

`resolver-server/` is not part of the default backend. Enable it only while
migrating an installation that needs its older token-resolution behavior. New
installations and completed NestJS migrations must keep `RESOLVER_ENABLED=0`.

If you enable it:
- set `RESOLVER_ENABLED=1`
- set `VITE_FILE_RESOLVE_BASE=/resolve`
- proxy `/resolve/*` to the Node resolver

## Backend Contract

The native NestJS backend provides upload, list, delete, metadata, token-owner,
public file, `/auth/*`, ShareX, and admin routes. Passkey routes are available
when passkeys are enabled. Browser pages use SPA paths such as `/files`,
`/history`, `/login`, `/register`, and `/admin`.

## Validation Checklist

After changing environment values or deployment routing, check:
- frontend build succeeds
- upload works
- history list loads
- a public preview link opens
- raw/download links resolve correctly
- auth, passkeys, and token lifecycle commands when those features are enabled
- ShareX configuration downloads and performs a multipart upload
- SQLite and upload filesystem paths remain mounted after replacing a container

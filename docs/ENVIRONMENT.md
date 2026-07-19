# Environment Reference

This file explains the variables in `.env.example` and how they affect deployment.

## Quick Start

```bash
cp .env.example .env
```

Then edit only what your deployment needs.

Same-host deployment starts both Compose profiles:

```bash
COMPOSE_PROFILES=ui,api docker compose up --build -d
```

Legacy compatibility resolver:

```bash
docker compose --profile with-resolver up --build -d
```

## Core Frontend Variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `VITE_PASTE_API` | File API base used by the frontend | `/api` |
| `VITE_AUTH_API` | Auth API base used by the frontend | `/auth` |
| `VITE_PUBLIC_SITE_ORIGIN` | Explicit public site origin for generated links | empty |
| `VITE_HISTORY_WS` | Optional history websocket override | empty |
| `VITE_FILE_RESOLVE_BASE` | Resolver path for `/file/<token>/...` links | `/api/resolve` |
| `VITE_TOKEN_OWNER_PATH` | Optional token-owner lookup path | `/api/token-owner` |
| `VITE_ENABLE_SHAREX` | Enable ShareX settings UI and `/auth/sharex` config generation | `1` |
| `VITE_ENABLE_AUTH` | Enable login/register/account UI | `1` |
| `VITE_REPOSITORY_URL` | Footer repository link | `https://github.com/emiliauh/yaemipaste` |
| `VITE_MAX_EXPIRY_DAYS` | Max expiry day option shown in UI | `14` |

## Backend Variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `PASTE_URL` | Required public UI origin used for file links | empty |
| `DB_PATH` | Auth DB path inside the backend container | `/var/lib/rustypaste-auth/users.db` |
| `JWT_SECRET` | Required random session-signing secret | empty |
| `TURNSTILE_SECRET_KEY` | Server-side Turnstile secret. If set without a matching `VITE_TURNSTILE_SITE_KEY`, the login page shows an explicit "Security check is misconfigured on the server" message rather than blocking silently. Keep both empty to disable Turnstile, or set both together. | empty |
| `VITE_TURNSTILE_SITE_KEY` | Login Turnstile site key. Despite the `VITE_` prefix (kept for `.env` naming continuity), this is read by the **backend** at runtime, not baked into the frontend build - the UI fetches the live value from `/auth/admin/public-settings` on every page load. Change it via `.env` + `docker compose up -d`; no rebuild needed. | empty |
| `PASTE_PUBLIC_API` | Public API upload URL written into ShareX configs | empty |
| `PASSKEYS_ENABLED` | Enable backend passkey routes | `0` |
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
| `UI_BIND_ADDRESS` | UI host bind address | `127.0.0.1` |
| `UI_PORT` | Host port for the static frontend container | `8080` |
| `API_PUBLISH_BIND` | API host bind address | `127.0.0.1` |
| `API_PUBLISH_PORT` | API host port for a split reverse proxy | `8000` |
| `CORS_ALLOWED_ORIGINS` | Exact CSV UI origins permitted by a split API | empty |
| `CSP_CONNECT_SRC` | Extra exact browser connection origins; `self` is automatic | empty |
| `CSP_TURNSTILE_SRC` | Turnstile CSP origin when enabled | empty |
| `API_UPSTREAM` | UI container API/raw upstream | `http://paste-api:8000` |
| `RESOLVER_ENABLED` | Enable legacy Node resolver workflow in installer | `0` |
| `RESOLVER_PORT` | Legacy resolver loopback port | `3101` |
| `RESOLVER_PUBLIC_ORIGIN` | Public site origin used by legacy resolver redirects | `http://localhost:8080` |
| `RESOLVER_CACHE_TTL_MS` | Legacy resolver cache TTL | `30000` |

## Installer / Admin Variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `AUTH_ADMIN_BASE_URL` | Base URL for installer admin calls | `http://localhost:8080/auth/admin` |
| `AUTH_BOOTSTRAP_PATH` | First-user bootstrap path | `/bootstrap` |
| `AUTH_TOKEN_CREATE_PATH` | Token creation path | `/tokens` |
| `AUTH_TOKEN_REVOKE_PATH` | Token revoke path template | `/tokens/%s` |
| `AUTH_ADMIN_CLAIM_INIT_PATH` | One-time admin claim token initialization path | `/claim/init` |
| `AUTH_REGISTER_URL` | Public register endpoint used when token-based registration is chosen | `http://localhost:8080/auth/register` |
| `AUTH_ADMIN_BEARER` | Admin bearer used by installer lifecycle commands | empty |

## Recommended Public Configuration

For a new deployment:
- keep `VITE_PASTE_API=/api`
- keep `VITE_AUTH_API=/auth`
- use `VITE_FILE_RESOLVE_BASE=/api/resolve`
- use `VITE_TOKEN_OWNER_PATH=/api/token-owner`
- keep `RESOLVER_ENABLED=0`
- keep `PASTE_URL` aligned with the frontend origin
- set a strong `JWT_SECRET`

## When To Enable The Legacy Resolver

Only enable the compatibility resolver if:
- your backend does not expose a native resolve endpoint yet
- you still need tokenized preview/raw/download links for existing deployments

If you enable it:
- set `RESOLVER_ENABLED=1`
- set `VITE_FILE_RESOLVE_BASE=/resolve`
- proxy `/resolve/*` to the Node resolver

## Backend Contract

The frontend can run in multiple modes.

Anonymous-only mode:
- `VITE_ENABLE_AUTH=0`
- backend file routes only

Full feature mode:
- upload/list/delete/meta routes
- `/auth/*`
- `/auth/passkeys/*` if passkeys are enabled
- `/resolve/{token}` or equivalent resolver path
- `/token-owner` if token-owner hydration is enabled

## Validation Checklist

After changing env or deployment routing, validate:
- frontend build succeeds
- upload works
- history list loads
- a public preview link opens
- raw/download links resolve correctly
- auth, passkeys, and token lifecycle commands only if those features are enabled

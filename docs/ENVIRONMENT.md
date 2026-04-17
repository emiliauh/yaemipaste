# Environment Reference (`.env`)

This page explains every variable in `.env.example`, what it controls, and when you should change it.

## How to use

1. Copy template:
   ```bash
   cp .env.example .env
   ```
2. Edit only what you need.
3. Start stack:
   ```bash
   docker compose up --build -d
   ```

---

## Variables

| Variable | What it does | When to change it | Safe default |
| --- | --- | --- | --- |
| `VITE_PASTE_API` | Frontend base path for rustypaste API calls. | Change only if you route paste API under a different path/domain. | `/api` |
| `VITE_AUTH_API` | Frontend base path for auth API calls. | Change only if auth is exposed under a different path/domain. | `/auth` |
| `VITE_TURNSTILE_SITE_KEY` | Enables Cloudflare Turnstile challenge in login flow. | Set when you want Turnstile protection; leave empty otherwise. | empty |
| `VITE_MAX_EXPIRY_DAYS` | Max day-based expiry option shown in the UI ("Keep for"). | Set to the maximum retention days your deployment allows. | `14` |
| `PASTE_API_IMAGE` | Docker image for rustypaste backend (includes `/api` and `/auth`). | Pin to a specific version, custom build, or private registry image. | `orhunp/rustypaste:latest` |
| `DB_PATH` | SQLite DB path used by rustypaste integrated auth. | Change only if you want a different in-container auth DB location. | `/var/lib/rustypaste-auth/users.db` |
| `JWT_SECRET` | Session signing secret for `/auth` JWT tokens. | Always set a strong random value in production. | `change-me-in-production` |
| `TURNSTILE_SECRET_KEY` | Server-side Turnstile verification secret. | Set when Turnstile is enabled for login. | empty |
| `PASTE_PUBLIC_API` | Absolute API URL written into generated ShareX files. | Set to your public API URL when not running on localhost. | `http://localhost:8080/api` |
| `PASSKEYS_ENABLED` | Enables Rust WebAuthn passkey endpoints (`/auth/passkeys/*`). | Set `1` only after configuring your passkey RP origins/ID. | `0` |
| `PASSKEY_RP_NAME` | Display name shown by authenticators during passkey enrollment. | Set to your instance/app name. | `yaemipaste` |
| `PASSKEY_RP_ID` | Relying Party ID used for passkey verification. | Set when your RP ID must differ from origin hostname. | empty |
| `PASSKEY_ORIGINS` | Comma-separated allowed origins for passkey ceremonies. | Set for multi-origin deployments (e.g. proxy + localhost dev). | empty |
| `UI_PORT` | Host port mapped to UI container (`http://localhost:UI_PORT`). | Change if `8080` is busy or you prefer another port. | `8080` |
| `AUTH_ADMIN_BASE_URL` | Base URL for installer’s privileged auth operations. | Change if your auth admin endpoint is hosted elsewhere. | `http://localhost:8080/auth/admin` |
| `AUTH_BOOTSTRAP_PATH` | Path for bootstrap first-user API. | Change only if your auth API uses a different route. | `/bootstrap` |
| `AUTH_TOKEN_CREATE_PATH` | Path for token creation API. | Change only if your auth API uses a different route. | `/tokens` |
| `AUTH_TOKEN_REVOKE_PATH` | Path template for token revocation (`%s` placeholder required). | Change if revoke route differs. Keep `%s` or installer can’t inject token value. | `/tokens/%s` |
| `AUTH_REGISTER_URL` | Public register endpoint used by installer when token-based register is selected. | Change if register endpoint is not on localhost/UI path. | `http://localhost:8080/auth/register` |
| `AUTH_ADMIN_BEARER` | Admin bearer token accepted by rustypaste `/auth/admin/*` endpoints. | Set this to a strong random value whenever you need bootstrap/token lifecycle operations. | empty |

---

## Common setups

## Local single-host (recommended)

Keep defaults. Only set:
- `UI_PORT` (optional)
- `VITE_TURNSTILE_SITE_KEY` (optional)
- `TURNSTILE_SECRET_KEY` (optional)
- `JWT_SECRET` (required for production)
- `VITE_MAX_EXPIRY_DAYS` (optional)
- `PASSKEYS_ENABLED` / `PASSKEY_*` (optional passkey tuning)

## Custom domain behind reverse proxy

Usually still keep `VITE_PASTE_API=/api` and `VITE_AUTH_API=/auth`, then route:
- `https://your-domain/api/*` → rustypaste `/`
- `https://your-domain/auth/*` → rustypaste `/auth/*`

## Non-interactive automation

Set:
- `AUTH_ADMIN_BEARER`
- image tag (`PASTE_API_IMAGE`)
- optionally custom admin endpoint paths

Then run installer with `--yes` + `--action ...`.

---

## Quick checks

- If login fails immediately, verify `VITE_AUTH_API` path/reverse proxy.
- If uploads fail, verify `VITE_PASTE_API` path/reverse proxy.
- If installer token actions fail, verify `AUTH_ADMIN_BASE_URL` and `AUTH_*_PATH` routes.
- If you need "Forever" retention in the selector, hold **Shift** and click **Keep for** to reveal it.

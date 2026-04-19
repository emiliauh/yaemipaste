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
   docker compose --profile with-resolver up --build -d
   ```
   To run without resolver service, omit the profile:
   ```bash
   docker compose up --build -d
   ```

---

## Variables

| Variable | What it does | When to change it | Safe default |
| --- | --- | --- | --- |
| `VITE_PASTE_API` | Frontend base path for rustypaste API calls. | Change only if you route paste API under a different path/domain. | `/api` |
| `VITE_AUTH_API` | Frontend base path for auth API calls. | Change only if auth is exposed under a different path/domain. | `/auth` |
| `VITE_FILE_RESOLVE_BASE` | Frontend path or absolute URL used to resolve `/file/<id>/...` tokens back to full filenames. Empty disables resolver fallback for token links (local cache still works). | Change if resolver is exposed somewhere other than `/resolve` (for Rust-native endpoint use `/api/resolve`), or set empty to disable fallback. | `/resolve` |
| `VITE_TOKEN_OWNER_PATH` | Frontend token-owner lookup endpoint used before upload to hydrate `meta.uploader` for token-auth sessions. Must return `{"username":"..."}` for `Authorization: <paste-token>`. Empty disables this hydration call. | Change when your token-owner route is not exposed at `/token-owner`, or set empty to disable token-owner prefill. | `/token-owner` |
| `VITE_PUBLIC_SITE_ORIGIN` | Explicit public site origin used for generated preview/share links. | Set when frontend is behind a different public hostname than current origin. | empty |
| `VITE_HISTORY_WS` | Optional history websocket endpoint override. | Set if your history WS endpoint differs from default derived URL. | empty |
| `VITE_TURNSTILE_SITE_KEY` | Enables Cloudflare Turnstile challenge in login flow. | Set when you want Turnstile protection; leave empty otherwise. | empty |
| `VITE_ENABLE_SHAREX` | Toggles ShareX download UI in account settings. | Set `1` after configuring generated ShareX output for your deployment. | `0` |
| `VITE_ENABLE_AUTH` | Enables account/token authentication UI flows. | Set `0` for anonymous public mode (`/files` opens directly, no login/register). | `1` |
| `VITE_REPOSITORY_URL` | Repository URL used by the in-app GitHub footer icon. | Change when you fork/rename the project repository. | `https://github.com/emiliauh/yaemipaste` |
| `VITE_MAX_EXPIRY_DAYS` | Max day-based expiry option shown in the UI ("Keep for"). | Set to the maximum retention days your deployment allows. | `14` |
| `PASTE_API_IMAGE` | Docker image for rustypaste backend (includes `/api` and `/auth`). | Pin to a specific version, custom build, or private registry image. | `orhunp/rustypaste:latest` |
| `DB_PATH` | SQLite DB path used by rustypaste integrated auth. | Change only if you want a different in-container auth DB location. | `/var/lib/rustypaste-auth/users.db` |
| `JWT_SECRET` | Session signing secret for `/auth` JWT tokens. | Always set a strong random value in production. | empty (required) |
| `TURNSTILE_SECRET_KEY` | Server-side Turnstile verification secret. | Set when Turnstile is enabled for login. | empty |
| `PASTE_PUBLIC_API` | Absolute API URL written into generated ShareX files. | Set to your public API URL when not running on localhost. | `http://localhost:8080/api` |
| `PASSKEYS_ENABLED` | Enables Rust WebAuthn passkey endpoints (`/auth/passkeys/*`). | Set `1` only after configuring your passkey RP origins/ID. | `0` |
| `PASSKEY_RP_NAME` | Display name shown by authenticators during passkey enrollment. | Set to your instance/app name. | `yaemipaste` |
| `PASSKEY_RP_ID` | Relying Party ID used for passkey verification. | Set when your RP ID must differ from origin hostname. | empty |
| `PASSKEY_ORIGINS` | Comma-separated allowed origins for passkey ceremonies. | Set for multi-origin deployments (e.g. proxy + localhost dev). | empty |
| `UI_PORT` | Host port mapped to UI container (`http://localhost:UI_PORT`). | Change if `8080` is busy or you prefer another port. | `8080` |
| `RESOLVER_ENABLED` | Installer toggle that controls whether compose commands include `--profile with-resolver`. | Set `0` for resolver-free mode (for Rust-native endpoint pair with `VITE_FILE_RESOLVE_BASE=/api/resolve`), otherwise keep `1`. | `1` |
| `RESOLVER_PORT` | Loopback-only port exposed for the bundled Node resolver service. | Change if `3101` is busy or you proxy it differently. | `3101` |
| `RESOLVER_UPLOAD_DIR` | Host path where Rustypaste stores uploaded files. | Change if your Rustypaste upload directory differs. | `/var/lib/rustypaste/upload` |
| `RESOLVER_PUBLIC_ORIGIN` | Public frontend origin used by resolver redirects. | Set to the same public hostname users open in the browser. | `http://localhost:8080` |
| `RESOLVER_CACHE_TTL_MS` | Resolver cache TTL for ID -> filename lookups. | Raise only if your upload directory is large and churn is low. | `30000` |
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
- `VITE_ENABLE_AUTH` (`0` for anonymous-only public mode)
- `PASSKEYS_ENABLED` / `PASSKEY_*` (optional passkey tuning)

When `VITE_ENABLE_AUTH=0`, the frontend runs in public/anonymous mode:
- login/register routes are disabled
- account-only settings (logout/passkeys/sharex config) are hidden
- Turnstile and passkeys should remain disabled (`VITE_TURNSTILE_SITE_KEY` empty, `PASSKEYS_ENABLED=0`)

Security notes:
- `VITE_PASTE_API` should be a relative path (`/api`) or trusted `https://` origin only.
- `VITE_PUBLIC_SITE_ORIGIN` should be set only to your trusted public frontend origin.

### Resolver-free mode with Rust backend endpoint

Use this when your Rustypaste build provides:
- `GET /resolve/{token}`
- `GET /file/{token}/{preview|raw|download}` for bot/crawler redirect parity

Set:
- `VITE_FILE_RESOLVE_BASE=/api/resolve`
- `RESOLVER_ENABLED=0`
- `PASTE_API_IMAGE=<your rustypaste image with /resolve endpoint>`

The minimal backend patch template for this endpoint is included at:
`patches/rustypaste-resolve-endpoint.patch`

## Custom domain behind reverse proxy

Usually still keep `VITE_PASTE_API=/api` and `VITE_AUTH_API=/auth`, then route:
- `https://your-domain/api/*` → rustypaste `/`
- `https://your-domain/auth/*` → rustypaste `/auth/*`
- `https://your-domain/resolve/*` → `resolver-server`
- keep the resolver listener on loopback only and let the reverse proxy expose it

Public browsing should be path-based:
- `https://your-domain/file/<token>/preview` → SPA preview page
- `https://your-domain/file/<token>/download` → SPA download route
- `https://your-domain/<id>/file.<ext>` (or `/file`) → raw/embed bytes from rustypaste

Example Caddy shape:

```caddyfile
your-domain.example {
  @api path /api/*
  handle @api {
    uri strip_prefix /api
    reverse_proxy 127.0.0.1:9000
  }

  @auth path /auth/*
  handle @auth {
    reverse_proxy 127.0.0.1:9000
  }

  @resolve path /resolve/*
  handle @resolve {
    reverse_proxy 127.0.0.1:3101
  }

  # browsers keep tokenized preview/raw/download routes on the SPA shell
  @fileRoutes path_regexp fileRoutes ^/file/[^/]+/(preview|raw|download)$
  handle @fileRoutes {
    rewrite * /index.html
    root * /var/www/rustypasteui
    file_server
  }

  # short raw/embed paths: /<id>/file(.ext) -> /<id>(.ext)
  @shortPathWithExt path_regexp shortExt ^/([^/]+)/file\.(.+)$
  rewrite @shortPathWithExt /{re.shortExt.1}.{re.shortExt.2}
  @shortPathNoExt path_regexp shortNoExt ^/([^/]+)/file$
  rewrite @shortPathNoExt /{re.shortNoExt.1}

  # preserve browser preview behavior for legacy one-segment IDs (without extension)
  @browserPreview {
    header Accept *text/html*
    path_regexp singleId ^/[^/.]+$
  }
  handle @browserPreview {
    rewrite * /index.html
    root * /var/www/rustypasteui
    file_server
  }

  # bots/crawlers must bypass the SPA and hit resolver/native redirect routes
  @embedResolver {
    path_regexp embedResolver ^/file/[^/]+/(preview|raw|download)$
    header_regexp User-Agent (?i)(discordbot|telegrambot|facebookexternalhit|twitterbot|whatsapp|linkedinbot|slackbot|iframely)
  }
  handle @embedResolver {
    reverse_proxy 127.0.0.1:3101
  }

  # raw/media/crawler traffic goes to rustypaste backend
  handle {
    reverse_proxy 127.0.0.1:9000
  }
}
```

Adapt the matchers to your exact Caddy version. Keep these invariants:
- normal browser navigation for tokenized `/file/*/(preview|raw|download)` stays on the SPA shell
- crawler traffic for the same tokenized routes bypasses the SPA and reaches either the Node resolver or Rust-native redirect endpoint
- short raw paths `/<id>/file(.ext)` resolve to rustypaste file bytes

If you use the bundled `docker-compose.yml`, the resolver is intentionally bound to
`127.0.0.1:${RESOLVER_PORT}` only. Expose it through your reverse proxy rather than
opening it directly on all interfaces.

The bundled compose file makes resolver optional via the `with-resolver` profile:
- With resolver (current default behavior): `docker compose --profile with-resolver up --build -d`
- Without resolver: `docker compose up --build -d`

## Focused routing regressions

When changing preview routing, resolver behavior, or reverse-proxy rules, re-run at least these checks:
- Browser flow: open `/file/<token>/preview?v=<current-version>` in a normal browser UA and confirm the SPA renders `File preview`.
- Crawler redirect flow: `curl -I -A 'Discordbot/2.0' https://<host>/file/<token>/preview?v=<current-version>` should return `302`, `Cache-Control: no-store`, and `Location: https://<host>/<id>/file.<ext>` or `/file`.
- Resolver lookup flow: `curl -s https://<host>/resolve/<token>?cb=test` should return the canonical `file_name` and `raw_path`.
- Nested storage parity: verify the tested token came from the real upload storage layout; if uploads are sharded into immediate subdirectories, resolver/native lookup must still find exactly one match.

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

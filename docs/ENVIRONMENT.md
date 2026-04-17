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
| `PASTE_API_IMAGE` | Docker image for rustypaste backend. | Pin to a specific version, custom build, or private registry image. | `orhunp/rustypaste:latest` |
| `AUTH_API_IMAGE` | Docker image for auth backend. | Pin your auth service version/tag. | `ghcr.io/emiliauh/yaemipaste-auth:latest` |
| `UI_PORT` | Host port mapped to UI container (`http://localhost:UI_PORT`). | Change if `8080` is busy or you prefer another port. | `8080` |
| `AUTH_ADMIN_BASE_URL` | Base URL for installer’s privileged auth operations. | Change if your auth admin endpoint is hosted elsewhere. | `http://localhost:8080/auth/admin` |
| `AUTH_BOOTSTRAP_PATH` | Path for bootstrap first-user API. | Change only if your auth API uses a different route. | `/bootstrap` |
| `AUTH_TOKEN_CREATE_PATH` | Path for token creation API. | Change only if your auth API uses a different route. | `/tokens` |
| `AUTH_TOKEN_REVOKE_PATH` | Path template for token revocation (`%s` placeholder required). | Change if revoke route differs. Keep `%s` or installer can’t inject token value. | `/tokens/%s` |
| `AUTH_REGISTER_URL` | Public register endpoint used by installer when token-based register is selected. | Change if register endpoint is not on localhost/UI path. | `http://localhost:8080/auth/register` |
| `AUTH_ADMIN_BEARER` | Optional admin bearer token for non-interactive runs. | Set only for automation/CI; otherwise leave empty and enter interactively. | empty |

---

## Common setups

## Local single-host (recommended)

Keep defaults. Only set:
- `UI_PORT` (optional)
- `VITE_TURNSTILE_SITE_KEY` (optional)

## Custom domain behind reverse proxy

Usually still keep `VITE_PASTE_API=/api` and `VITE_AUTH_API=/auth`, then route:
- `https://your-domain/api/*` → rustypaste
- `https://your-domain/auth/*` → auth service

## Non-interactive automation

Set:
- `AUTH_ADMIN_BEARER`
- image tags (`PASTE_API_IMAGE`, `AUTH_API_IMAGE`)
- optionally custom admin endpoint paths

Then run installer with `--yes` + `--action ...`.

---

## Quick checks

- If login fails immediately, verify `VITE_AUTH_API` path/reverse proxy.
- If uploads fail, verify `VITE_PASTE_API` path/reverse proxy.
- If installer token actions fail, verify `AUTH_ADMIN_BASE_URL` and `AUTH_*_PATH` routes.

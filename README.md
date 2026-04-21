# yaemipaste

`yaemipaste` is a Vue 3 frontend for a compatible Rustypaste backend.

It gives you a web UI for:
- file uploads
- text pastes
- public preview, raw, and download links
- history and deletion
- optional auth, passkeys, ShareX config, and client-side encryption

This repo does not ship the Rust backend itself. You need a backend image or deployment that matches the routes you enable.

## Install

Fast path:

```bash
curl -fsSL https://raw.githubusercontent.com/emiliauh/yaemipaste/main/public/install.sh | bash
```

Manual path:

```bash
git clone https://github.com/emiliauh/yaemipaste.git
cd yaemipaste
cp .env.example .env
```

Then edit `.env` and start the stack:

```bash
docker compose up --build -d
```

If your backend does not expose a native resolve endpoint yet, enable the legacy compatibility resolver:

```bash
docker compose --profile with-resolver up --build -d
```

## Configure

The most important variables are:

| Variable | What it controls | Typical value |
| --- | --- | --- |
| `VITE_PASTE_API` | Frontend path or URL for file APIs | `/api` |
| `VITE_AUTH_API` | Frontend path or URL for auth APIs | `/auth` |
| `VITE_FILE_RESOLVE_BASE` | Token resolver path for `/file/<token>/...` links | `/api/resolve` |
| `VITE_TOKEN_OWNER_PATH` | Optional token-owner lookup before upload | `/token-owner` |
| `VITE_ENABLE_AUTH` | Login/register/account UI | `1` |
| `VITE_ENABLE_SHAREX` | ShareX config download UI | `0` or `1` |
| `PASTE_API_IMAGE` | Rust backend image | your compatible image |
| `JWT_SECRET` | Session signing secret | random 32+ byte secret |
| `PASSKEYS_ENABLED` | Passkey backend routes | `0` or `1` |
| `AUTH_ADMIN_BEARER` | Installer admin bearer | strong random string |

Full reference: [docs/ENVIRONMENT.md](/path/to/repo/docs/ENVIRONMENT.md)

Backend expectations:
- upload, list, delete, and metadata routes
- `/auth/*` if auth is enabled
- `/auth/passkeys/*` if passkeys are enabled
- `/api/resolve/<token>` or equivalent if you want extension-free public token links
- `/token-owner` if you want token-auth uploads to preserve account ownership metadata

## Run

For local development:

```bash
npm ci
npm run dev
```

For a production build:

```bash
npm ci
npm run build
```

For release validation:

```bash
npm run validate:release
```

That runs the production build and then exercises the Playwright suite against `vite preview`, not the dev server.

## Deploy

The deployment flow is:

`source repo -> build -> validate -> deploy`

In practice:

```bash
npm ci
npm run validate:release
rsync -avz --delete dist/ user@host:/path/to/static-root/
ssh user@host 'sudo systemctl reload your-web-server'
```

Route these paths on your reverse proxy:
- `/api/*` to the Rust backend file API
- `/auth/*` to the auth API if enabled
- `/api/resolve/*` to the resolver route if enabled
- `/<id>/file` and `/<id>/file.<ext>` to raw file bytes

## Security Notes

- Keep instance-specific values out of git. Use `.env`, CI secrets, or your deployment system.
- The bundled nginx config ships with `nosniff`, `Referrer-Policy`, `Permissions-Policy`, and a restrictive CSP.
- If you enable uploads publicly, follow normal backend hygiene too: file size limits, filename normalization, malware scanning where appropriate, and storage outside direct webroot.

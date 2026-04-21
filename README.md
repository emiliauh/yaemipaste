# yaemipaste

`yaemipaste` ships the full app stack:
- a Vite + Vue frontend
- the modified Rust backend this UI depends on

It gives you a web UI for:
- file uploads
- text pastes
- public preview, raw, and download links
- history and deletion
- optional auth, passkeys, ShareX config, and client-side encryption

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

If you are migrating an older external backend and still need the legacy compatibility resolver:

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
| `VITE_TOKEN_OWNER_PATH` | Token-owner lookup before upload | `/api/token-owner` |
| `VITE_ENABLE_AUTH` | Login/register/account UI | `1` |
| `VITE_ENABLE_SHAREX` | ShareX config download UI | `0` or `1` |
| `PASTE_URL` | Public site URL advertised by the Rust backend | `http://localhost:8080` |
| `JWT_SECRET` | Session signing secret | random 32+ byte secret |
| `PASSKEYS_ENABLED` | Passkey backend routes | `0` or `1` |
| `AUTH_ADMIN_BEARER` | Installer admin bearer | strong random string |

Full reference: [docs/ENVIRONMENT.md](/path/to/repo/docs/ENVIRONMENT.md)

Shipped backend paths:
- `/api/*` for upload/list/delete/meta
- `/auth/*` for register/login/me/admin token flows
- `/api/resolve/*` for extension-free public token links
- `/api/token-owner` for token-auth upload ownership hydration

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
- `/api/*` to the Rust backend
- `/auth/*` to the Rust backend auth routes
- `/<id>/file` and `/<id>/file.<ext>` to raw file bytes

## Security Notes

- Keep instance-specific values out of git. Use `.env`, CI secrets, or your deployment system.
- The bundled nginx config ships with `nosniff`, `Referrer-Policy`, `Permissions-Policy`, and a restrictive CSP.
- If you enable uploads publicly, follow normal backend hygiene too: file size limits, filename normalization, malware scanning where appropriate, and storage outside direct webroot.

# rustypaste-ui

`rustypaste-ui` is a Vue 3 + Vite frontend for a compatible Rustypaste backend.

It provides a browser UI for:
- file uploads and text pastes
- account and token-based access
- history, preview, download, and delete flows
- client-side encryption and password-protected shares
- optional passkeys and ShareX config generation

This repository contains the frontend, deployment assets, tests, and operator docs. It does not contain the Rust backend source itself.

## What It Does

The UI sits in front of a Rust backend and handles the user-facing workflow:

1. Upload a file or paste text.
2. Optionally encrypt it in the browser before upload.
3. Store session state, history keys, and preview metadata locally.
4. Generate clean public links such as `/file/<token>/preview`.
5. Resolve those links back to the stored file name through a compatible backend route.

Recommended production architecture:
- static frontend built with Vite
- one Rust backend exposing file APIs and any optional auth/passkey/resolve routes you enable

Legacy compatibility note:
- `resolver-server/` is still included for older deployments that have not moved token resolution into Rust yet.
- It is not the recommended default for new public deployments.

## How It Works

Important routing rules:
- Authenticated API operations go to `VITE_PASTE_API` and `VITE_AUTH_API`.
- User-facing preview/download links stay on the frontend origin.
- Extension-free links such as `/file/<token>/preview` require a resolver path, typically `/api/resolve`.

Frontend responsibilities:
- upload and paste UI
- auth session storage
- encrypted file key storage
- history and preview rendering
- ShareX config generation

Backend responsibilities:
- upload, list, delete, and metadata APIs
- optional `/auth/*` routes
- optional `/auth/passkeys/*` routes
- token-to-file resolution route, recommended at `/resolve/{token}` and exposed to the frontend as `/api/resolve`
- optional token owner lookup used by uploads, typically `/token-owner`

## Architecture Audit

This repository ships a few pieces, but only two are part of the intended product architecture:

1. the Vite-built frontend
2. a compatible Rust backend

What else exists and why:
- `resolver-server/`: optional compatibility layer for older deployments that do not yet expose a native Rust resolve route
- nginx in `Dockerfile`: static file host for the built frontend image, not a third application with business logic
- Playwright: test tooling only
- installer scripts and docs: operator tooling only

If you are starting fresh, the target deployment should still feel like one frontend plus one Rust backend.

## Repository Audit Summary

Current release posture after this pass:
- `npm run build` succeeds locally.
- Core Playwright coverage exists and includes the password-encrypted text preview regression.
- The repo no longer defaults to personal domains, names, or repository links.
- The installer and env template now default to the two-service deployment story.
- Public docs now state the real backend contract instead of implying stock upstream Rustypaste is enough for every feature.

Known constraint:
- Full end-to-end runtime validation depends on a compatible Rust backend image and a host where browser tests can bind a local port.

## Prerequisites

For frontend development:
- Node.js 20+
- npm 10+

For container deployment:
- Docker with Compose plugin, or `docker-compose`
- a compatible Rust backend image
- a reverse proxy or static file host for the built frontend

For passkeys:
- HTTPS in production
- correct RP ID and allowed origins

## Installation

### Option 1: Interactive installer

Run the bootstrap script from the public repository:

```bash
curl -fsSL https://raw.githubusercontent.com/emiliauh/rustypaste-ui/main/public/install.sh | bash
```

Or clone and run locally:

```bash
git clone https://github.com/emiliauh/rustypaste-ui.git
cd rustypaste-ui
./install.sh
```

The installer can:
- clone or update the repo
- create `.env`
- start or stop the compose stack
- create the first user
- create or revoke auth tokens
- uninstall the local stack

### Option 2: Manual install

```bash
git clone https://github.com/emiliauh/rustypaste-ui.git
cd rustypaste-ui
cp .env.example .env
```

Edit `.env`, then start the stack:

```bash
docker compose up --build -d
```

Use the legacy compatibility resolver only if your backend does not expose a native resolve endpoint:

```bash
docker compose --profile with-resolver up --build -d
```

## Configuration

Important variables:

| Variable | Purpose | Typical value |
| --- | --- | --- |
| `VITE_PASTE_API` | Frontend path or URL for file APIs | `/api` |
| `VITE_AUTH_API` | Frontend path or URL for auth APIs | `/auth` |
| `VITE_FILE_RESOLVE_BASE` | Token resolution path | `/api/resolve` |
| `VITE_TOKEN_OWNER_PATH` | Optional token owner lookup path | `/token-owner` |
| `VITE_ENABLE_AUTH` | Enable login/register/account UI | `1` |
| `VITE_ENABLE_SHAREX` | Show ShareX download UI | `0` or `1` |
| `PASTE_API_IMAGE` | Rust backend image | your compatible image |
| `JWT_SECRET` | JWT signing secret | random 32+ byte secret |
| `PASSKEYS_ENABLED` | Enable backend passkey routes | `0` or `1` |
| `PASSKEY_RP_NAME` | Passkey display name | `rustypaste-ui` |
| `AUTH_ADMIN_BEARER` | Admin bearer used by installer token/user actions | strong random string |

Full reference: [docs/ENVIRONMENT.md](/path/to/repo/docs/ENVIRONMENT.md)

### Backend compatibility

Do not assume the stock upstream Rustypaste image supports this UI's optional features.

For authenticated mode, passkeys, token-owner hydration, or extension-free public token links, your Rust backend must provide the routes you enable.

At minimum:
- file upload and delete APIs compatible with the UI
- metadata and list endpoints used by history

For full feature parity:
- `/auth/*`
- `/auth/passkeys/*`
- `/resolve/{token}`
- `/token-owner`

The included patch template at [patches/rustypaste-resolve-endpoint.patch](/path/to/repo/patches/rustypaste-resolve-endpoint.patch) documents the expected resolve behavior.

## Development

Install dependencies:

```bash
npm ci
```

Run the dev server:

```bash
npm run dev
```

Build:

```bash
npm run build
```

Run Playwright:

```bash
npm run test:e2e
```

Release validation:

```bash
npm run validate:release
```

Branch workflow used in this repository:
- `development` for active work
- `production` for promotion-ready state
- `main` mirrors the public stable line

Helper scripts:
- [scripts/setup-dev-worktree.sh](/path/to/repo/scripts/setup-dev-worktree.sh)
- [scripts/promote-production.sh](/path/to/repo/scripts/promote-production.sh)

## Production Deployment

### Minimal recommended deployment

Use only:
1. the built frontend
2. your Rust backend

Recommended flow:

```bash
npm ci
npm run build
```

Then publish `dist/` to your static host and route:
- `/api/*` to the Rust backend file API
- `/auth/*` to the Rust backend auth API if enabled
- `/api/resolve/*` or equivalent to the Rust backend resolver route
- `/<id>/file` and `/<id>/file.<ext>` to raw bytes on the backend

Typical remote-host flow:

```bash
npm ci
npm run build
rsync -avz --delete dist/ user@your-host:/path/to/static-root/
ssh user@your-host 'sudo systemctl reload your-web-server'
```

Replace the host, path, and reload command with your own environment. Keep instance-specific values in private operator notes instead of committing them here.

If you use the bundled container image:
- the frontend is served by nginx as a static asset container
- nginx is only the static file host, not a third application layer in the product architecture

### Legacy compatibility resolver

If your backend does not yet expose native resolve endpoints, enable the bundled resolver profile and proxy `/resolve/*` to it. This is maintained for compatibility, but new deployments should prefer native Rust routes.

## User and Token Management

The installer exposes user/token operations:

```bash
./install.sh --action init-user
./install.sh --action create-token
./install.sh --action revoke-token
```

Those commands use:
- `AUTH_ADMIN_BASE_URL`
- `AUTH_BOOTSTRAP_PATH`
- `AUTH_TOKEN_CREATE_PATH`
- `AUTH_TOKEN_REVOKE_PATH`
- `AUTH_REGISTER_URL`
- `AUTH_ADMIN_BEARER`

Typical flow:
1. Install the stack and set `AUTH_ADMIN_BEARER`.
2. Start the backend.
3. Create the first user with `./install.sh --action init-user`.
4. Create access tokens as needed with `./install.sh --action create-token`.
5. Revoke tokens with `./install.sh --action revoke-token`.

If you disable auth mode with `VITE_ENABLE_AUTH=0`, the login/register UI is hidden and these lifecycle commands are not part of the normal deployment flow.

## Uninstall

Interactive uninstall:

```bash
./install.sh --action uninstall
```

The uninstall path can:
- stop containers
- remove volumes if you confirm the destructive option
- delete the install directory after explicit confirmation

Manual uninstall:

```bash
docker compose down --remove-orphans
docker compose down --volumes --remove-orphans
rm -rf /path/to/install
```

Use the volume-removal command only if you intend to delete persisted auth data.

## Troubleshooting

Common issues:

- Login works in UI but requests fail:
  verify `VITE_AUTH_API`, reverse-proxy routes, and backend auth support.
- Uploads fail:
  verify `VITE_PASTE_API` and the backend upload route.
- Public token links fail:
  verify `VITE_FILE_RESOLVE_BASE` and the backend resolve route.
- Installer token actions fail:
  verify `AUTH_ADMIN_BEARER` and the admin endpoint paths.
- Playwright fails before tests start:
  the local environment may forbid binding a dev server port. Run it on a host where localhost listeners are allowed.

More operator detail:
- [docs/wiki/Architecture.md](/path/to/repo/docs/wiki/Architecture.md)
- [docs/wiki/Deployment.md](/path/to/repo/docs/wiki/Deployment.md)
- [docs/wiki/User-and-Token-Management.md](/path/to/repo/docs/wiki/User-and-Token-Management.md)
- [docs/wiki/Troubleshooting.md](/path/to/repo/docs/wiki/Troubleshooting.md)

## Contributing

Before opening a PR:

```bash
npm ci
npm run build
npm run test:e2e
```

Keep changes scoped. Avoid mixing routing, UI, installer, and deployment rewrites unless they are directly related.

## License

[MIT](/path/to/repo/LICENSE)

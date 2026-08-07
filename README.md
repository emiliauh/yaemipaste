# yaemipaste

Self-hosted file sharing and text pastes with previews, downloads, upload
history, expiry controls, accounts, ShareX integration, and administration.

yaemipaste uses its native NestJS backend in `backend/nestjs`. The backend
stores account, session, administration, and audit state in SQLite and stores
uploaded file bytes and metadata on the filesystem. It is the default and
supported backend for new installations.

## Features

- File and text uploads with expiry and optional browser-side encryption
- Path-based pages at `/files`, `/history`, `/login`, `/register`, and `/admin`
- Public preview, raw, and download links
- Account registration, login, upload tokens, password changes, and passkeys
- ShareX configuration generated for the signed-in account
- Admin user, upload, settings, webhook, and audit management
- SQLite authentication state and filesystem-backed upload storage

## Install

Requirements: Linux, Docker Compose, `git`, and `curl`. A DNS name with HTTPS
handled by Caddy or Nginx is recommended for public deployments.

```bash
curl -fsSL https://paste.yaemi.one/install.sh | sudo bash
```

Or clone the repository:

```bash
git clone https://github.com/emiliauh/yaemipaste.git
cd yaemipaste
sudo ./install.sh
```

The installer creates `.env`, configures the UI and NestJS API, asks for the
public URL, and prints an administrator claim link. Uploads require an account
or upload token by default. Set `ALLOW_ANONYMOUS_UPLOADS=1` only when anonymous
uploads are intentional.

For unattended installation:

```bash
sudo ./install.sh --action install --yes \
  --public-url https://paste.example.com \
  --deployment same
```

For split hosts, add `--deployment split --split-role ui|api` and
`--api-origin https://api.example.com`.

## Build And Run

Build and test the frontend and API from source:

```bash
npm ci
npm run build
npm run api:build
npm run api:test
npm run test:e2e:preview
```

Run the complete local stack:

```bash
cp .env.example .env
COMPOSE_PROFILES=ui,api DEPLOYMENT_IMAGE_MODE=build docker compose up --build -d
```

For frontend development, run `npm run dev`. Build and start the backend
directly with:

```bash
npm --prefix backend/nestjs ci
npm --prefix backend/nestjs run build
npm --prefix backend/nestjs start
```

The backend reads `CONFIG` when set, uses `DB_PATH` for its SQLite database,
and uses `SERVER__UPLOAD_PATH` for uploaded files.

## First Administrator

Create an initial account and claim the one-time administrator token:

```bash
sudo ./install.sh --action init-user
sudo ./install.sh --action admin-claim
```

The `/admin` page manages users, uploads, public settings, webhooks, and audit
events. See [user and token management](docs/wiki/User-and-Token-Management.md).

## Operations

```bash
sudo ./install.sh --action status
sudo ./install.sh --action restart
sudo ./install.sh --action stop
```

## Documentation

- [Environment reference](docs/ENVIRONMENT.md)
- [Architecture](docs/wiki/Architecture.md)
- [Production deployment](docs/deployment/production.md)
- [Caddy deployment](docs/deployment/caddy.md)
- [Nginx deployment](docs/deployment/nginx.md)
- [Cloudflare edge guidance](docs/deployment/cloudflare.md)
- [Troubleshooting](docs/wiki/Troubleshooting.md)

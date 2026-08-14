# yaemipaste

yaemipaste is a self-hosted service for file sharing and text pastes. It
supports previews, downloads, upload history, expiry rules, user accounts,
ShareX, webhooks, and an administrator panel.

The supported backend is the native NestJS service in `backend/nestjs`. It
stores account, session, administrator, and audit data in SQLite. It stores
uploaded files and metadata on the filesystem.

## Features

- Upload files and text with expiry rules and optional browser-side encryption
- Use path-based pages at `/files`, `/history`, `/login`, `/register`, and
  `/admin`
- Create public preview, raw, and download links
- Register accounts, sign in, change passwords, use upload tokens, and use
  passkeys
- Generate ShareX settings for a signed-in account
- Manage users, uploads, settings, webhooks, and audit events as an
  administrator
- Store authentication data in SQLite and upload data on the filesystem

## Install

Requirements:

- Linux
- Docker Compose
- `git`
- `curl`

For a public deployment, use a DNS name with HTTPS. Caddy and Nginx are
supported reverse proxies.

Run the installer:

```bash
curl -fsSL https://paste.yaemi.one/install.sh | sudo bash
```

You can also clone the repository:

```bash
git clone --branch nestjs-rewrite https://github.com/emiliauh/yaemipaste.git
cd yaemipaste
sudo ./install.sh
```

The installer creates `.env`, configures the UI and NestJS API, asks for the
public URL, and prints an administrator claim link. New installations require
an account or upload token for uploads. Set `ALLOW_ANONYMOUS_UPLOADS=1` only
when you want anonymous uploads.

The installer stores the generated JWT signing secret and admin bearer in
`.env` with mode `0600`. Each later Compose command loads this file. You can
run the installer from any working directory.

For an unattended install:

```bash
sudo ./install.sh --action install --yes \
  --public-url https://paste.example.com \
  --deployment same
```

For a temporary test server without a reverse proxy, use a reachable IP and
bind the UI to all interfaces:

```bash
sudo ./install.sh --action install --yes \
  --public-url http://203.0.113.10:8080 \
  --ui-bind 0.0.0.0 \
  --deployment same
```

For separate UI and API hosts, use
`--deployment split --split-role ui|api` and set
`--api-origin https://api.example.com`.

## Build and run

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

For frontend development, run `npm run dev`. To build and start the backend:

```bash
npm --prefix backend/nestjs ci
npm --prefix backend/nestjs run build
npm --prefix backend/nestjs start
```

The backend reads `CONFIG` when it is set. It uses `DB_PATH` for SQLite and
`SERVER__UPLOAD_PATH` for uploaded files.

## CI and images

GitHub Actions checks pushes and pull requests for `nestjs-rewrite`. The checks
include the installer smoke test, NestJS API build and security tests, frontend
build, and Playwright tests.

The image workflow publishes branch and commit-SHA tags to GHCR:

```text
ghcr.io/emiliauh/yaemipaste-api:nestjs-rewrite
ghcr.io/emiliauh/yaemipaste-ui:nestjs-rewrite
ghcr.io/emiliauh/yaemipaste-api:sha-<commit>
ghcr.io/emiliauh/yaemipaste-ui:sha-<commit>
```

The installer uses the `nestjs-rewrite` branch and image tag by default. For a
fixed production version, set `YAEMIPASTE_IMAGE_TAG` to a commit-SHA tag.

## First administrator

Create an account and claim the one-time administrator token:

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

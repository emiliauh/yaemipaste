# yaemipaste

yaemipaste is a self-hostable paste and file-sharing stack built on top of **[rustypaste](https://github.com/orhun/rustypaste)**.

If you want the short version: rustypaste handles the file backend, and this project wraps it with a cleaner UI, authentication, token workflows, passkeys, and optional client-side encrypted shares.

This repository is public-facing and intended for independent deployments.

If you want the full docs reference (env details, feature behavior, and troubleshooting), start here:
- [`docs/ENVIRONMENT.md`](docs/ENVIRONMENT.md)
- [`docs/KNOWLEDGEBASE.md`](docs/KNOWLEDGEBASE.md)

## Rustypaste backend usage

yaemipaste relies on rustypaste as the core file backend:
- file storage and serving
- upload/delete/list flow
- expiry behavior
- public file paths and download endpoints

The UI and installer are designed around that model so you can deploy the full stack without stitching things together manually.

## Install options

## 1) One-command installer (recommended)

Hosted bootstrap endpoint:

```bash
curl -fsSL "https://example.invalid/install.sh?v=latest" | bash
```

The installer is interactive and supports:
- full stack install/update
- first user initialization
- token create/revoke
- service start/stop/restart/status
- safe uninstall with confirmation prompts

You can also run it from a local clone:

```bash
git clone https://github.com/emiliauh/yaemipaste.git
cd yaemipaste
./install.sh
```

## 2) Docker Compose (manual)

```bash
git clone https://github.com/emiliauh/yaemipaste.git
cd yaemipaste
cp .env.example .env
docker compose up --build -d
```

By default, UI is exposed on `http://localhost:8080`.  
Set `UI_PORT` in `.env` to choose another port.

## Configuration

Edit `.env` for your deployment.  
For a complete variable-by-variable explanation, use [`docs/ENVIRONMENT.md`](docs/ENVIRONMENT.md).

No personal credentials or private keys are required in repository files.

Expiry notes:
- set `VITE_MAX_EXPIRY_DAYS` to control the max day-based retention shown in the UI (default 14)
- to reveal **Forever** retention in the selector, hold **Shift** and click the **Keep for** control

## Expose to the web

Typical pattern:

1. Set `UI_PORT` (e.g. `8080`).
2. Put a reverse proxy (Nginx/Caddy/Traefik) in front of your host.
3. Route your public domain to `localhost:${UI_PORT}`.
4. Enable TLS (Let’s Encrypt or your certificate provider).

## Screenshots

<table>
  <tr>
    <td><strong>Login</strong><br><img src="docs/screenshots/login-dark.png" alt="Login view (dark mode)" /></td>
    <td><strong>Preview</strong><br><img src="docs/screenshots/preview-dark.png" alt="Public preview view (dark mode)" /></td>
  </tr>
  <tr>
    <td colspan="2"><strong>Private</strong><br><img src="docs/screenshots/private-dark.png" alt="Private dashboard view (dark mode)" /></td>
  </tr>
</table>

## Validation

```bash
npm run build
npm run test:e2e
npm audit --audit-level=moderate
bash -n ./install.sh
```

## Credits

- **rustypaste** by [@orhun](https://github.com/orhun) — core backend powering the file service: https://github.com/orhun/rustypaste

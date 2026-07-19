# yaemipaste

Self-hosted file sharing and text pastes with preview, download links, upload
history, expiry controls, accounts, and an admin panel.

## Install

Requirements: Linux, Docker Compose, `git`, and `curl`. A DNS name
with HTTPS handled by Caddy or Nginx is recommended for public deployments.

Run the installer directly:

```bash
curl -fsSL https://paste.yaemi.one/install.sh | sudo bash
```

Or clone the repository:

```bash
git clone https://github.com/emiliauh/yaemipaste.git
cd yaemipaste
sudo ./install.sh
```

The installer sets up the stack, creates `.env`, asks for your public URL, and
prints an admin claim link. See [install.sh](install.sh) for all options.

Uploads require an account or upload token by default. Set
`ALLOW_ANONYMOUS_UPLOADS=1` in `.env` only if you intentionally want public
anonymous uploads.

For unattended installation:

```bash
sudo ./install.sh --action install --yes \
  --public-url https://paste.example.com \
  --deployment same
```

For split hosts, add `--deployment split --split-role ui|api` and
`--api-origin https://api.example.com`.

### IP Access

DNS and HTTPS are preferred, but a direct IP is supported for LAN or simple
deployments. Bind the UI to all interfaces and include the port in the URL:

```bash
sudo ./install.sh --action install --yes \
  --public-url http://192.0.2.10:8080 \
  --deployment same
```

Replace `192.0.2.10` with your server's reachable IP. HTTP IP deployments do
not support browser passkeys; use HTTPS and a DNS name when that is needed. The
installer exposes the UI directly when an IP URL is selected; pass
`--ui-bind 127.0.0.1` if a reverse proxy should keep it loopback-only.

## First Administrator

Create an initial account, then claim the one-time administrator token:

```bash
sudo ./install.sh --action init-user
sudo ./install.sh --action admin-claim
```

The administrator panel lives at `/admin`. It can manage users, uploads,
safe public settings, webhooks, and audit events. See
[user and token management](docs/wiki/User-and-Token-Management.md).

## Operations

```bash
sudo ./install.sh --action status
sudo ./install.sh --action restart
sudo ./install.sh --action stop
```

## Documentation

- [Environment reference](docs/ENVIRONMENT.md)
- [Production deployment](docs/deployment/production.md)
- [Caddy deployment](docs/deployment/caddy.md)
- [Nginx deployment](docs/deployment/nginx.md)
- [Cloudflare edge guidance](docs/deployment/cloudflare.md)
- [User and token management](docs/wiki/User-and-Token-Management.md)

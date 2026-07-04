# yaemipaste

yaemipaste is working, but it may not be 100% finished yet.

It is a self-hosted paste and file sharing app.

It includes:
- a Vue + Vite frontend
- the modified Rust backend it depends on
- an install script that sets up the full stack for you

You can use it for:
- file uploads
- text pastes
- public preview, raw, and download links
- upload history and deletion
- optional accounts, passkeys, ShareX, and client-side encryption

## What You Need

For the normal install path:
- a Linux machine
- Docker with Compose support
- `git` and `curl`

If Docker or other basic packages are missing on a Debian/Ubuntu machine, the installer can bootstrap them.

## Install

Clone the repo and run the installer:

```bash
git clone https://github.com/emiliauh/yaemipaste.git
cd yaemipaste
./install.sh
```

The installer is interactive. It will walk you through the main settings and then build and start the stack.

If you want to accept defaults without prompts:

```bash
./install.sh --action install --yes
```

## Configure

The installer writes your runtime settings to `.env`.

The most important values are:

| Variable | What it does |
| --- | --- |
| `PASTE_URL` | Public URL your users will open |
| `PASTE_PUBLIC_API` | Public API URL used for backend-generated links and ShareX |
| `VITE_PASTE_API` | Frontend file API path or URL |
| `VITE_AUTH_API` | Frontend auth API path or URL |
| `VITE_FILE_RESOLVE_BASE` | Resolver path for `/file/<token>/...` links |
| `VITE_ENABLE_AUTH` | Enables login/register/account UI |
| `VITE_ENABLE_SHAREX` | Enables ShareX download/setup UI |
| `JWT_SECRET` | Session signing secret |
| `AUTH_ADMIN_BEARER` | Admin bearer used by the installer for bootstrap/token actions |
| `PASSKEYS_ENABLED` | Enables passkey routes in the backend |

Full environment reference:
`docs/ENVIRONMENT.md`

Do not commit your real `.env` file or any live secrets.

## Run

After install, the stack is managed through Docker Compose.

Start:

```bash
./install.sh --action start
```

Stop:

```bash
./install.sh --action stop
```

Restart:

```bash
./install.sh --action restart
```

Status:

```bash
./install.sh --action status
```

Create the first user:

```bash
./install.sh --action init-user
```

## Admin Panel

yaemipaste includes a self-hosted admin panel at `/admin`, protected
server-side by account JWT + `is_admin=1` (not just hidden client-side).

Claim the first administrator once, right after install:

```bash
./install.sh --action admin-claim
```

This prints a one-time claim URL and token. The token is bcrypt-hashed
server-side, never written in plaintext, and is invalidated the moment it's
used. Lost it or need a fresh one? `./install.sh --action reset-admin-claim`.

From the panel you can manage users (create/suspend/delete/rotate tokens),
browse and purge uploads, edit safe global settings, configure webhooks, and
review an audit log of admin actions. Full details:
`docs/wiki/User-and-Token-Management.md`.

The installer's interactive menu (`./install.sh --interactive`, or bare
`./install.sh`) is the stable guided-install/admin-claim path and works even
before Rust tooling is present. If `cargo` is already installed, `./install.sh
--tui` launches an optional Ratatui action picker (`tools/install-tui`) that
dispatches into the same install.sh actions; it falls back to the shell menu
automatically when cargo or the companion binary is unavailable.

## Manual Docker Run

If you do not want to use the installer, you can still run the app manually:

```bash
cp .env.example .env
docker compose up --build -d
```

If you are running an older compatibility setup that still needs the bundled Node resolver:

```bash
docker compose --profile with-resolver up --build -d
```

## Development

Frontend development:

```bash
npm ci
npm run dev
```

Production build:

```bash
npm run build
```

Release-style validation:

```bash
npm run validate:release
```

## Notes

- New installs should use the built-in Rust resolver path at `/api/resolve`.
- Client-side encryption requires a secure browser context, which means `https://...` or `http://localhost`.
- Public file links are path-based. Users should see links like `/file/<token>/preview` or `/<id>/file.txt`, not raw API URLs.
- Keep instance-specific hostnames, secrets, and deployment commands out of git.

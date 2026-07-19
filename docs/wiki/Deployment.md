# Deployment

## Recommended Deployment Flow

1. Build the frontend:

```bash
npm ci
npm run build
```

2. Publish `dist/` to your static host.
3. Route frontend-relative API paths to the Rust backend.
4. Validate upload, history, preview, and download flows.

For a remote static-host deployment, the pattern is:

```bash
npm ci
npm run build
rsync -avz --delete dist/ user@host:/path/to/static-root/
ssh user@host 'sudo systemctl reload <your-web-server>'
```

Replace the host, path, and reload command with your own environment. Keep these values out of reusable public docs.

## Reverse Proxy Requirements

Route these paths:

- `/api/*` to the backend file API
- `/auth/*` to the backend auth API if enabled
- resolver path, usually `/api/resolve/*`, to the backend resolver route
- raw file paths such as `/<id>/file` and `/<id>/file.<ext>` to backend file bytes

Recommended security headers for the frontend host:
- `Content-Security-Policy` that restricts scripts, frames, and object embeds
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy` with unused browser features disabled
- `Cache-Control: no-store` on the HTML shell when fast rollout of route fixes matters

## Container Deployment

The bundled `docker-compose.yml` is for local or self-hosted deployments that want:
- a static frontend container
- a Rust backend container

Use:

```bash
docker compose --profile ui --profile api up --build -d
```

Enable the legacy resolver only if needed:

```bash
docker compose --profile ui --profile api --profile with-resolver up --build -d
```

Use that resolver profile only for older deployments whose Rust backend still lacks a native resolve route.

## Remote Validation Checklist

After changing deployment or routing, verify:
- `GET /` returns the frontend
- upload succeeds from the Files page
- History lists the uploaded item
- `/file/<token>/preview` resolves correctly
- `/file/<token>/raw` and `/file/<token>/download` work
- raw public paths such as `/<id>/file` or `/<id>/file.<ext>` serve bytes directly
- auth and passkey flows still match backend support if enabled
- reverse-proxy config validates before reload if your host uses Caddy or nginx

## Deployment Validation

After each deployment:
- upload a text paste
- upload an image
- open history
- open a public preview link
- verify raw and download links
- verify auth/passkey flows only if enabled

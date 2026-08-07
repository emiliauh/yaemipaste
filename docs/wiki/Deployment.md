# Deployment

## Build And Test

```bash
npm ci
npm run build
npm run api:build
npm run api:test
npm run test:e2e:preview
```

`npm run validate:release` runs the frontend build, backend build and tests,
installer smoke test, and preview end-to-end suite as one release check.

## Container Deployment

The standard stack contains the static frontend and native NestJS backend:

```bash
cp .env.example .env
COMPOSE_PROFILES=ui,api DEPLOYMENT_IMAGE_MODE=build docker compose up --build -d
```

Use persistent volumes for `DB_PATH` and `SERVER__UPLOAD_PATH`. Keep both when
upgrading so users, auth state, metadata, and uploads remain intact.

## Reverse Proxy Contract

The simplest same-host deployment proxies the entire public hostname to the
bundled UI service. Its Nginx configuration handles:

- SPA pages including `/files`, `/history`, `/login`, `/register`, and `/admin`
- `/api/*` to the backend with `/api` stripped
- `/auth/*` to backend auth routes
- public preview and explicit raw/download file requests

When serving `dist/` directly, reproduce the API, auth, and public-file
matchers before the SPA fallback. Do not send unknown paths to the API because
browser pages must receive `index.html`.

HTML, API, auth, metadata, and error responses should not be cached at an edge.
Cache only fingerprinted static assets. This prevents an obsolete HTML shell,
metadata response, or 404 from surviving a deployment.

## Production Validation

After every deployment:

1. Confirm `/`, `/files`, `/history`, `/login`, `/register`, and `/admin`
   return the current frontend HTML.
2. Confirm `/api/` and `/auth/admin/public-settings` reach the NestJS backend.
3. Register or sign in, upload text and an image, and verify history metadata.
4. Verify preview, raw, download, and deletion behavior.
5. Download and test the authenticated ShareX configuration.
6. Verify admin authorization and enabled Turnstile or passkey flows.
7. Compare origin and edge responses, including cache headers, when a CDN or
   tunnel is present.
8. Restore SQLite and upload backups in an isolated environment periodically.

The optional service in `resolver-server/` is migration-only. Do not enable it
for a normal NestJS deployment.

# Deployment

## Build and test

```bash
npm ci
npm run build
npm run api:build
npm run api:test
npm run test:e2e:preview
```

`npm run validate:release` runs the frontend build, backend build and tests,
installer smoke test, and preview end-to-end suite.

## Container deployment

The standard stack contains the static frontend and native NestJS backend:

```bash
cp .env.example .env
COMPOSE_PROFILES=ui,api DEPLOYMENT_IMAGE_MODE=build docker compose up --build -d
```

Use persistent volumes for `DB_PATH` and `SERVER__UPLOAD_PATH`. Keep both
volumes during an upgrade. They contain users, authentication data, metadata,
and uploads.

## Reverse proxy contract

The simplest same-host deployment sends the complete public hostname to the
bundled UI service. Its Nginx configuration handles:

- SPA pages such as `/files`, `/history`, `/login`, `/register`, and `/admin`
- `/api/*` to the backend, with `/api` removed
- `/auth/*` to backend auth routes
- Public preview and explicit raw or download file requests

When serving `dist/` directly, put the API, auth, and public-file matchers
before the SPA fallback. Unknown browser paths must receive `index.html`, not
an API response.

Do not cache HTML, API, auth, metadata, or error responses at the edge. Cache
only fingerprinted static assets. This prevents old HTML, metadata, or 404
responses from surviving a deployment.

## Production validation

Run these checks after each deployment:

1. Check that `/`, `/files`, `/history`, `/login`, `/register`, and `/admin`
   return the current frontend HTML.
2. Check that `/api/` and `/auth/admin/public-settings` reach the NestJS
   backend.
3. Register or sign in. Upload text and an image. Check the history metadata.
4. Check preview, raw, download, and delete behavior.
5. Download and test the authenticated ShareX configuration.
6. Check administrator authorization and enabled Turnstile or passkey flows.
7. Compare origin and edge responses, including cache headers, when a CDN or
   tunnel is present.
8. Restore SQLite and upload backups in an isolated environment at regular
   intervals.

The optional service in `resolver-server/` is for migrations. Do not enable it
for a normal NestJS deployment.

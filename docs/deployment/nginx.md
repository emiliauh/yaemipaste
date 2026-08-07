# Nginx Deployment

## Same Host

```nginx
server {
  listen 443 ssl http2;
  server_name paste.example.com;
  client_max_body_size 50g;
  location / { proxy_pass http://127.0.0.1:8080; }
}
```

The bundled UI proxy handles the native NestJS API, auth, public-link
resolution, and public raw paths. Browser routes such as `/files`, `/history`,
`/login`, `/register`, and `/admin` receive the SPA shell.
Validate with `nginx -t` before reload.

## Split Host

Expose the NestJS API through a separate TLS server block at
`api.example.com`, proxying to `127.0.0.1:8000`. The UI server must proxy raw
public file byte requests to that API host and apply SPA fallback only after
API/auth/raw route matching. Configure exact CORS and CSP values from
`docs/deployment/production.md`.

Do not cache `index.html`, API/auth responses, metadata, or 404s. Fingerprinted
files under `/assets/` are the appropriate cacheable surface.

# Nginx deployment

## Same host

```nginx
server {
  listen 443 ssl http2;
  server_name paste.example.com;
  client_max_body_size 50g;
  location / { proxy_pass http://127.0.0.1:8080; }
}
```

The bundled UI proxy handles the NestJS API, auth, public-link resolution,
and public raw paths. Browser routes such as `/files`, `/history`, `/login`,
`/register`, and `/admin` receive the SPA shell.

Run `nginx -t` before a reload.

## Split host

Expose the NestJS API through a separate TLS server at `api.example.com` and
proxy it to `127.0.0.1:8000`. The UI server must send raw public-file requests
to that API host. Apply SPA fallback only after API, auth, and raw route
matching. Use the exact CORS and CSP values from
`docs/deployment/production.md`.

Do not cache `index.html`, API or auth responses, metadata, or 404 responses.
Cache only fingerprinted files under `/assets/`.

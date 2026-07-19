# Nginx Deployment

## Same Host

```nginx
server {
  listen 443 ssl http2;
  server_name paste.example.com;
  client_max_body_size 100m;
  location / { proxy_pass http://127.0.0.1:8080; }
}
```

The bundled UI proxy handles API, auth, resolver, and public raw paths.
Validate with `nginx -t` before reload.

## Split Host

Expose the Rust API through a separate TLS server block at
`api.example.com`, proxying to `127.0.0.1:8000`. The UI server must proxy raw
public file byte requests to that API host and apply SPA fallback only after
API/auth/raw route matching. Configure exact CORS and CSP values from
`docs/deployment/production.md`.

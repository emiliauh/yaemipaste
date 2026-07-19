# Caddy Deployment

## Same Host

Bind Compose UI to `127.0.0.1:8080`, then proxy the entire public host to it:

```caddyfile
paste.example.com {
  request_body { max_size 100MB }
  reverse_proxy 127.0.0.1:8080
}
```

The bundled UI Nginx owns API/auth/raw routing. Validate with
`caddy validate --config /etc/caddy/Caddyfile`.

## Split Host

Serve the built UI on `paste.example.com`; proxy the API origin to the
loopback-published Rust service:

```caddyfile
api.example.com {
  request_body { max_size 100MB }
  reverse_proxy 127.0.0.1:8000
}
```

The UI host must route raw public file bytes to `api.example.com` while keeping
SPA preview routes local. Configure exact `CORS_ALLOWED_ORIGINS` and
`CSP_CONNECT_SRC` before building the UI. Preserve `Host`, forwarded client IP,
and HTTPS scheme headers; Caddy supplies these by default.

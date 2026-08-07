# Caddy Deployment

## Same Host

Bind Compose UI to `127.0.0.1:8080`, then proxy the entire public host to it:

```caddyfile
paste.example.com {
  request_body { max_size 100MB }
  reverse_proxy 127.0.0.1:8080
}
```

The bundled UI Nginx owns SPA fallback and API/auth/raw routing. Caddy must send
**every** request for the UI hostname to that service. Do not add a final
catch-all that proxies unknown paths to the NestJS API: `/`, `/files`,
`/history`, `/login`, `/register`, `/admin`, and `/file/*` are browser routes
and must receive the UI's `index.html`.

If Caddy serves the build directory directly instead, use an explicit SPA
fallback and put API matchers before it:

```caddyfile
paste.example.com {
  request_body { max_size 100MB }

  handle /api/* {
    uri strip_prefix /api
    reverse_proxy 127.0.0.1:8000
  }

  handle /auth/* {
    reverse_proxy 127.0.0.1:8000
  }

  handle {
    root * /var/www/yaemipaste
    try_files {path} /index.html
    file_server
  }
}
```

The direct-static example is intentionally incomplete for public raw-file and
native API resolution routes. Prefer proxying the entire host to the bundled UI
unless those routes are also reproduced from `docker/nginx/default.conf`.

Validate before reload with `caddy validate --config /etc/caddy/Caddyfile`.

## Cloudflare Troubleshooting

When loopback requests with `Host: paste.example.com` return the UI but the
public hostname returns the YaemiPaste file-not-found page, the Vue router is
not involved. The public request is reaching a different Caddy site/upstream,
or Cloudflare is serving a cached response or route rule.

Compare the origin and edge response without changing DNS:

```sh
curl -skS -D- --resolve paste.example.com:443:127.0.0.1 \
  https://paste.example.com/history -o /dev/null
curl -sS -D- https://paste.example.com/history -o /dev/null
```

Check both `A` and `AAAA` records, Cloudflare Tunnel ingress, Origin Rules,
Redirect Rules, Workers routes, and cache rules for the hostname. Remove any
rule that sends UI paths to the API port and purge cached HTML, metadata, and
404 responses after correcting the route. A healthy response for each browser route is `200` with
`Content-Type: text/html`; `/api/` should remain the API response.

Set `Cache-Control: no-store` for HTML, `/api/*`, and `/auth/*` at every active
origin listener, including a separate listener used by a tunnel. Cache only
fingerprinted assets. Test the tunnel-facing listener directly as well as the
normal HTTPS listener; two listeners can otherwise serve different UI roots.

## Split Host

Serve the built UI on `paste.example.com`; proxy the API origin to the
loopback-published NestJS service:

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

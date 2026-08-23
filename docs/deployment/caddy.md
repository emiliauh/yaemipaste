# Caddy deployment

## Same host

Bind the Compose UI to `127.0.0.1:8080`. Send the complete public hostname to
that service:

```caddyfile
paste.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

The bundled UI proxy owns SPA fallback and API, auth, raw, and download
routing. Caddy must send every request for the UI hostname to this service.
Do not send unknown paths to the NestJS API. `/`, `/files`, `/history`,
`/login`, `/register`, and the preview/download `/file/*` routes are browser
routes and must receive the UI `index.html`. `/file/<token>/raw` is a direct
file response and is handled by the bundled UI proxy.

If Caddy serves the build directory directly, use an SPA fallback and put API
matchers before it:

```caddyfile
paste.example.com {
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

This direct-static example does not include public raw-file and native
resolution routes. Proxy the complete host to the bundled UI unless you also
configure those routes from `docker/nginx/default.conf`.

For direct-static deployments, send crawler preview requests to the NestJS API
before the SPA fallback:

```caddyfile
@embedPreview {
  path_regexp embed_preview ^/file/[^/]+/preview$
  header_regexp User-Agent (?i)(Discordbot|Slackbot|Twitterbot|facebookexternalhit|WhatsApp|TelegramBot|LinkedInBot|Pinterest|SkypeUriPreview|Googlebot|bingbot)
}
handle @embedPreview {
  header Cache-Control no-store
  header CDN-Cache-Control no-store
  header Vary "Accept, User-Agent"
  reverse_proxy 127.0.0.1:8000 {
    header_up X-Preview-Embed 1
  }
}
```

Place this handler before `handle /file/*`. Keep the raw and download handlers
after it.

Validate before reload:

```sh
caddy validate --config /etc/caddy/Caddyfile
```

## Cloudflare troubleshooting

If a loopback request with `Host: paste.example.com` returns the UI but the
public hostname returns the file-not-found page, the public request is using a
different Caddy site, upstream, or cached response.

Compare the origin and edge:

```sh
curl -skS -D- --resolve paste.example.com:443:127.0.0.1 \
  https://paste.example.com/history -o /dev/null
curl -sS -D- https://paste.example.com/history -o /dev/null
```

Check both `A` and `AAAA` records, Cloudflare Tunnel ingress, Origin Rules,
Redirect Rules, Workers routes, and cache rules. Remove rules that send UI
paths to the API port. Purge cached HTML, metadata, and 404 responses after
you correct the route.

Set `Cache-Control: no-store` for HTML, `/api/*`, and `/auth/*` at every active
origin listener. Cache only fingerprinted assets. Test the tunnel listener and
the normal HTTPS listener because they can serve different UI roots.

## Split host

Serve the UI on `paste.example.com`. Proxy the API to the loopback service:

```caddyfile
api.example.com {
  reverse_proxy 127.0.0.1:8000
}
```

The UI host must send raw public-file bytes to `api.example.com` while keeping
SPA preview routes local. Set exact `CORS_ALLOWED_ORIGINS` and
`CSP_CONNECT_SRC` values before building the UI. Preserve the host, client IP,
and HTTPS scheme headers. Caddy supplies these headers by default.

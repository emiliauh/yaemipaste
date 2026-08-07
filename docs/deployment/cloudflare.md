# Cloudflare Edge Guidance

Use Full (strict) TLS with a valid origin certificate. Do not cache `/api/*`,
`/auth/*`, native resolution routes, raw file routes, or authenticated responses.
Cache only fingerprinted static assets; do not cache HTML or 404 responses.
Origin Rules, Workers routes, and load balancers must send the UI hostname to
the bundled UI service, not directly to the NestJS API. Keep `A` and `AAAA`
records pointed at the same deployment.

When Cloudflare Tunnel is used, its ingress target must be the same bundled UI
service or equivalent route configuration as the public HTTPS origin. Verify
`/`, `/history`, `/api/`, and `/auth/admin/public-settings` through the tunnel
target and public hostname. A cached metadata response can preserve an old
display name, so `/api/meta/*` must remain uncacheable.

Cloudflare upload limits depend on your plan; use a DNS-only API hostname or a
suitable plan when required uploads exceed the edge limit. Restrict origin
ports with a firewall and keep origin TLS valid. Turnstile keys must be
registered for the public UI hostname. See `docs/deployment/caddy.md` for
origin-versus-edge verification commands.

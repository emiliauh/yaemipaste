# Cloudflare edge guidance

Use Full (strict) TLS with a valid origin certificate. Do not cache `/api/*`,
`/auth/*`, native resolution routes, raw file routes, or authenticated
responses. Cache only fingerprinted static assets. Do not cache HTML or 404
responses.

Origin Rules, Workers routes, and load balancers must send the UI hostname to
the bundled UI service, not directly to the NestJS API. Keep `A` and `AAAA`
records pointed at the same deployment.

For Cloudflare Tunnel, use the same bundled UI service or the same route
configuration as the public HTTPS origin. Check `/`, `/history`, `/api/`, and
`/auth/admin/public-settings` through the tunnel and the public hostname.
Keep `/api/meta/*` uncacheable so old metadata does not remain at the edge.

Cloudflare upload limits depend on the plan. Use a DNS-only API hostname or a
plan that supports the required upload size. Restrict origin ports with a
firewall. Keep the origin certificate valid. Register Turnstile keys for the
public UI hostname.

See `docs/deployment/caddy.md` for origin and edge checks.

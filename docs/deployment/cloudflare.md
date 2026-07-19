# Cloudflare Edge Guidance

Use Full (strict) TLS with a valid origin certificate. Do not cache `/api/*`,
`/auth/*`, resolver routes, raw file routes, or authenticated responses.
Cache only fingerprinted static assets. Cloudflare upload limits depend on your
plan; use a DNS-only API hostname or a suitable plan when required uploads
exceed the edge limit. Restrict origin ports with a firewall and keep origin
TLS valid. Turnstile keys must be registered for the public UI hostname.

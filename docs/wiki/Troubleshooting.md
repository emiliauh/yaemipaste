# Troubleshooting

## Uploads Fail

Check:
- `VITE_PASTE_API`
- reverse proxy forwarding for `/api`
- backend upload compatibility

## Login Or Token Actions Fail

Check:
- `VITE_AUTH_API`
- backend `/auth/*` support
- installer auth admin paths
- `AUTH_ADMIN_BEARER`

## Public Preview Links Fail

Check:
- `VITE_FILE_RESOLVE_BASE`
- backend resolve route or legacy resolver setup
- public raw-file path routing

## Playwright Will Not Start

The suite starts a local Vite dev server by default. If your environment blocks localhost listeners, run the tests on a host that allows them or provide your own reachable base URL.

## Passkeys Fail

Check:
- HTTPS
- `PASSKEYS_ENABLED=1`
- RP ID and origin values
- backend passkey route support

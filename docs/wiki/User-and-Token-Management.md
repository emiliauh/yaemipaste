# User And Token Management

## First User

Use the installer:

```bash
./install.sh --action init-user
```

This supports:
- direct register flow with a registration token
- admin bootstrap flow through the configured auth admin endpoint

Typical bootstrap flow:
1. Set `AUTH_ADMIN_BEARER` and the related admin endpoint variables in `.env`.
2. Start the stack.
3. Run `./install.sh --action init-user`.
4. Use the created account to log in through the UI.

## Token Creation

```bash
./install.sh --action create-token
```

The installer sends a token creation request to the configured admin endpoint and prints the returned token.

Use tokens for:
- headless uploads
- ShareX integration
- non-interactive client access

## Token Revocation

```bash
./install.sh --action revoke-token
```

The revoke path supports `%s` substitution so the installer can inject the token value safely.

Revocation should be treated as immediate credential invalidation. Rotate any stored client configs after revoking and recreating a token.

## Required Env Values

- `AUTH_ADMIN_BASE_URL`
- `AUTH_BOOTSTRAP_PATH`
- `AUTH_TOKEN_CREATE_PATH`
- `AUTH_TOKEN_REVOKE_PATH`
- `AUTH_REGISTER_URL`
- `AUTH_ADMIN_BEARER`

## Backend Contract

These commands assume the Rust backend exposes compatible auth administration endpoints.
If your backend does not provide those routes, the installer cannot create the first user or manage tokens for you.

## Anonymous Mode

If `VITE_ENABLE_AUTH=0`:
- login and registration UI are disabled
- user bootstrap and token lifecycle are usually irrelevant
- backend auth routes may be omitted

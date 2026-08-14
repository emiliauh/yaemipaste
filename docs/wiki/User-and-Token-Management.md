# User and token management

## First user

Use the installer:

```bash
./install.sh --action init-user
```

This supports:

- Direct registration with a registration token
- Administrator bootstrap through the configured auth admin endpoint

Typical bootstrap steps:

1. Set `AUTH_ADMIN_BEARER` and the related admin endpoint variables in `.env`.
2. Start the stack.
3. Run `./install.sh --action init-user`.
4. Sign in to the UI with the created account.

## Create a token

```bash
./install.sh --action create-token
```

The installer sends a request to the configured admin endpoint. It prints the
returned token.

Use tokens for:

- Headless uploads
- ShareX
- Non-interactive clients

## Revoke a token

```bash
./install.sh --action revoke-token
```

The revoke path supports `%s`. The installer replaces it with the URL-encoded
token value.

Treat revocation as immediate credential invalidation. Rotate stored client
configuration after you revoke and recreate a token.

## Required environment values

- `AUTH_ADMIN_BASE_URL`
- `AUTH_BOOTSTRAP_PATH`
- `AUTH_TOKEN_CREATE_PATH`
- `AUTH_TOKEN_REVOKE_PATH`
- `AUTH_REGISTER_URL`
- `AUTH_ADMIN_BEARER`

## Backend contract

These commands require compatible auth administration routes in the NestJS
backend. If the backend does not provide them, the installer cannot create the
first user or manage tokens.

## Anonymous mode

If `VITE_ENABLE_AUTH=0`:

- The login and registration UI is disabled.
- User bootstrap and token lifecycle commands are usually not needed.
- The backend can omit auth routes.

## Admin panel

yaemipaste provides an admin panel at `/admin`. The Vue UI uses
`/auth/admin/*` in the NestJS backend. This panel is separate from the
installer bootstrap and token flow.

The panel manages users, uploads, settings, webhooks, and audit events. The
backend checks every route with a signed account JWT and `users.is_admin=1`.

`AUTH_ADMIN_BEARER` is an installer credential. It is not a login token for the
admin panel. Use it only for installer endpoints such as
`/auth/admin/claim/init`, `/auth/admin/bootstrap`, and `/auth/admin/tokens`.
Sign in to the UI to receive the account JWT used by `/admin` routes.

### Claim the first administrator

`install.sh` generates a one-time admin claim token when it first starts the
stack with `VITE_ENABLE_AUTH=1`. You can also request one directly:

```bash
./install.sh --action admin-claim
```

The installer prints a claim URL (`<PASTE_URL>/admin/claim`) and a one-time
token. Open the URL, enter the token, and set the first administrator's
username and password.

The token:

- Is stored only as a bcrypt hash in `admin_claims.token_hash`.
- Is not stored in the repository or client code.
- Becomes invalid when it is used. An atomic update prevents two claim attempts
  from succeeding.
- Expires after 24 hours by default. The `ttl_seconds` value in the claim-init
  request can change this period.

To create a new token, reset the current one:

```bash
./install.sh --action reset-admin-claim
```

This invalidates any unused claim token. After an administrator exists,
`claim-init` and `claim` return `409`. A reset cannot create a usable claim
token after the first administrator exists.

### Admin panel functions

- **Overview** — Disk usage, per-user usage, user and upload counts, recent
  uploads, recent audit entries, failed webhook deliveries, and storage
  warnings.
- **Users** — Create users, change administrator status, suspend users, rotate
  upload tokens, purge uploads, and delete users. The last administrator cannot
  be removed or demoted.
- **Uploads** — Browse and filter uploads, delete files, delete selected files,
  and purge expired files.
- **Settings** — Change the app name, public title, registration state, and
  storage warning threshold. Admin endpoints never return secrets in plain
  text.
- **Webhooks** — Add, enable, disable, test, and delete endpoints for events
  such as `file.uploaded`, `file.deleted`, `user.created`, `user.suspended`,
  `user.deleted`, `storage.threshold_reached`, and `admin.purge.completed`.
  Delivery runs in the background. A slow or failing endpoint does not block an
  upload or delete. Webhook secrets are stored as a hash with a masked
  preview. Signing is not implemented.
- **Audit log** — Claim, login, user, token, upload, purge, settings, webhook,
  and denied-claim events.

Destructive actions require typed confirmation. The backend validates this
confirmation. The UI is not the only validation layer.

### Known limitations

- Default retention and per-request upload-size limits remain in
  `config.toml`. The admin panel cannot change them because the backend does
  not yet reload this configuration at runtime.
- Admin mutation routes and `/auth/login` use per-client-key rate limits.
  `AUTH_ADMIN_BEARER` is used only for installer bootstrap and has no separate
  lockout.

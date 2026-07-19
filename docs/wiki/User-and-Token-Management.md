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

## Admin Panel

yaemipaste ships a full self-hosted admin panel at `/admin` (Vue) backed by
`/auth/admin/*` (Rust/Actix). It is separate from the installer's legacy
bootstrap/token flow above; the admin panel manages users, uploads, settings,
webhooks, and an audit log through the web UI, with every route enforced
server-side by a signed account JWT plus `users.is_admin=1`.

### Claiming the first administrator

`install.sh` generates a one-time admin claim token automatically the first
time it brings the stack up with `VITE_ENABLE_AUTH=1` (and whenever you ask
for one explicitly):

```bash
./install.sh --action admin-claim
```

The installer prints the claim URL (`<PASTE_URL>/admin/claim`) and a
one-time token. Open that URL, paste the token, and set a username/password
for the first administrator. The token:

- is stored server-side only as a bcrypt hash (`admin_claims.token_hash`),
  never in plaintext, and is not written anywhere in the repo or client code
- is invalidated the instant it is consumed, via an atomic
  `UPDATE ... WHERE used_at IS NULL` so two concurrent claim attempts cannot
  both succeed
- expires after 24h by default (`ttl_seconds` in the claim-init request can
  override this)

If you need a fresh token (lost the old one, want to re-run onboarding),
reset it explicitly — this invalidates any pending unused token:

```bash
./install.sh --action reset-admin-claim
```

Once an administrator exists, `claim-init`/`claim` both return `409` and no
further claim tokens are issued unless you reset again.

### What the panel covers

- **Overview** — total disk usage, per-user usage, user/upload counts,
  recent uploads, recent audit entries, failed webhook deliveries, storage
  warnings.
- **Users** — create, promote/demote admin, suspend/unsuspend, rotate
  upload tokens, purge a user's uploads, delete a user (last administrator
  cannot be removed or demoted).
- **Uploads** — browse/filter all uploads, delete individually, bulk
  delete, purge expired uploads.
- **Settings** — app name, public title, registration on/off, storage
  warning threshold. No secret is ever returned in plaintext by any admin
  endpoint.
- **Webhooks** — add/enable/disable/test/delete endpoints for events like
  `file.uploaded`, `file.deleted`, `user.created`, `user.suspended`,
  `user.deleted`, `storage.threshold_reached`, `admin.purge.completed`.
  Delivery is fire-and-forget (`actix_web::rt::spawn`) so a slow or failing
  endpoint never blocks an upload/delete. Webhook secrets are stored as a
  hash + masked preview only — signing was intentionally not implemented
  rather than keep a retrievable plaintext secret around.
- **Audit log** — claim/login, user create/delete/suspend, token
  rotation, upload/bulk delete, purge actions, settings and webhook
  changes, denied claim attempts.

Destructive actions (delete user, purge a user's uploads, purge expired
uploads, bulk delete) require typed confirmation text that is validated
**server-side**, not just in the UI.

### Known limitations

- Default retention and per-request upload-size limits remain
  `config.toml`-managed; they are not yet exposed as admin-editable DB
  settings (would need a config hot-reload path this pass didn't add).
- Admin destructive/mutating endpoints and `/auth/login` are rate-limited
  per client key; `AUTH_ADMIN_BEARER` (installer-only bootstrap bearer)
  itself has no separate lockout beyond that.

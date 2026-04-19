# yaemipaste (rustypaste-ui)

Frontend and deployment wrapper for a rustypaste-based stack with:
- file/text upload UI
- encrypted share flows
- history/actions UX
- optional auth (accounts/tokens/passkeys)
- optional Turnstile
- optional ShareX integration
- extension-free public preview routes resolved by a small Node resolver service

This repository is structured to support both:
1. **Private production deployments** (recommended first)
2. **Public open-source distribution** with configurable features

---

## Deployment modes

### 1. Authenticated mode (default)
- `VITE_ENABLE_AUTH=1`
- login/register routes enabled
- account settings (logout/passkeys/sharex) enabled
- Turnstile can be enabled with `VITE_TURNSTILE_SITE_KEY` (+ backend `TURNSTILE_SECRET_KEY`)

### 2. Anonymous public mode
- `VITE_ENABLE_AUTH=0`
- `/files` opens directly
- login/register flows disabled
- account-only controls hidden
- Turnstile/passkeys should stay disabled in this mode

---

## Quick start

### Interactive installer (recommended)
```bash
curl -fsSL "https://example.invalid/install.sh?v=latest" | bash
```

Or from source:
```bash
git clone https://github.com/emiliauh/rustypaste-ui.git
cd rustypaste-ui
./install.sh
```

For this private repository, `install.sh` defaults to cloning `https://github.com/emiliauh/rustypaste-ui.git`.

The installer now supports user-tailored setup for:
- API base paths (`VITE_PASTE_API`, `VITE_AUTH_API`)
- ShareX UI toggle (`VITE_ENABLE_SHAREX`)
- auth/login toggle (`VITE_ENABLE_AUTH`)
- Turnstile site/secret keys
- passkeys toggle and RP settings
- JWT secret generation/persistence

---

## Manual compose run

```bash
cp .env.example .env
# edit .env
docker compose up --build -d
```

See [`docs/ENVIRONMENT.md`](docs/ENVIRONMENT.md) for all variables.

The deployed stack is Rustypaste + Vite frontend + the bundled `resolver-server/`. There is no Python service in the application path.

---

## Security baseline

Current baseline in this repo:
- strict TypeScript build (`vue-tsc`)
- Playwright regression suite (`npm run test:e2e`)
- dependency audit (`npm audit --audit-level=moderate`)
- hardened installer guard rails (safe install path + explicit secret config)
- no default insecure JWT fallback in compose (`JWT_SECRET` must be set)

> Note: no software can truthfully claim “all industry standards” are fully and permanently satisfied. Treat security as continuous work: patching, review, monitoring, and periodic audits.

---

## Environment highlights

Commonly tuned values:

| Variable | Purpose | Default |
| --- | --- | --- |
| `VITE_PASTE_API` | Frontend paste API base | `/api` |
| `VITE_AUTH_API` | Frontend auth API base | `/auth` |
| `VITE_FILE_RESOLVE_BASE` | Public resolver path for extension-free file links | `/resolve` |
| `VITE_ENABLE_AUTH` | Enable login/account flows | `1` |
| `VITE_ENABLE_SHAREX` | Show ShareX config controls | `0` |
| `VITE_TURNSTILE_SITE_KEY` | Turnstile in login UI | empty |
| `TURNSTILE_SECRET_KEY` | Backend Turnstile validation | empty |
| `JWT_SECRET` | Auth JWT signing secret | required |
| `PASSKEYS_ENABLED` | Backend passkey support | `0` |
| `RESOLVER_PORT` | Local port for `resolver-server` | `3101` |

Full reference: [`docs/ENVIRONMENT.md`](docs/ENVIRONMENT.md)

---

## Validation

```bash
npm run build
npm run test:e2e
npm audit --audit-level=moderate
bash -n ./install.sh
rm -rf /tmp/rustypaste-ui-installer-smoke
git clone . /tmp/rustypaste-ui-installer-smoke
/tmp/rustypaste-ui-installer-smoke/install.sh --action install --install-dir /tmp/rustypaste-ui-installer-smoke --yes --dry-run
```

---

## Private repo handoff workflow

To publish this refactored state to a private repository:
```bash
git remote add private <your-private-repo-url>
git push private <branch-name>
```

If your private repo has a different default branch or requires GitHub CLI auth:
```bash
gh auth login
gh repo create <owner>/<repo> --private
git push -u origin <branch-name>
```

---

## Credits

- rustypaste: https://github.com/orhun/rustypaste

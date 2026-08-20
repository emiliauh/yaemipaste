import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { encryptFileWithPassword } from '../../src/lib/e2ee'
import { decodeLegacyOrModernFileToken } from '../../src/lib/fileTokens'

const APP_ORIGIN = (process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:5173').replace(/\/$/, '')
const PREVIEW_RE = /\/file\/[A-Za-z0-9_-]+\/preview$/
const ENCRYPTED_PREVIEW_RE = /\/file\/[A-Za-z0-9_-]+\/preview#[A-Za-z0-9_-]+$/
const PUBLIC_ORIGIN = 'https://paste.example.test'
const API_ORIGIN = 'https://api.example.test'

test('modern file IDs that resemble Base64 stay unchanged for resolver lookup', () => {
  expect(decodeLegacyOrModernFileToken('dGVzdA')).toBe('dGVzdA')
  expect(decodeLegacyOrModernFileToken('cGFzdGUudHh0')).toBe('paste.txt')
})

test.beforeEach(async ({ page }) => {
  await page.route('**/auth/admin/public-settings', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        app_name: 'yaemipaste',
        public_title: 'yaemipaste',
        registration_enabled: true,
        base_api_url: '',
        file_size_limit_bytes: 0,
        file_size_limit_unlimited: false,
        upload_access_mode: 'private',
        passkeys_enabled: true,
      }),
    })
  })
  // Fake test JWTs are rejected by the real dev-server backend behind the
  // /auth proxy. Reflect whichever session a test's sign-in helper set up so
  // refreshAuthAdmin()/authMe() succeed by default instead of hitting a real
  // 401 and clearing the very tokens the test just set. Tests that want to
  // exercise a genuine 401/403 register their own '**/auth/me' route, which
  // Playwright resolves before this one since it is added later.
  await page.route('**/auth/me', async (route) => {
    let session = { username: 'test-user', isAdmin: false }
    try {
      session = await page.evaluate(() => ({
        username: localStorage.getItem('rp_username') ?? sessionStorage.getItem('rp_username') ?? 'test-user',
        isAdmin: (localStorage.getItem('rp_is_admin') ?? sessionStorage.getItem('rp_is_admin')) === '1',
      }))
    } catch {
      // A client-side navigation (e.g. an admin-guard redirect) can destroy this
      // execution context mid-evaluate. That request is about to be superseded
      // by the new page anyway, so fall back rather than aborting the test.
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ username: session.username, is_admin: session.isAdmin }),
    })
  })
  // verifyStoredSession() validates a paste-token-only session with a GET to
  // /version as soon as the page loads. A custom base_api_url in some tests
  // may not even contain the literal path "/api", so this matches on the
  // "/version" suffix alone regardless of host. Without a default, this hits
  // the real dev-server backend with a fake test token on every single test.
  await page.route('**/version**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'text/plain', body: '0.0.0-test' })
  })
})

async function signInWithToken(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('rp_token', 'test-token')
    localStorage.setItem('rp_username', 'test-user')
  })
}

async function signInWithAccount(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('rp_token', 'test-token')
    localStorage.setItem('rp_username', 'test-user')
    localStorage.setItem('rp_jwt', 'test-jwt')
  })
}

async function openSettings(page: Page) {
  await page.getByRole('button', { name: 'Preferences' }).click()
  await expect(page.locator('.settings-panel')).toBeVisible()
}

async function openMobileNavigationMenu(page: Page) {
  await expect(page.getByTestId('mobile-nav-toggle')).toBeVisible()
  await expect(page.getByTestId('mobile-nav-preferences')).toBeVisible()
}

async function mockClipboard(page: Page, readValue = '') {
  await page.addInitScript((value) => {
    let written = ''
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: async () => value,
        writeText: async (text: string) => {
          written = text
        },
        __written: () => written,
      },
    })
  }, readValue)
}

async function mockClipboardWriteFailure(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: async () => '',
        writeText: async () => {
          throw new Error('Clipboard blocked')
        },
      },
    })
  })
}

function base64Url(bytes: number[]): string {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

async function mockWebAuthn(page: Page) {
  await page.addInitScript(() => {
    class MockAuthenticatorAttestationResponse {
      clientDataJSON = new Uint8Array([11, 12]).buffer
      attestationObject = new Uint8Array([13, 14]).buffer
      getTransports() {
        return ['internal']
      }
    }
    class MockAuthenticatorAssertionResponse {
      clientDataJSON = new Uint8Array([21, 22]).buffer
      authenticatorData = new Uint8Array([23, 24]).buffer
      signature = new Uint8Array([25, 26]).buffer
      userHandle = new Uint8Array([27, 28]).buffer
    }
    class MockPublicKeyCredential {
      id = 'mock-passkey'
      rawId = new Uint8Array([1, 2, 3]).buffer
      type = 'public-key'
      authenticatorAttachment = 'platform'
      response: MockAuthenticatorAttestationResponse | MockAuthenticatorAssertionResponse
      constructor(response: MockAuthenticatorAttestationResponse | MockAuthenticatorAssertionResponse) {
        this.response = response
      }
      getClientExtensionResults() {
        return {}
      }
    }
    Object.defineProperty(window, 'AuthenticatorAttestationResponse', { configurable: true, value: MockAuthenticatorAttestationResponse })
    Object.defineProperty(window, 'AuthenticatorAssertionResponse', { configurable: true, value: MockAuthenticatorAssertionResponse })
    Object.defineProperty(window, 'PublicKeyCredential', { configurable: true, value: MockPublicKeyCredential })
    Object.defineProperty(navigator, 'credentials', {
      configurable: true,
      value: {
        create: async ({ publicKey }: any) => {
          ;(window as any).__lastCreateOptions = {
            challenge: Array.from(new Uint8Array(publicKey.challenge)),
            userId: Array.from(new Uint8Array(publicKey.user.id)),
            excludeId: Array.from(new Uint8Array(publicKey.excludeCredentials[0].id)),
          }
          return new MockPublicKeyCredential(new MockAuthenticatorAttestationResponse())
        },
        get: async ({ publicKey }: any) => {
          ;(window as any).__lastGetOptions = {
            challenge: Array.from(new Uint8Array(publicKey.challenge)),
            allowId: Array.from(new Uint8Array(publicKey.allowCredentials[0].id)),
          }
          return new MockPublicKeyCredential(new MockAuthenticatorAssertionResponse())
        },
      },
    })
  })
}

async function signInAsAdmin(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('rp_token', 'admin-paste-token')
    localStorage.setItem('rp_username', 'admin-user')
    localStorage.setItem('rp_jwt', 'admin-jwt')
    localStorage.setItem('rp_is_admin', '1')
  })
}

async function mockAdminApi(page: Page, userCount = 12, includeLongUpload = false) {
  const users = Array.from({ length: userCount }, (_, index) => ({
    username: `user-${index + 1}`,
    created_at: 1_775_000_000 + index,
    is_admin: index === 0,
    suspended_at: index === 2 ? 1_775_010_000 : null,
    suspended_reason: index === 2 ? 'policy' : null,
    upload_token_preview: index % 2 === 0 ? 'tok…abcd' : '',
    upload_count: index + 1,
    disk_usage_bytes: 2048 * (index + 1),
  }))
  const uploads = Array.from({ length: includeLongUpload ? 13 : 12 }, (_, index) => {
    const longUpload = includeLongUpload && index === 12
    const fileName = longUpload
      ? 'Screenshot_20260719_131129_Chrome_with_a_really_long_filename.jpg'
      : index === 2 ? 'expiring-paste.txt.1785612876517' : `upload-${index + 1}.txt`
    return {
      path: longUpload ? 'files/long-upload.jpg' : index === 2 ? 'files/expiring-paste.txt.1785612876517' : `files/upload-${index + 1}.txt`,
      owner: longUpload ? 'Anonymous' : index === 0 ? 'user-1 (ShareX)' : index % 2 === 0 ? 'user-1' : 'user-2',
      file_name: fileName,
      display_name: index === 0 ? 'ShareX screenshot.png' : fileName,
      uploader: longUpload ? 'Anonymous' : index % 2 === 0 ? 'user-1' : 'user-2',
      source: index === 0 ? 'ShareX' : 'WebUI',
      size_bytes: 1024 * (index + 1),
      created_at: 1_775_100_000 + index,
      expires_at: index % 3 === 0 ? 1_775_200_000 + index : null,
      expired: index === 3,
      content_type: longUpload ? 'image/jpeg' : index === 2 ? null : index === 0 || index % 2 === 1 ? 'image/png' : 'text/plain',
    }
  })
  const audit = Array.from({ length: 12 }, (_, index) => ({
    id: index + 1,
    created_at: 1_775_300_000 + index,
    actor: index % 2 === 0 ? 'admin-user' : null,
    action: index % 2 === 0 ? 'settings.update' : 'upload.delete',
    target: `target-${index + 1}`,
    status: 'success',
    reason: null,
  }))
  const webhooks = [{
    id: 1,
    url: 'https://example.test/webhook',
    events: ['file.uploaded', 'file.deleted'],
    enabled: true,
    secret_configured: true,
    secret_preview: 'whsec…1234',
    created_at: 1_775_400_000,
    updated_at: 1_775_400_010,
    updated_by: 'admin-user',
  }]
  const deliveries = [{
    id: 1,
    webhook_id: 1,
    event: 'file.uploaded',
    status: 'failed',
    status_code: 500,
    error: 'timeout',
    created_at: 1_775_500_000,
    delivered_at: null,
  }]
  const settings = {
    app_name: 'yaemipaste',
    public_title: 'yaemipaste',
    registration_enabled: 'true',
    file_size_limit_bytes: '1073741824',
    file_size_limit_unlimited: 'false',
    upload_access_mode: 'private',
    passkeys_enabled: 'true',
  }

  await page.route('**/auth/admin/dashboard**', async (route) => {
    expect(route.request().headers().authorization).toBe('Bearer admin-jwt')
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        total_disk_usage_bytes: uploads.reduce((total, upload) => total + upload.size_bytes, 0),
        upload_count: uploads.length,
        user_count: users.length,
        suspended_user_count: 1,
        admin_count: 1,
        users,
        recent_uploads: uploads.slice(0, 2),
        recent_audit: audit.slice(0, 2),
        failed_webhook_deliveries: deliveries,
        config_status: { registration_enabled: true },
        warnings: ['Storage usage is above warning threshold'],
      }),
    })
  })
  await page.route('**/auth/admin/users**', async (route) => {
    expect(route.request().headers().authorization).toBe('Bearer admin-jwt')
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'created', username: 'new-user', upload_token: 'one-time-upload-token' }),
      })
      return
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(users) })
  })
  let registrationTokenList = [{
    token_ref: 'registration-ref',
    label: 'contractor invite',
    created_at: 1_774_900_000,
    expires_at: 1_775_000_000,
    revoked_at: null,
    status: 'available',
    used_by: null,
    used_at: null,
  }, {
    token_ref: 'registration-used-ref',
    label: 'old invite',
    created_at: 1_774_800_000,
    expires_at: null,
    revoked_at: null,
    status: 'used',
    used_by: 'old-user',
    used_at: 1_774_900_000,
  }]
  await page.route('**/auth/admin/registration-tokens**', async (route) => {
    expect(route.request().headers().authorization).toBe('Bearer admin-jwt')
    if (route.request().method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(registrationTokenList) })
      return
    }
    if (route.request().method() === 'DELETE') {
      expect(new URL(route.request().url()).pathname).toMatch(/\/registration-tokens\/history$/)
      registrationTokenList = registrationTokenList.filter((token) => token.status === 'available')
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ detail: 'cleared', removed: 1 }) })
      return
    }
    expect(route.request().method()).toBe('POST')
    expect(route.request().postDataJSON()).toEqual({ label: 'contractor invite', ttl_seconds: 3600 })
    // Give the newly created token its own token_ref - reusing an existing one
    // collides with that token's Vue :key and produces flaky, order-dependent
    // rendering (a stale row can survive a later re-render instead of being
    // replaced), unlike real token_refs, which are always unique sha256 hashes.
    registrationTokenList = [{ ...registrationTokenList[0], token_ref: 'registration-ref-new', label: 'contractor invite' }, ...registrationTokenList]
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ detail: 'created', token: 'single-use-registration-token', label: 'contractor invite', expires_at: 1_775_000_000 }),
    })
  })
  await page.route('**/auth/admin/registration-tokens/*', async (route) => {
    // '.../registration-tokens/history' is a distinct endpoint (clear history), handled by
    // the broader route above - without this, this route's glob also matches it and always
    // wins (Playwright resolves later-registered routes first), so the clear-history request
    // never reaches the handler that actually filters the token list.
    if (new URL(route.request().url()).pathname.endsWith('/history')) { await route.fallback(); return }
    expect(route.request().headers().authorization).toBe('Bearer admin-jwt')
    expect(route.request().method()).toBe('DELETE')
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ detail: 'revoked' }) })
  })
  await page.route('**/auth/admin/users/*/token', async (route) => {
    expect(route.request().headers().authorization).toBe('Bearer admin-jwt')
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ detail: 'rotated', upload_token: 'rotated-token' }),
    })
  })
  await page.route('**/auth/admin/users/*/purge', async (route) => {
    expect(route.request().headers().authorization).toBe('Bearer admin-jwt')
    expect(route.request().postDataJSON()).toEqual({ confirmation: 'PURGE UPLOADS' })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ detail: 'purged', bytes_removed: 4096 }),
    })
  })
  await page.route('**/auth/admin/users/*', async (route) => {
    if (/\/(token|purge)$/.test(new URL(route.request().url()).pathname)) {
      await route.fallback()
      return
    }
    expect(route.request().headers().authorization).toBe('Bearer admin-jwt')
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ detail: 'updated' }) })
  })
  await page.route('**/auth/admin/uploads**', async (route) => {
    expect(route.request().headers().authorization).toBe('Bearer admin-jwt')
    if (route.request().method() === 'DELETE') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'deleted', bytes_removed: 1024 }),
      })
      return
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(uploads) })
  })
  await page.route('**/auth/admin/uploads/bulk-delete', async (route) => {
    expect(route.request().headers().authorization).toBe('Bearer admin-jwt')
    expect(route.request().postDataJSON()).toEqual({ paths: ['files/upload-1.txt'], confirmation: 'PURGE UPLOADS' })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ deleted: 1, bytes_removed: 1024, errors: [] }),
    })
  })
  await page.route('**/auth/admin/uploads/purge-expired', async (route) => {
    expect(route.request().headers().authorization).toBe('Bearer admin-jwt')
    expect(route.request().postDataJSON()).toEqual({ confirmation: 'PURGE EXPIRED' })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ deleted: 1, bytes_removed: 4096 }),
    })
  })
  await page.route('**/auth/admin/settings**', async (route) => {
    expect(route.request().headers().authorization).toBe('Bearer admin-jwt')
    if (route.request().method() === 'PUT') {
      expect(route.request().postDataJSON()).toEqual({
        app_name: 'Verified Paste',
        public_title: 'Verified public title',
        base_api_url: '',
        registration_enabled: false,
        file_size_limit_bytes: 2147483648,
        file_size_limit_unlimited: false,
        upload_access_mode: 'public',
        passkeys_enabled: false,
        turnstile_enabled: false,
        turnstile_site_key: '',
        accent_color: '',
        logo_type: '',
        logo_preset: '',
        branding_logo: '',
      })
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          app_name: 'Verified Paste',
          public_title: 'Verified public title',
          registration_enabled: 'false',
          file_size_limit_bytes: '2147483648',
          upload_access_mode: 'public',
          passkeys_enabled: 'false',
        }),
      })
      return
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(settings) })
  })
  await page.route('**/auth/admin/webhooks/deliveries**', async (route) => {
    expect(route.request().headers().authorization).toBe('Bearer admin-jwt')
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(deliveries) })
  })
  await page.route('**/auth/admin/webhooks**', async (route) => {
    if (new URL(route.request().url()).pathname.endsWith('/deliveries')) {
      await route.fallback()
      return
    }
    expect(route.request().headers().authorization).toBe('Bearer admin-jwt')
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(webhooks) })
  })
  await page.route('**/auth/admin/audit**', async (route) => {
    expect(route.request().headers().authorization).toBe('Bearer admin-jwt')
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(audit) })
  })
}

test('public upload mode opens Files without a login', async ({ page }) => {
  await page.route('**/auth/admin/public-settings', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        app_name: 'yaemipaste',
        public_title: 'yaemipaste',
        registration_enabled: false,
        file_size_limit_bytes: 0,
        file_size_limit_unlimited: false,
        upload_access_mode: 'public',
      }),
    })
  })

  await page.goto('/')

  await expect(page).toHaveURL(/\/files$/)
  const filesNav = page.viewportSize()?.width && page.viewportSize()!.width <= 600
    ? page.getByTestId('mobile-nav-files')
    : page.getByTestId('desktop-nav-files')
  await expect(filesNav).toBeVisible()
  if (page.viewportSize()?.width && page.viewportSize()!.width <= 600) {
    await openMobileNavigationMenu(page)
    await expect(page.getByTestId('mobile-nav-preferences')).toBeVisible()
  } else {
    const loginButton = page.getByRole('button', { name: 'Log in' })
    await expect(loginButton).toBeVisible()
    const loginBox = await loginButton.boundingBox()
    const guestAccessBox = await page.locator('.guest-access').boundingBox()
    const dividerBox = await page.locator('.sidebar-divider').boundingBox()
    expect(loginBox).not.toBeNull()
    expect(guestAccessBox).not.toBeNull()
    expect(dividerBox).not.toBeNull()
    if (loginBox && guestAccessBox && dividerBox) {
      expect(loginBox.y + loginBox.height).toBeLessThan(dividerBox.y)
      expect(loginBox.width).toBe(guestAccessBox.width)
    }
  }
  await expect(page.getByRole('button', { name: 'Create account' })).toHaveCount(0)

  await page.goto('/history')
  await expect(page.getByText('History needs an account')).toBeVisible()
  await page.getByRole('button', { name: 'Log in to view history' }).click()
  await expect(page).toHaveURL(/\/login$/)
})

test('legacy history tab query canonicalizes to the history path', async ({ page }) => {
  await signInWithToken(page)
  await page.goto('/files/?tab=history')

  await expect(page).toHaveURL(/\/history$/)
  await expect(page.getByRole('heading', { name: 'History' })).toBeVisible()
})

test('guest mobile settings offers a full-width login and shows the configured API base', async ({ page }) => {
  await page.route('**/auth/admin/public-settings', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        app_name: 'yaemipaste',
        public_title: 'yaemipaste',
        registration_enabled: false,
        base_api_url: 'https://papi.example.test',
        file_size_limit_bytes: 0,
        file_size_limit_unlimited: false,
        upload_access_mode: 'public',
      }),
    })
  })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/files')
  await page.getByRole('button', { name: 'Preferences' }).click()

  const settings = page.locator('.settings-panel')
  const loginButton = settings.getByRole('button', { name: 'Log in' })
  await expect(loginButton).toBeVisible()
  await expect(settings.getByRole('button', { name: 'Logout' })).toHaveCount(0)
  await expect(page.getByLabel('Upload API base URL')).toHaveValue('https://papi.example.test')

  const loginBox = await loginButton.boundingBox()
  const dividerBox = await settings.locator('.settings-divider').boundingBox()
  expect(loginBox).not.toBeNull()
  expect(dividerBox).not.toBeNull()
  if (loginBox && dividerBox) expect(Math.abs(loginBox.width - dividerBox.width)).toBeLessThanOrEqual(2)

  await loginButton.click()
  await expect(page).toHaveURL(/\/login$/)
})

test('public registration setting offers account creation to guests', async ({ page }) => {
  await page.route('**/auth/admin/public-settings', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        app_name: 'yaemipaste',
        public_title: 'yaemipaste',
        registration_enabled: true,
        file_size_limit_bytes: 0,
        file_size_limit_unlimited: false,
        upload_access_mode: 'public',
      }),
    })
  })

  await page.goto('/history')

  // The sidebar carries guest actions on wider screens; on mobile the tab bar
  // has no room for them, so they live in the Preferences sheet.
  if ((page.viewportSize()?.width ?? 0) <= 600) {
    await openMobileNavigationMenu(page)
    await page.getByTestId('mobile-nav-preferences').click()
  }
  await expect(page.getByRole('button', { name: 'Create account' })).toBeVisible()
})

test('public guests reach the history account state instead of the login page', async ({ page }) => {
  await page.route('**/auth/admin/public-settings', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        app_name: 'yaemipaste',
        public_title: 'yaemipaste',
        registration_enabled: true,
        file_size_limit_bytes: 0,
        file_size_limit_unlimited: false,
        upload_access_mode: 'public',
      }),
    })
  })

  await page.goto('/history')

  await expect(page).toHaveURL(/\/history$/)
  const accountState = page.getByTestId('history-account-state')
  await expect(accountState).toBeVisible()
  await expect(accountState).toContainText('History needs an account')

  // A signed-out visitor gets exactly one call to action, and registration is
  // offered by the sidebar/settings rather than duplicated inside the card.
  await expect(accountState.getByRole('button')).toHaveCount(1)
  await expect(accountState.getByRole('button', { name: 'Log in to view history' })).toBeVisible()
  await expect(accountState.getByRole('button', { name: 'Create account' })).toHaveCount(0)

  // Zeroed totals would read as "you have no files" rather than "sign in".
  await expect(page.locator('.history-summary')).toHaveCount(0)

  await accountState.getByRole('button', { name: 'Log in to view history' }).click()
  await expect(page).toHaveURL(/\/login$/)
})

test('private upload mode still shows the history account state instead of redirecting to login', async ({ page }) => {
  // /history has no router-level requiresAuth: the History component gates
  // its own content via accountRequired, independent of upload_access_mode.
  await page.route('**/auth/admin/public-settings', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        app_name: 'yaemipaste',
        public_title: 'yaemipaste',
        registration_enabled: true,
        file_size_limit_bytes: 0,
        file_size_limit_unlimited: false,
        upload_access_mode: 'private',
      }),
    })
  })

  await page.goto('/history')

  await expect(page).toHaveURL(/\/history$/)
  await expect(page.getByTestId('history-account-state')).toBeVisible()
})

test('plain preview ignores a stale decryption fragment', async ({ page }) => {
  await page.route('**/api/plain-fragment.txt?raw=1', async (route) => {
    await route.fulfill({ status: 200, contentType: 'text/plain', body: 'plain preview content' })
  })
  await page.route('**/api/meta/plain-fragment.txt', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        file_name: 'plain-fragment.txt',
        display_name: 'plain-fragment.txt',
        uploader: 'Unknown',
        file_size: 21,
        mime_type: 'text/plain',
      }),
    })
  })

  const token = Buffer.from('plain-fragment.txt').toString('base64url')
  await page.goto(`/file/${token}/preview#stale-decryption-key`)

  await expect(page.getByRole('heading', { name: 'File preview' })).toBeVisible()
  await expect(page.getByText('plain preview content')).toBeVisible()
  await expect(page.getByText('This file is not a supported encrypted file')).toHaveCount(0)
})

test('raw actions use the configured server API base by default', async ({ page }) => {
  await page.route('**/auth/admin/public-settings', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        app_name: 'yaemipaste',
        public_title: 'yaemipaste',
        registration_enabled: false,
        base_api_url: 'https://papi.example.test',
        file_size_limit_bytes: 0,
        file_size_limit_unlimited: false,
        upload_access_mode: 'public',
      }),
    })
  })
  await page.route('https://papi.example.test/meta/server-api.txt', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        file_name: 'server-api.txt',
        display_name: 'server-api.txt',
        uploader: 'Unknown',
        file_size: 19,
        mime_type: 'text/plain',
      }),
    })
  })
  await page.route('https://papi.example.test/server-api.txt?raw=1', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/plain',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: 'server API raw text',
    })
  })

  const token = Buffer.from('server-api.txt').toString('base64url')
  await page.goto(`/file/${token}/preview`)

  await expect(page.getByText('server API raw text')).toBeVisible()
  await expect(page.getByRole('link', { name: 'View raw' })).toHaveAttribute('href', 'https://papi.example.test/server-api.txt?raw=1')
})

test('image previews use the configured server API base', async ({ page }) => {
  await page.route('**/auth/admin/public-settings', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        app_name: 'yaemipaste',
        public_title: 'yaemipaste',
        registration_enabled: false,
        base_api_url: 'https://papi.example.test',
        file_size_limit_bytes: 0,
        file_size_limit_unlimited: false,
        upload_access_mode: 'public',
      }),
    })
  })
  await page.route('https://papi.example.test/meta/server-image.png', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        file_name: 'server-image.png',
        display_name: 'server-image.png',
        uploader: 'Unknown',
        file_size: 68,
        mime_type: 'image/png',
      }),
    })
  })
  await page.route('https://papi.example.test/server-image.png?raw=1', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'image/png',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
    })
  })

  const token = Buffer.from('server-image.png').toString('base64url')
  await page.goto(`/file/${token}/preview`)

  await expect(page.locator('.preview-frame img')).toHaveAttribute('src', 'https://papi.example.test/server-image.png?raw=1')
})

test('View raw opens API-proxied bytes instead of the SPA shell', async ({ page }) => {
  await page.route('**/api/meta/raw-browser.txt', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        file_name: 'raw-browser.txt',
        display_name: 'raw-browser.txt',
        uploader: 'test-user',
        file_size: 16,
        mime_type: 'text/plain',
      }),
    })
  })
  await page.context().route('**/api/raw-browser.txt?raw=1', async (route) => {
    await route.fulfill({ status: 200, contentType: 'text/plain', body: 'raw browser bytes' })
  })

  const token = Buffer.from('raw-browser.txt').toString('base64url')
  await page.goto(`/file/${token}/preview`)
  await expect(page.getByText('raw browser bytes')).toBeVisible()

  const popupPromise = page.waitForEvent('popup')
  await page.getByRole('link', { name: 'View raw' }).click()
  const popup = await popupPromise
  await popup.waitForLoadState()

  await expect(popup).toHaveURL(/\/api\/raw-browser\.txt\?raw=1$/)
  await expect(popup.locator('body')).toContainText('raw browser bytes')
  await popup.close()
})

test('encrypted raw and download aliases stay in the decrypt preview flow', async ({ page }) => {
  const token = Buffer.from('private-note.txt.rpenc').toString('base64url')

  for (const mode of ['raw', 'download']) {
    await page.goto(`/file/${token}+password-salt/${mode}#decrypt-key`)
    await expect(page).toHaveURL(/\/preview#decrypt-key$/)
  }
})

test('History copies an absolute raw URL from the server API base', async ({ page }) => {
  await signInWithToken(page)
  await mockClipboard(page)
  await page.route('**/auth/admin/public-settings', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        app_name: 'yaemipaste',
        public_title: 'yaemipaste',
        registration_enabled: false,
        base_api_url: 'https://papi.example.test',
        file_size_limit_bytes: 0,
        file_size_limit_unlimited: false,
        upload_access_mode: 'public',
      }),
    })
  })
  await page.route('https://papi.example.test/list**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify([{
        file_name: 'history-server-api.txt',
        file_size: 22,
        creation_date_utc: '2026-04-20T00:00:00Z',
        expires_at_utc: null,
      }]),
    })
  })
  await page.route('https://papi.example.test/meta/history-server-api.txt', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        file_name: 'history-server-api.txt',
        display_name: 'history-server-api.txt',
        uploader: 'test-user',
        file_size: 22,
        mime_type: 'text/plain',
      }),
    })
  })
  await page.route('https://papi.example.test/history-server-api.txt?raw=1', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/plain',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: 'History raw text',
    })
  })

  await page.goto('/history')
  await page.locator('tr.file-row .filename').first().click()
  const modal = page.locator('.modal')
  await modal.getByRole('button', { name: 'More copy options' }).click()
  await modal.getByRole('menuitem', { name: /Copy raw URL/ }).click()

  await expect.poll(() => page.evaluate(() => (navigator.clipboard as any).__written())).toBe('https://papi.example.test/history-server-api.txt?raw=1')
})

async function expandExpiryIfCollapsed(page: Page) {
  await page.getByTestId('expiry-menu').waitFor({ state: 'attached' })
  const toggle = page.getByTestId('expiry-mobile-toggle')
  if (await toggle.isVisible()) await toggle.click()
  await expect(page.getByTestId('expiry-trigger')).toBeVisible()
}

function getBoundary(contentType: string): string {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2]
  if (!boundary) throw new Error('Missing multipart boundary')
  return boundary
}

function extractMultipartField(body: Buffer, contentType: string, fieldName: string): Buffer {
  const boundary = getBoundary(contentType)
  const boundaryToken = Buffer.from(`--${boundary}`)
  let offset = 0

  while (offset < body.length) {
    const partStart = body.indexOf(boundaryToken, offset)
    if (partStart === -1) break
    const headersStart = partStart + boundaryToken.length + 2
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), headersStart)
    if (headerEnd === -1) break
    const headerText = body.subarray(headersStart, headerEnd).toString('utf8')
    const valueStart = headerEnd + 4
    const valueEnd = body.indexOf(Buffer.from(`\r\n--${boundary}`), valueStart)
    if (valueEnd === -1) break
    if (headerText.includes(`name="${fieldName}"`)) {
      return body.subarray(valueStart, valueEnd)
    }
    offset = valueEnd + 2
  }

  throw new Error(`Missing multipart field "${fieldName}"`)
}

test('uses selected expiry and reflects server-side deletion after simulated time passage', async ({ page }) => {
  await signInWithToken(page)
  await mockClipboard(page)

  let uploadExpiry = ''
  let expired = false
  let uploadedEncryptedBody: Buffer | null = null
  const encryptedName = 'expiry-check.txt.rpenc'

  await page.route('**/api/', async (route) => {
    uploadExpiry = route.request().headers().expire ?? ''
    const body = route.request().postDataBuffer()
    if (!body) throw new Error('Missing upload body')
    uploadedEncryptedBody = extractMultipartField(body, route.request().headers()['content-type'] ?? '', 'file')
    await route.fulfill({
      status: 200,
      contentType: 'text/plain',
      body: `${APP_ORIGIN}/${encryptedName}`,
    })
  })

  await page.route('**/api/list**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(expired ? [] : [{
        file_name: encryptedName,
        file_size: 256,
        creation_date_utc: '2026-04-17T01:00:00Z',
        expires_at_utc: '2026-04-17T13:00:00Z',
      }]),
    })
  })

  await page.goto('/#/files')
  await expandExpiryIfCollapsed(page)
  await page.getByTestId('encrypt-toggle').click()
  await page.getByTestId('expiry-trigger').click()
  await page.getByTestId('expiry-option-12h').click()
  await page.locator('input[type="file"]').setInputFiles({
    name: 'expiry-check.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('expires soon'),
  })

  await expect.poll(() => uploadExpiry).toBe('12h')
  const shareUrl = await page.evaluate(() => (navigator.clipboard as any).__written())
  expect(shareUrl).toMatch(ENCRYPTED_PREVIEW_RE)

  await page.route('**/api/expiry-check.txt.rpenc*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/octet-stream',
      body: uploadedEncryptedBody ?? Buffer.from(''),
    })
  })

  await page.goto(shareUrl)
  await expect(page.locator('h1')).toHaveText('Encrypted paste')
  await expect(page.getByText(/expiry-check\.txt/)).toBeVisible()
  await expect(page.getByText('expires soon')).toBeVisible()
  await expect(page.getByText('This file is not a supported encrypted file')).toHaveCount(0)
  await expect(page.locator('.decrypt-toast')).toHaveCount(0)
  await expect(page.getByTestId('notification-list')).toContainText('Success')
  await expect(page.getByTestId('notification-list')).toContainText(/Decrypted in \d+\.\d seconds/)

  await page.goto('/#/files')
  await page.getByRole('button', { name: 'History' }).click()
  await expect(page.getByText('expiry-check.txt')).toBeVisible()

  expired = true
})

test('upload shows progress and leaves a share link', async ({ page }) => {
  await signInWithToken(page)
  await mockClipboard(page)

  await page.route('**/api/', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 400))
    await route.fulfill({
      status: 200,
      contentType: 'text/plain',
      body: `${APP_ORIGIN}/progress-check.bin`,
    })
  })

  await page.goto('/#/files')
  await page.locator('input[type="file"]').setInputFiles({
    name: 'progress-check.bin',
    mimeType: 'application/octet-stream',
    buffer: Buffer.alloc(1024 * 1024 * 3, 7),
  })

  await expect(page.getByTestId('upload-progress')).toBeVisible()
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuemax', '100')
  await expect(page.getByText('Latest share link')).toBeVisible()
  await expect(page.getByText(/\/file\/[A-Za-z0-9_-]+\/preview/)).toBeVisible()
  await expect(page.getByTestId('upload-progress')).toBeHidden()
})

test('upload accepts server short-path responses without surfacing an error', async ({ page }) => {
  await signInWithToken(page)
  await mockClipboard(page)

  await page.route('**/api/', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/plain',
      body: `${APP_ORIGIN}/server-id/file.txt`,
    })
  })

  await page.goto('/#/files')
  await page.locator('input[type="file"]').setInputFiles({
    name: 'server-id.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('short path'),
  })

  await expect(page.getByTestId('notification-list')).toContainText('Uploaded & copied: server-id.txt')
  await expect(page.getByTestId('notification-list')).not.toContainText('Error')
  await expect(page.getByTestId('share-row')).toContainText('/file/')
  await expect(page.getByTestId('share-row')).toContainText('/preview')
  await expect.poll(() => page.evaluate(() => (navigator.clipboard as any).__written())).toMatch(PREVIEW_RE)
})

test('latest share link shows preview URL and copy button for uploaded images', async ({ page }) => {
  await signInWithToken(page)
  await mockClipboard(page)
  const uploadedName = 'toggle-image.png'
  const token = Buffer.from(uploadedName).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
  await page.route('**/api/', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/plain',
      body: `${APP_ORIGIN}/file/${token}/preview`,
    })
  })

  await page.goto('/#/files')
  await page.locator('input[type="file"]').setInputFiles({
    name: uploadedName,
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7fM7cAAAAASUVORK5CYII=',
      'base64',
    ),
  })

  const shareRow = page.getByTestId('share-row').first()
  await expect(shareRow.locator('a')).toContainText('/file/')
  await expect(shareRow.getByTestId('share-link-mode-toggle')).toHaveCount(0)
  await expect(page.locator('.share-result img, .share-result video')).toHaveCount(0)
  await shareRow.getByRole('button', { name: 'Copy' }).click()
  await expect.poll(() => page.evaluate(() => (navigator.clipboard as any).__written())).toContain('/file/')
})

test('latest share link shows preview URL and copy button for uploaded videos', async ({ page }) => {
  await signInWithToken(page)
  await mockClipboard(page)
  const uploadedName = 'toggle-video.mp4'
  const token = Buffer.from(uploadedName).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
  await page.route('**/api/', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/plain',
      body: `${APP_ORIGIN}/file/${token}/preview`,
    })
  })

  await page.goto('/#/files')
  await page.locator('input[type="file"]').setInputFiles({
    name: uploadedName,
    mimeType: 'video/mp4',
    buffer: Buffer.from('fake-video'),
  })

  const shareRow = page.getByTestId('share-row').first()
  await expect(shareRow.locator('a')).toContainText('/file/')
  await expect(shareRow.getByTestId('share-link-mode-toggle')).toHaveCount(0)
})

test('upload shows a clear error when API returns JSON instead of a file URL', async ({ page }) => {
  await signInWithToken(page)
  await mockClipboard(page)

  await page.route('**/api/', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'ok', message: 'legacy api root' }),
    })
  })

  await page.goto('/#/files')
  await page.locator('input[type="file"]').setInputFiles({
    name: 'bad-upload-response.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('bad response'),
  })

  await expect(page.getByTestId('notification-list')).toContainText('Upload endpoint returned unexpected JSON')
  await expect(page.getByTestId('share-row')).toHaveCount(0)
})

test('upload success stays successful when clipboard copy is blocked', async ({ page }) => {
  await signInWithToken(page)
  await mockClipboardWriteFailure(page)

  await page.route('**/api/', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/plain',
      body: `${APP_ORIGIN}/copy-blocked.txt`,
    })
  })

  await page.goto('/#/files')
  await page.locator('input[type="file"]').setInputFiles({
    name: 'copy-blocked.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('copy blocked'),
  })

  await expect(page.getByTestId('notification-row')).toContainText('Success')
  await expect(page.getByTestId('notification-row')).toContainText('Uploaded: copy-blocked.txt. Copy the link below.')
  await expect(page.getByTestId('notification-row')).not.toContainText('Error')
  await expect(page.getByTestId('share-row')).toContainText('/file/')
  await expect(page.getByTestId('share-row')).toContainText('/preview')
})

test('mobile upload feedback stays inside the viewport and away from bottom controls', async ({ page }) => {
  await signInWithToken(page)
  await mockClipboard(page)
  await page.setViewportSize({ width: 390, height: 844 })

  await page.route('**/api/', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/plain',
      body: `${APP_ORIGIN}/mobile-feedback-check.txt`,
    })
  })

  await page.goto('/#/files')
  await page.locator('input[type="file"]').setInputFiles({
    name: 'mobile-feedback-check.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('mobile'),
  })

  await expect(page.getByTestId('share-row')).toBeVisible()
  await expect(page.getByTestId('notification-row')).toBeVisible()
  await expect(page.getByTestId('expiry-mobile-toggle')).toBeVisible()
  await expect(page.getByTestId('expiry-panel')).toBeHidden()
  const shareBox = await page.getByTestId('share-row').boundingBox()
  const notificationBox = await page.getByTestId('notification-row').boundingBox()
  const tabbarBox = await page.getByTestId('mobile-tabbar').boundingBox()
  expect(shareBox).not.toBeNull()
  expect(notificationBox).not.toBeNull()
  expect(tabbarBox).not.toBeNull()
  if (shareBox && notificationBox && tabbarBox) {
    expect(shareBox.x).toBeGreaterThanOrEqual(0)
    expect(shareBox.x + shareBox.width).toBeLessThanOrEqual(390)
    expect(notificationBox.x).toBeGreaterThanOrEqual(0)
    expect(notificationBox.x + notificationBox.width).toBeLessThanOrEqual(390)
    expect(notificationBox.y + notificationBox.height).toBeLessThan(tabbarBox.y)
    expect(shareBox.y + shareBox.height).toBeLessThan(tabbarBox.y)
  }

  await page.getByTestId('expiry-mobile-toggle').click()
  await expect(page.getByTestId('expiry-panel')).toBeVisible()
  await page.getByTestId('expiry-collapse').click()
  await expect(page.getByTestId('expiry-panel')).toBeHidden()
})

test('mobile expiry options stay reachable below their trigger', async ({ page }) => {
  await signInWithToken(page)
  for (const viewport of [
    { width: 320, height: 640 },
    { width: 360, height: 800 },
    { width: 390, height: 844 },
    { width: 412, height: 915 },
  ]) {
    await page.setViewportSize(viewport)
    await page.goto('/#/files')
    await expandExpiryIfCollapsed(page)
    const trigger = page.getByTestId('expiry-trigger')
    await trigger.click()
    const options = page.getByTestId('expiry-options')
    await expect(options).toBeVisible()
    const triggerBox = await trigger.boundingBox()
    const optionsBox = await options.boundingBox()
    expect(triggerBox).not.toBeNull()
    expect(optionsBox).not.toBeNull()
    if (triggerBox && optionsBox) {
      expect(optionsBox.y).toBeGreaterThanOrEqual(triggerBox.y + triggerBox.height)
      expect(optionsBox.x).toBeGreaterThanOrEqual(0)
      expect(optionsBox.x + optionsBox.width).toBeLessThanOrEqual(viewport.width)
    }
    await page.getByTestId('expiry-option-7d').focus()
    await expect(page.getByTestId('expiry-option-7d')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(options).toBeHidden()
  }
})

test('collapsed mobile expiry selector does not paint over upload content', async ({ page }) => {
  await signInWithToken(page)
  for (const viewport of [
    { width: 360, height: 800 },
    { width: 390, height: 844 },
    { width: 412, height: 915 },
  ]) {
    await page.setViewportSize(viewport)
    await page.goto('/#/files')
    const panel = page.getByTestId('expiry-panel')
    await expect(panel).toBeHidden()
    await expect(panel.getByText('KEEP FOR', { exact: false })).toBeHidden()
    await page.getByTestId('expiry-mobile-toggle').click()
    await expect(panel).toBeVisible()
    await page.getByTestId('expiry-collapse').click()
    await expect(panel).toBeHidden()
  }
})

test('mobile navigation keeps primary cells and detached settings within bounds', async ({ page }) => {
  await signInAsAdmin(page)
  await mockAdminApi(page)
  for (const viewport of [
    { width: 320, height: 640 },
    { width: 360, height: 800 },
    { width: 390, height: 844 },
    { width: 412, height: 915 },
  ]) {
    await page.setViewportSize(viewport)
    await page.goto('/#/files')
    const controls = page.locator('.mobile-tabbar-main [data-testid^="mobile-nav-"]')
    await expect(controls).toHaveCount(3)
    const labelStates = await page.locator('.mobile-tabbar-main .mobile-tab-label').evaluateAll((labels) => labels.map((label) => ({
      text: label.textContent?.trim(),
      opacity: getComputedStyle(label).opacity,
    })))
    expect(labelStates.filter(({ opacity }) => Number(opacity) > 0)).toHaveLength(1)
    expect(labelStates.find(({ text }) => text === 'Files')?.opacity).toBe('1')
    const boxes = await controls.evaluateAll((items) => items.map((item) => {
      const rect = item.getBoundingClientRect()
      const children = [...item.querySelectorAll<HTMLElement>('span, svg')].map((child) => {
        const childRect = child.getBoundingClientRect()
        return { left: childRect.left, right: childRect.right }
      })
      return { left: rect.left, right: rect.right, width: rect.width, children }
    }))
    expect(new Set(boxes.map((box) => Math.round(box.width))).size).toBe(1)
    expect(boxes[0].left).toBeGreaterThanOrEqual(0)
    expect(boxes.at(-1)!.right).toBeLessThanOrEqual(viewport.width)
    for (const box of boxes) {
      for (const child of box.children) {
        expect(child.left).toBeGreaterThanOrEqual(box.left)
        expect(child.right).toBeLessThanOrEqual(box.right)
      }
    }
    const visibleContentBox = await page.locator('.upload-zone').boundingBox()
    expect(visibleContentBox).not.toBeNull()
    await openMobileNavigationMenu(page)
    const tabbarBox = await page.getByTestId('mobile-tabbar').boundingBox()
    if (tabbarBox && visibleContentBox) {
      expect(tabbarBox.x).toBeGreaterThanOrEqual(0)
      expect(tabbarBox.x + tabbarBox.width).toBeLessThanOrEqual(viewport.width)
      expect(tabbarBox.height).toBeLessThanOrEqual(124)
    }
    await page.getByTestId('mobile-nav-preferences').click()
    const settingsPanel = page.locator('.settings-panel')
    await expect(settingsPanel).toBeVisible()
    const settingsPanelBox = await settingsPanel.boundingBox()
    expect(settingsPanelBox).not.toBeNull()
    if (settingsPanelBox && tabbarBox) {
      expect(settingsPanelBox.x).toBeCloseTo(tabbarBox.x, 1)
      expect(settingsPanelBox.x + settingsPanelBox.width).toBeCloseTo(tabbarBox.x + tabbarBox.width, 1)
    }
    expect(await settingsPanel.evaluate((element) => Number.parseFloat(getComputedStyle(element).borderTopLeftRadius))).toBeGreaterThanOrEqual(15)
    await page.getByTestId('settings-layer').locator('.overlay').click({ position: { x: 8, y: 8 } })
    await expect(page.getByTestId('settings-layer')).toBeHidden()
    await expect.poll(() => page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth))).toBeLessThanOrEqual(viewport.width)
  }
})

test('mobile repository link appears inside the centered Settings footer', async ({ page }) => {
  await signInWithToken(page)
  await page.setViewportSize({ width: 320, height: 640 })
  await page.goto('/#/files')

  await expect(page.locator('.github-link')).toHaveCount(0)
  await openMobileNavigationMenu(page)
  await page.getByTestId('mobile-nav-preferences').click()
  const panel = page.locator('.settings-panel')
  const footer = page.locator('.settings-footer')
  const repository = page.getByTestId('settings-github-link')
  await expect(footer).toBeVisible()
  await expect(repository).toBeVisible()
  await expect.poll(() => panel.evaluate((element) => getComputedStyle(element).transform)).toBe('none')
  const panelBox = await panel.boundingBox()
  const visibleContentBox = await page.locator('.upload-zone').boundingBox()
  const tabbarBox = await page.getByTestId('mobile-tabbar').boundingBox()
  expect(panelBox).not.toBeNull()
  expect(visibleContentBox).not.toBeNull()
  expect(tabbarBox).not.toBeNull()
    if (panelBox && visibleContentBox && tabbarBox) {
      expect(panelBox.x).toBeCloseTo(tabbarBox.x, 1)
      expect(panelBox.x + panelBox.width).toBeCloseTo(tabbarBox.x + tabbarBox.width, 1)
  }
  const repositoryBox = await repository.boundingBox()
  const labelBox = await footer.getByText('yaemipaste').boundingBox()
  expect(repositoryBox).not.toBeNull()
  expect(labelBox).not.toBeNull()
  if (repositoryBox && labelBox) {
    expect(repositoryBox.x + repositoryBox.width).toBeLessThan(labelBox.x)
    expect(Math.abs((repositoryBox.y + repositoryBox.height / 2) - (labelBox.y + labelBox.height / 2))).toBeLessThanOrEqual(1)
  }
})

test('audit records are readable cards on mobile', async ({ page }) => {
  await signInAsAdmin(page)
  await mockAdminApi(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/admin')
  await page.getByRole('button', { name: 'Audit', exact: true }).click()
  const auditTable = page.locator('.admin-table').filter({ hasText: 'settings.update' })
  await expect(auditTable).toBeVisible()
  await expect(auditTable).toContainText('settings.update')
  await expect.poll(() => page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth))).toBeLessThanOrEqual(390)
})

for (const viewport of [
  { name: 'desktop', width: 1280, height: 720 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`encrypt button cycles modes on ${viewport.name}`, async ({ page }) => {
    await signInWithToken(page)
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await page.goto('/#/files')
    await expect(page.getByTestId('encrypt-toggle')).toContainText('Encryption off')
    await expect(page.getByTestId('keep-name-toggle')).toContainText('Keep original name')
    await page.getByTestId('encrypt-toggle').click()
    await expect(page.getByTestId('encrypt-toggle')).toContainText('Encrypted link')
    await page.getByTestId('encrypt-toggle').click()
    await expect(page.getByTestId('encrypt-toggle')).toContainText('Password protected')
    await page.getByTestId('encrypt-toggle').click()
    await expect(page.getByTestId('encrypt-toggle')).toContainText('Encryption off')
  })
}

test('files password field toggles visibility in password-encrypt mode', async ({ page }) => {
  await signInWithToken(page)
  await page.goto('/#/files')
  await page.getByTestId('encrypt-toggle').click()
  await page.getByTestId('encrypt-toggle').click()

  const passwordField = page.locator('input[autocomplete="new-password"]')
  await expect(passwordField).toHaveAttribute('type', 'password')
  await page.getByRole('button', { name: 'Show password' }).click()
  await expect(passwordField).toHaveAttribute('type', 'text')
  await page.getByRole('button', { name: 'Hide password' }).click()
  await expect(passwordField).toHaveAttribute('type', 'password')
})

test('theme controls persist explicit choices and system mode follows the OS preference', async ({ page }) => {
  await signInWithToken(page)
  await page.emulateMedia({ colorScheme: 'dark' })

  await page.goto('/#/files')
  const isCompact = (page.viewportSize()?.width ?? 1280) <= 600
  const themeTestId = (mode: string) => (isCompact ? `settings-theme-${mode}` : `theme-${mode}`)
  const themeControl = (mode: string) => page.getByTestId(themeTestId(mode)).filter({ visible: true })
  const openThemeControls = async () => {
    if (isCompact) await page.getByRole('button', { name: 'Preferences' }).click()
  }

  await openThemeControls()
  await expect(themeControl('system')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')

  await themeControl('light').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('rp_theme_mode'))).toBe('light')

  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await openThemeControls()
  await expect(themeControl('light')).toHaveAttribute('aria-pressed', 'true')

  await themeControl('system').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('rp_theme_mode'))).toBe('system')
})

for (const viewport of [
  { name: 'desktop', width: 1280, height: 720, touch: false },
  { name: 'tablet', width: 768, height: 1024, touch: true },
  { name: 'mobile', width: 390, height: 844, touch: true },
]) {
  test(`keep-for menu closes on outside interaction on ${viewport.name}`, async ({ page }) => {
    await signInWithToken(page)
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await page.goto('/#/files')

    await expandExpiryIfCollapsed(page)
    await page.getByTestId('expiry-trigger').click()
    await expect(page.getByTestId('expiry-options')).toBeVisible()

    await page.evaluate((touch) => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        clientX: 12,
        clientY: 12,
        pointerType: touch ? 'touch' : 'mouse',
      }))
    }, viewport.touch)

    await expect(page.getByTestId('expiry-options')).toBeHidden()
  })
}

test('multi-file upload keeps encryption state per action and does not overwrite links', async ({ page }) => {
  await signInWithToken(page)
  await mockClipboard(page)
  const uploadedNames: string[] = []
  let uploadCount = 0

  await page.route('**/api/', async (route) => {
    const body = route.request().postDataBuffer()
    if (!body) throw new Error('Missing upload body')
    const content = body.toString('latin1')
    const fileName = content.match(/filename="([^"]+)"/)?.[1] ?? ''
    uploadedNames.push(fileName)
    uploadCount += 1
    await new Promise((resolve) => setTimeout(resolve, 120))
    const fileId = uploadCount === 1 ? 'multi-first' : 'multi-second'
    await route.fulfill({
      status: 200,
      contentType: 'text/plain',
      body: `${APP_ORIGIN}/${fileId}.txt.rpenc`,
    })
  })

  await page.goto('/#/files')
  const encryptToggle = page.getByTestId('encrypt-toggle')
  await encryptToggle.click()
  await page.locator('input[type="file"]').setInputFiles([
    {
      name: 'alpha.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('alpha'),
    },
    {
      name: 'beta.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('beta'),
    },
  ])
  await encryptToggle.click()
  await encryptToggle.click()

  await expect.poll(() => uploadedNames.length).toBe(2)
  expect(uploadedNames.every((name) => name.endsWith('.rpenc'))).toBeTruthy()
  await expect(page.getByTestId('share-row')).toHaveCount(2)
  await expect(page.getByTestId('notification-row')).toHaveCount(2)
  await expect(page.getByTestId('notification-list')).toContainText('alpha.txt')
  await expect(page.getByTestId('notification-list')).toContainText('beta.txt')
})

test('keep file name toggle randomizes encrypted URL while keeping original decrypted name', async ({ page }) => {
  await signInWithToken(page)
  await mockClipboard(page)
  let uploadedEncryptedBody: Buffer | null = null
  let keepFileNameMeta = false
  let uploadSourceMeta = ''

  await page.route('**/api/', async (route) => {
    const body = route.request().postDataBuffer()
    if (!body) throw new Error('Missing upload body')
    const contentType = route.request().headers()['content-type'] ?? ''
    uploadedEncryptedBody = extractMultipartField(body, contentType, 'file')
    const parsedMeta = JSON.parse(extractMultipartField(body, contentType, 'meta').toString('utf8')) as { keepFileName?: boolean; source?: string }
    keepFileNameMeta = parsedMeta.keepFileName === true
    uploadSourceMeta = parsedMeta.source ?? ''
    await route.fulfill({
      status: 200,
      contentType: 'text/plain',
      body: `${APP_ORIGIN}/9q2f77m.rpenc`,
    })
  })

  await page.goto('/#/files')
  await page.getByTestId('encrypt-toggle').click()
  await page.getByTestId('keep-name-toggle').locator('input').uncheck()
  await page.locator('input[type="file"]').setInputFiles({
    name: 'original-name.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('hello from original'),
  })

  await expect.poll(() => keepFileNameMeta).toBe(false)
  await expect.poll(() => uploadSourceMeta).toBe('WebUI')
  let shareUrl = await page.evaluate(() => (navigator.clipboard as any).__written())
  if (!shareUrl) {
    shareUrl = (await page.locator('[data-testid="share-row"] a').first().textContent()) ?? ''
  }
  expect(shareUrl).not.toBe('')
  expect(shareUrl).not.toContain('original-name')
  expect(shareUrl).toMatch(ENCRYPTED_PREVIEW_RE)
  await page.route('**/*.rpenc*', async (route) => {
    if (route.request().resourceType() === 'document') {
      await route.fallback()
      return
    }
    await route.fulfill({ status: 200, contentType: 'application/octet-stream', body: uploadedEncryptedBody ?? Buffer.from('') })
  })

  await page.goto(shareUrl)
  await expect(page.locator('h1')).toHaveText('Encrypted paste')
  await expect(page.getByText(/original-name\.txt/)).toBeVisible()
})

test('encrypted decrypt success uses auto-clearing notification on mobile', async ({ page }) => {
  await signInWithToken(page)
  await mockClipboard(page)
  await page.setViewportSize({ width: 390, height: 844 })
  let uploadedEncryptedBody: Buffer | null = null

  await page.route('**/api/', async (route) => {
    const body = route.request().postDataBuffer()
    if (!body) throw new Error('Missing upload body')
    uploadedEncryptedBody = extractMultipartField(body, route.request().headers()['content-type'] ?? '', 'file')
    await route.fulfill({
      status: 200,
      contentType: 'text/plain',
      body: `${APP_ORIGIN}/mobile-decrypt.txt.rpenc`,
    })
  })

  await page.goto('/#/files')
  await page.getByTestId('encrypt-toggle').click()
  await page.locator('input[type="file"]').setInputFiles({
    name: 'mobile-decrypt.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('mobile decrypt content'),
  })

  let shareUrl = await page.evaluate(() => (navigator.clipboard as any).__written())
  if (!shareUrl) {
    shareUrl = (await page.locator('[data-testid="share-row"] a').first().textContent()) ?? ''
  }
  await page.route('**/api/mobile-decrypt.txt.rpenc*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/octet-stream',
      body: uploadedEncryptedBody ?? Buffer.from(''),
    })
  })

  await page.goto(shareUrl)
  await expect(page.getByText('mobile decrypt content')).toBeVisible()
  await expect(page.locator('.decrypt-toast')).toHaveCount(0)
  await expect(page.getByTestId('notification-list')).toContainText(/Decrypted in \d+\.\d seconds/)

  const notification = page.getByTestId('notification-row').last()
  const toggle = notification.getByTestId('notification-toggle')
  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  let notificationBox = await notification.boundingBox()
  expect(notificationBox).not.toBeNull()
  if (notificationBox) {
    expect(notificationBox.width).toBeLessThanOrEqual(321)
    expect(notificationBox.y).toBeGreaterThan(viewport.height / 2)
  }

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  notificationBox = await notification.boundingBox()
  expect(notificationBox).not.toBeNull()
  if (notificationBox) {
    expect(notificationBox.width).toBeLessThanOrEqual(321)
    expect(notificationBox.y).toBeGreaterThan(viewport.height / 2)
    expect(notificationBox.y + notificationBox.height).toBeLessThanOrEqual(viewport.height)
  }

  await expect(notification.getByRole('button', { name: 'Dismiss notification' })).toBeVisible()
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByTestId('notification-row')).toHaveCount(0, { timeout: 5000 })
})

test('public preview page shows metadata and download action', async ({ page }) => {
  await signInWithAccount(page)
  await page.route('**/api/meta/preview-check.txt', async (route) => {
    expect(route.request().headers().authorization).toBeUndefined()
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        file_name: 'preview-check.txt',
        display_name: 'Invoice-April.txt',
        uploader: 'test-user (ShareX)',
        source: 'ShareX',
        upload_date_utc: '2026-04-17T01:00:00Z',
        download_name: 'Invoice-April.txt',
        file_size: 12,
        mime_type: 'text/plain',
      }),
    })
  })
  await page.route('**/api/preview-check.txt?raw=1', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/plain',
      body: 'preview content',
    })
  })
  await page.route('**/api/preview-check.txt?download=true', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/plain',
      headers: { 'Content-Disposition': 'attachment; filename="Invoice-April.txt"' },
      body: 'download content',
    })
  })

  await page.goto('/#/preview?p=/preview-check/file.txt')
  await expect(page.getByText('Invoice-April.txt')).toBeVisible()
  await expect(page.getByText('2026-04-17T01:00:00Z')).toBeVisible()
  await expect(page.locator('.preview-owner')).toContainText('test-user')
  await expect(page.getByLabel('Uploaded with ShareX')).toBeVisible()
  await expect(page.getByLabel('Uploaded with ShareX')).toHaveCSS('text-transform', 'none')
  await expect(page.getByText('(ShareX)', { exact: true })).toHaveCount(0)
  await expect(page.getByText('preview content')).toBeVisible()
  const downloadLink = page.getByRole('link', { name: 'Download file' })
  await expect(downloadLink).toHaveAttribute('href', '/api/preview-check.txt?download=true')
  const downloadPromise = page.waitForEvent('download', { timeout: 10_000 })
  await downloadLink.click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('Invoice-April.txt')
  const downloadPath = await download.path()
  expect(downloadPath).not.toBeNull()
  if (downloadPath) expect(await readFile(downloadPath, 'utf8')).toBe('download content')
})

test('public preview labels an unknown token uploader as Anonymous', async ({ page }) => {
  await signInWithToken(page)
  await page.route('**/api/meta/owner-fallback.txt', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        file_name: 'owner-fallback.txt',
        display_name: 'owner-fallback.txt',
        uploader: 'Unknown (token user)',
        upload_date_utc: '2026-04-17T01:00:00Z',
        download_name: 'owner-fallback.txt',
        file_size: 7,
        mime_type: 'text/plain',
      }),
    })
  })
  await page.route('**/api/owner-fallback.txt?raw=1', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/plain',
      body: 'preview',
    })
  })

  await page.goto('/#/preview?p=/owner-fallback/file.txt')
  await expect(page.getByText('Anonymous', { exact: true })).toBeVisible()
  await expect(page.getByText('test-user', { exact: true })).toHaveCount(0)
})

test('upload preview download and delete work as one public-file flow', async ({ page }) => {
  await signInWithToken(page)
  await mockClipboard(page)

  const fileName = 'flow-e2e.txt'
  const body = 'full flow content'
  let deleted = false
  let deleteAuth = ''

  await page.route('**/api/', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ url: `${APP_ORIGIN}/flow-e2e/file.txt` }),
    })
  })
  await page.route(`**/api/meta/${fileName}`, async (route) => {
    if (deleted) {
      await route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        file_name: fileName,
        display_name: fileName,
        uploader: 'test-user',
        upload_date_utc: '2026-04-17T01:00:00Z',
        download_name: fileName,
        file_size: body.length,
        mime_type: 'text/plain',
      }),
    })
  })
  await page.route(`**/api/${fileName}?raw=1`, async (route) => {
    await route.fulfill({ status: deleted ? 404 : 200, contentType: 'text/plain', body: deleted ? 'not found' : body })
  })
  await page.route(`**/api/${fileName}?download=true`, async (route) => {
    await route.fulfill({
      status: deleted ? 404 : 200,
      contentType: 'text/plain',
      headers: { 'Content-Disposition': `attachment; filename="${fileName}"` },
      body: deleted ? 'not found' : body,
    })
  })
  await page.route('**/api/list**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(deleted ? [] : [{
        file_name: fileName,
        file_size: body.length,
        creation_date_utc: '2026-04-17T01:00:00Z',
        expires_at_utc: null,
      }]),
    })
  })
  await page.route(`**/api/${fileName}`, async (route) => {
    deleteAuth = route.request().headers().authorization ?? ''
    deleted = true
    await route.fulfill({ status: 204, body: '' })
  })

  await page.goto('/#/files')
  await page.locator('input[type="file"]').setInputFiles({
    name: fileName,
    mimeType: 'text/plain',
    buffer: Buffer.from(body),
  })

  const shareLink = page.getByTestId('share-row').locator('a').first()
  await expect(shareLink).toHaveText(/\/file\/[A-Za-z0-9_-]+\/preview/)
  const href = await shareLink.getAttribute('href')
  expect(href).toMatch(PREVIEW_RE)

  await page.goto(href ?? '/')
  await expect(page).toHaveURL(/\/file\/[A-Za-z0-9_-]+\/preview/)
  await expect(page.getByRole('heading', { name: 'File preview' })).toBeVisible()
  await expect(page.locator('.text-preview')).toContainText(body)

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Download file' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe(fileName)

  await page.goto('/#/files')
  await page.getByRole('button', { name: 'History' }).click()
  const fileRow = page.locator('tr.file-row', { hasText: fileName }).first()
  await expect(fileRow).toBeVisible()
  await fileRow.getByRole('button', { name: 'More' }).click()
  await fileRow.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect.poll(() => deleteAuth).toBe('test-token')
  await expect(page.locator('tr.file-row').filter({ hasText: fileName })).toHaveCount(0)

})

test('preview open action prefers app-open download for sxcu files', async ({ page }) => {
  await page.route('**/api/meta/sharex-config.sxcu', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        file_name: 'sharex-config.sxcu',
        display_name: 'yaemipaste.sxcu',
        uploader: 'test-user',
        upload_date_utc: '2026-04-17T01:00:00Z',
        download_name: 'yaemipaste.sxcu',
        file_size: 1200,
        mime_type: 'application/json',
      }),
    })
  })
  await page.route('**/sharex-config/file.sxcu', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{}',
    })
  })

  await page.goto('/#/preview?p=/sharex-config/file.sxcu')
  await expect(page.getByText('No preview available for this file type.')).toBeVisible()
  const openButton = page.getByRole('link', { name: 'Open in app' })
  await expect(openButton).toHaveAttribute('href', /\/file\/[A-Za-z0-9_-]+\/download$/)
})

test('sharex config sanitizes unsupported uploader syntax placeholders', async ({ page }) => {
  await signInWithAccount(page)
  await page.goto('/#/files')
  await openSettings(page)
  const sharexButton = page.getByRole('button', { name: 'Download .sxcu' })
  test.skip(await sharexButton.count() === 0 || await sharexButton.isDisabled(), 'ShareX integration disabled in this build')
  await page.route('**/auth/sharex', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        RequestMethod: 'POST',
        URL: `${API_ORIGIN}/`,
        Headers: { Authorization: '$jwt$' },
        Arguments: {
          uploader: '$uploader()$',
          note: '$uploader(test)$',
          direct: '%uploader%',
          meta: '{"uploader":"$uploader()$","source":"ShareX"}',
        },
      }),
    })
  })

  const downloadPromise = page.waitForEvent('download')
  await sharexButton.click()
  const download = await downloadPromise
  const downloadPath = test.info().outputPath('sharex-config.sxcu')
  await download.saveAs(downloadPath)
  const generated = await readFile(downloadPath, 'utf8')
  const parsed = JSON.parse(generated) as Record<string, any>
  const args = parsed.Arguments ?? {}
  expect(args.uploader).toBe('test-user')
  expect(args.source).toBe('ShareX')
  expect(Object.prototype.hasOwnProperty.call(args, 'meta')).toBeFalsy()
  expect(args.note).toBe('test-user')
  expect(args.direct).toBe('test-user')
  expect(JSON.stringify(parsed)).not.toContain('uploader(')
  expect(parsed.Headers['X-Upload-Client']).toBe('ShareX')
})

test('sharex config extracts ids from newline-terminated public upload responses', async ({ page }) => {
  await signInWithAccount(page)
  await page.goto('/#/files')
  await openSettings(page)
  const sharexButton = page.getByRole('button', { name: 'Download .sxcu' })
  test.skip(await sharexButton.count() === 0 || await sharexButton.isDisabled(), 'ShareX integration disabled in this build')
  await page.route('**/auth/sharex', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        RequestMethod: 'POST',
        URL: `${API_ORIGIN}/`,
        Headers: { Authorization: '$jwt$' },
      }),
    })
  })

  const downloadPromise = page.waitForEvent('download')
  await sharexButton.click()
  const download = await downloadPromise
  const downloadPath = test.info().outputPath('sharex-config-trimmed.sxcu')
  await download.saveAs(downloadPath)
  const generated = await readFile(downloadPath, 'utf8')
  const parsed = JSON.parse(generated) as Record<string, any>
  const uploadResponseMatcher = /^(?:https?:\/\/[^/]+\/)?(?:file\/)?([A-Za-z0-9_-]+)/
  expect(parsed.URL).toMatch(/^https?:\/\/[^/]+\/file\//)
  expect(parsed.URL).toContain('{regex:^(?:https?://[^/]+/)?(?:file/)?([A-Za-z0-9_-]+)|1}/preview')
  expect((parsed.URL.match(/\|/g) ?? []).length).toBe(1)
  expect('https://paste.example.test/AbCd1234/file.png\n'.match(uploadResponseMatcher)?.[1]).toBe('AbCd1234')
  expect('https://paste.example.test/AbCd1234/file.tar.gz\n'.match(uploadResponseMatcher)?.[1]).toBe('AbCd1234')
  expect('https://paste.example.test/file/AbCd1234/preview?from=sharex\n'.match(uploadResponseMatcher)?.[1]).toBe('AbCd1234')
  const args = parsed.Arguments ?? {}
  expect(args.source).toBe('ShareX')
  expect(args.uploader).toBe('test-user')
  expect(Object.prototype.hasOwnProperty.call(args, 'meta')).toBeFalsy()
})

test('sharex config extracts the hash from short public file paths', async ({ page }) => {
  await signInWithAccount(page)
  await page.goto('/#/files')
  await openSettings(page)
  const sharexButton = page.getByRole('button', { name: 'Download .sxcu' })
  test.skip(await sharexButton.count() === 0 || await sharexButton.isDisabled(), 'ShareX integration disabled in this build')
  await page.route('**/auth/sharex', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        RequestMethod: 'POST',
        URL: `${API_ORIGIN}/`,
        Headers: { Authorization: '$jwt$' },
      }),
    })
  })

  const downloadPromise = page.waitForEvent('download')
  await sharexButton.click()
  const download = await downloadPromise
  const downloadPath = test.info().outputPath('sharex-config-short-path.sxcu')
  await download.saveAs(downloadPath)
  const generated = await readFile(downloadPath, 'utf8')
  const parsed = JSON.parse(generated) as Record<string, any>
  const template = parsed.URL as string
  const match = 'https://paste.example.test/AbCd1234/file.png'.match(
    /^(?:https?:\/\/[^/]+\/)?(?:file\/)?([A-Za-z0-9_-]+)/,
  )
  expect(match?.[1]).toBe('AbCd1234')
  expect(template).toContain('{regex:^(?:https?://[^/]+/)?(?:file/)?([A-Za-z0-9_-]+)|1}/preview')
})

test('executable preview does not auto-fetch raw content and shows no-preview state', async ({ page }) => {
  let rawRequested = false
  await page.route('**/api/meta/setup.exe', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        file_name: 'setup.exe',
        display_name: 'setup.exe',
        uploader: 'test-user',
        upload_date_utc: '2026-04-17T01:00:00Z',
        download_name: 'setup.exe',
        file_size: 698_500,
        mime_type: 'application/octet-stream',
      }),
    })
  })
  await page.route('**/setup/file.exe', async (route) => {
    rawRequested = true
    await route.fulfill({ status: 200, contentType: 'application/octet-stream', body: 'MZ' })
  })

  await page.goto('/#/preview?p=/setup/file.exe')
  await expect(page.getByText('No preview available for this file type.')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Download file' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Open in app' })).toHaveAttribute('href', /\/file\/[A-Za-z0-9_-]+\/download$/)
  await page.waitForTimeout(100)
  expect(rawRequested).toBeFalsy()
})

test('public preview infers media type and cleans generated timestamp suffix when metadata is generic', async ({ page }) => {
  await page.route('**/api/meta/vDuzjHyC.mp4.1777818730459', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        file_name: 'vDuzjHyC.mp4.1777818730459',
        display_name: 'vDuzjHyC.mp4.1777818730459',
        uploader: 'Unknown (token user)',
        upload_date_utc: '2026-04-19 14:32:15',
        download_name: 'vDuzjHyC.mp4.1777818730459',
        file_size: 6_121_534,
        mime_type: 'application/octet-stream',
      }),
    })
  })
  await page.route('**/api/vDuzjHyC.mp4.1777818730459?raw=1', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'video/mp4',
      body: Buffer.from('00000020667479706d703432', 'hex'),
    })
  })

  await page.goto('/#/preview?p=/vDuzjHyC/file.mp4.1777818730459')
  await expect(page.getByText('vDuzjHyC.mp4')).toBeVisible()
  await expect(page.getByText(/video\/mp4 · 5\.8 MiB/i)).toBeVisible()
  await expect(page.locator('.preview-frame video')).toBeVisible()
  await expect(page.getByRole('link', { name: 'View raw' })).toHaveAttribute('href', '/api/vDuzjHyC.mp4.1777818730459?raw=1')
})

test('direct short file URL boots into preview route', async ({ page }) => {
  await page.route('**/api/meta/redirect-check.txt', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        file_name: 'redirect-check.txt',
        display_name: 'redirect-check.txt',
        uploader: 'test-user',
        upload_date_utc: '2026-04-17T01:00:00Z',
        download_name: 'redirect-check.txt',
        file_size: 7,
        mime_type: 'text/plain',
      }),
    })
  })
  await page.route('**/redirect-check/file.txt', async (route) => {
    if (route.request().resourceType() === 'document') {
      await route.fallback()
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'text/plain',
      body: 'preview',
    })
  })

  await page.goto('/redirect-check/file.txt')
  await expect(page).toHaveURL(/\/file\/[A-Za-z0-9_-]+\/preview/)
  await expect(page.getByText('redirect-check.txt')).toBeVisible()
  await expect(page.locator('.text-preview')).toContainText('preview')
})

test('single-segment file URL boots into preview route for images', async ({ page }) => {
  await page.route('**/api/meta/png-check.png', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        file_name: 'png-check.png',
        display_name: 'png-check.png',
        uploader: 'test-user',
        upload_date_utc: '2026-04-17T01:00:00Z',
        download_name: 'png-check.png',
        file_size: 68,
        mime_type: 'image/png',
      }),
    })
  })
  const rawRequests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/api/png-check.png?raw=1')) rawRequests.push(request.url())
  })
  await page.route('**/api/png-check.png?raw=1', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7fM7cAAAAASUVORK5CYII=',
        'base64',
      ),
    })
  })

  await page.goto('/png-check.png')
  await expect(page).toHaveURL(/\/file\/[A-Za-z0-9_-]+\/preview/)
  await expect(page.getByText('png-check.png')).toBeVisible()
  await expect(page.locator('.preview-frame img')).toBeVisible()
  await expect.poll(() => page.locator('.preview-frame img').evaluate((image) => image.naturalWidth)).toBeGreaterThan(0)
  expect(rawRequests).toHaveLength(1)
})

test('public PDF preview requests bytes through the API proxy', async ({ page }) => {
  await page.route('**/api/meta/api-preview-check.pdf', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        file_name: 'api-preview-check.pdf',
        display_name: 'api-preview-check.pdf',
        uploader: 'test-user',
        file_size: 26,
        mime_type: 'application/pdf',
      }),
    })
  })
  await page.route('**/api/api-preview-check.pdf?raw=1', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/pdf',
      body: '%PDF-1.4\n%%EOF\n',
    })
  })

  await page.goto('/#/preview?p=/api-preview-check/file.pdf')
  const pdf = page.locator('iframe[title="PDF preview"]')
  await expect(pdf).toBeVisible()
  await expect(pdf).toHaveAttribute('src', '/api/api-preview-check.pdf?raw=1')
})

test('notifications are row-stacked, capped at five, and clearable', async ({ page }) => {
  await signInWithToken(page)
  await mockClipboard(page)
  let uploadCount = 0
  await page.route('**/api/', async (route) => {
    uploadCount += 1
    await route.fulfill({
      status: 200,
      contentType: 'text/plain',
      body: `${APP_ORIGIN}/notify-${uploadCount}.txt`,
    })
  })

  await page.goto('/#/files')
  await page.locator('input[type="file"]').setInputFiles(
    Array.from({ length: 7 }, (_, i) => ({
      name: `file-${i}.txt`,
      mimeType: 'text/plain',
      buffer: Buffer.from(`file-${i}`),
    })),
  )

  await expect(page.getByTestId('notification-row')).toHaveCount(5)
  await expect(page.getByTestId('notification-list')).toContainText('file-6.txt')
  await expect(page.getByTestId('notification-list')).not.toContainText('file-0.txt')
  await page.getByTestId('clear-notifications').click()
  await expect(page.getByTestId('notification-row')).toHaveCount(0)
})

test('history delete-all notifications stay capped at five', async ({ page }) => {
  await signInWithToken(page)
  await page.route('**/api/list**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        Array.from({ length: 7 }, (_, i) => ({
          file_name: `history-file-${i}.txt`,
          file_size: 42,
          creation_date_utc: '2026-04-17T01:00:00Z',
          expires_at_utc: '2026-04-18T01:00:00Z',
        })),
      ),
    })
  })
  await page.route('**/api/history-file-*.txt', async (route) => {
    await route.fulfill({ status: 200, body: '' })
  })

  await page.goto('/#/files')
  await page.getByRole('button', { name: 'History' }).click()
  await page.getByRole('button', { name: 'Delete All' }).click()
  await page.getByRole('checkbox', { name: /I understand that these files/ }).check()
  await page.getByRole('button', { name: 'Confirm delete' }).click()

  await expect(page.getByTestId('notification-row')).toHaveCount(1)
  await expect(page.getByTestId('notification-list')).toContainText('Deleted 7 file(s)')
})

test('history hover preview clears immediately when deleting the hovered file', async ({ page }) => {
  const supportsHover = await page.evaluate(() => window.matchMedia('(hover: hover) and (pointer: fine)').matches)
  test.skip(!supportsHover, 'Hover previews are only available on pointer/hover devices')
  await signInWithToken(page)

  await page.route('**/api/list**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{
        file_name: 'hover-delete.png',
        file_size: 12005,
        creation_date_utc: '2026-04-17T01:00:00Z',
        expires_at_utc: null,
      }]),
    })
  })
  await page.route('**/api/hover-delete.png', async (route) => {
    await route.fulfill({ status: 200, body: '' })
  })
  await page.route('**/hover-delete/file.png', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7fM7cAAAAASUVORK5CYII=',
        'base64',
      ),
    })
  })

  await page.goto('/#/files')
  await page.getByRole('button', { name: 'History' }).click()
  const row = page.locator('tr.file-row').first()
  await row.hover()
  await expect(page.locator('.hover-preview')).toBeVisible()
  await row.getByRole('button', { name: 'More' }).click()
  await row.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.locator('.hover-preview')).toHaveCount(0)
})

test('long-press paste fills the text area on a mobile viewport', async ({ page }) => {
  await signInWithToken(page)
  await mockClipboard(page, 'mobile clipboard text')
  await page.setViewportSize({ width: 375, height: 812 })

  await page.goto('/#/files')
  const pasteArea = page.getByTestId('paste-area')
  await pasteArea.dispatchEvent('pointerdown', { pointerType: 'touch', isPrimary: true })
  await page.waitForTimeout(650)
  await pasteArea.dispatchEvent('pointerup', { pointerType: 'touch', isPrimary: true })

  await expect(page.getByTestId('text-paste')).toHaveValue('mobile clipboard text')
})

test('history actions and settings buttons work', async ({ page }) => {
  await signInWithToken(page)
  await mockClipboard(page)
  let downloadRequested = false

  await page.route('**/api/list**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{
        file_name: 'history-check.txt',
        file_size: 12,
        creation_date_utc: '2026-04-17T01:00:00Z',
        expires_at_utc: '2026-04-18T01:00:00Z',
      }]),
    })
  })
  await page.route('**/api/history-check.txt', async (route) => {
    await route.fulfill({ status: 200, body: '' })
  })
  await page.route('**/api/history-check.txt?raw=1', async (route) => {
    downloadRequested = true
    await route.fulfill({
      status: 200,
      contentType: 'text/plain',
      body: 'history payload',
      headers: { 'content-disposition': 'attachment; filename=\"history-check.txt\"' },
    })
  })

  await page.goto('/#/files')
  await page.getByRole('button', { name: 'History' }).click()
  const historyRow = page.locator('tr.file-row', { hasText: 'history-check.txt' }).first()
  await expect(historyRow).toBeVisible()
  const expectedExpiry = await page.evaluate(() => new Date('2026-04-18T01:00:00Z').toLocaleString())
  await expect(historyRow.locator('.expiry')).toHaveText(expectedExpiry)
  await historyRow.getByRole('button', { name: 'Download', exact: true }).click()
  await expect.poll(() => downloadRequested).toBeTruthy()
  await historyRow.getByRole('button', { name: 'Copy' }).click()
  await expect.poll(() => page.evaluate(() => (navigator.clipboard as any).__written())).toMatch(PREVIEW_RE)
  await historyRow.getByRole('button', { name: 'More' }).click()
  await historyRow.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.locator('.modal-backdrop')).toHaveCount(0)
  await expect(page.locator('tr.file-row', { hasText: 'history-check.txt' })).toHaveCount(0)

  await page.getByRole('button', { name: 'Preferences' }).click()
  await expect(page.getByLabel('API Base URL')).toBeVisible()
  await page.getByLabel('API Base URL').fill('https://papi.example.test/')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('rp_api_base'))).toBe('https://papi.example.test')
  await expect(page.locator('.settings-panel')).toBeHidden()

  await page.getByRole('button', { name: 'Preferences' }).click()
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.locator('.settings-panel')).toBeHidden()
})

test('saved API override wins over the deployment default and persists', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('rp_token', 'demo-token')
    localStorage.setItem('rp_api_base', 'https://custom.example.test')
  })
  await page.route('**/auth/admin/public-settings', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        app_name: 'yaemipaste',
        public_title: 'yaemipaste',
        registration_enabled: false,
        base_api_url: 'https://papi.example.test',
        file_size_limit_bytes: 0,
        file_size_limit_unlimited: false,
        upload_access_mode: 'public',
      }),
    })
  })

  await page.goto('/#/files')

  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('rp_api_base')))
    .toBe('https://custom.example.test')
})

test('upload keeps a user API override after an upload failure', async ({ page }) => {
  let overrideRequested = false
  let fallbackRequested = false
  await page.addInitScript(() => {
    localStorage.setItem('rp_token', 'demo-token')
    localStorage.setItem('rp_api_base', '/api-bad')
  })

  await page.route('**/api-bad/', async (route) => {
    overrideRequested = true
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'ok', message: 'legacy api root' }),
    })
  })

  await page.route('**/api/', async (route) => {
    fallbackRequested = true
    await route.fulfill({
      status: 200,
      contentType: 'text/plain',
      body: `${APP_ORIGIN}/file/retry-ok/preview`,
    })
  })

  await page.goto('/#/files')
  await page.locator('input[type="file"]').setInputFiles({
    name: 'retry-upload.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('retry me'),
  })

  await expect.poll(() => overrideRequested).toBeTruthy()
  await expect.poll(() => fallbackRequested).toBeFalsy()
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('rp_api_base')))
    .toBe('/api-bad')
})

test('history copy includes decryption key for encrypted files', async ({ page }) => {
  await signInWithToken(page)
  await mockClipboard(page)

  const fileName = 'secret.png.rpenc'
  const decryptKey = 'AbCdEf123_-'
  await page.addInitScript(({ name, key }) => {
    const payload = {
      [name]: {
        key,
        origin: 'https://paste.example.test',
        name: 'secret.png',
        type: 'application/octet-stream',
        size: 123,
        createdAt: '2026-04-18T00:00:00Z',
        uploader: 'owner',
      },
    }
    localStorage.setItem('rp_e2ee_keys', JSON.stringify(payload))
  }, { name: fileName, key: decryptKey })

  await page.route('**/api/list**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{
        file_name: fileName,
        file_size: 123,
        creation_date_utc: '2026-04-18T00:00:00Z',
        expires_at_utc: null,
      }]),
    })
  })
  await page.route('**/api/meta/secret.png.rpenc', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        file_name: fileName,
        display_name: fileName,
        uploader: 'owner',
        upload_date_utc: '2026-04-18 00:00:00',
        download_name: fileName,
        file_size: 123,
        mime_type: 'application/octet-stream',
      }),
    })
  })

  await page.goto('/#/files')
  await page.getByRole('button', { name: 'History' }).click()
  await page.getByRole('button', { name: 'Copy' }).click()
  await expect.poll(() => page.evaluate(() => (navigator.clipboard as any).__written())).toContain(`/preview#${decryptKey}`)
})

test('history encrypted modal copy includes key and hides raw media URL action', async ({ page }) => {
  await signInWithToken(page)
  await mockClipboard(page)

  const fileName = 'secret.bin.rpenc'
  const decryptKey = 'AbCdEf123_-'
  await page.addInitScript(({ name, key }) => {
    const payload = {
      [name]: {
        key,
        origin: 'https://paste.example.test',
        name: 'secret.bin',
        type: 'application/octet-stream',
        size: 345,
        createdAt: '2026-04-18T00:00:00Z',
        uploader: 'owner',
      },
    }
    localStorage.setItem('rp_e2ee_keys', JSON.stringify(payload))
  }, { name: fileName, key: decryptKey })

  await page.route('**/api/list**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{
        file_name: fileName,
        file_size: 345,
        creation_date_utc: '2026-04-18T00:00:00Z',
        expires_at_utc: null,
      }]),
    })
  })
  await page.route('**/api/meta/secret.bin.rpenc', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        file_name: fileName,
        display_name: fileName,
        uploader: 'owner',
        upload_date_utc: '2026-04-18 00:00:00',
        download_name: fileName,
        file_size: 345,
        mime_type: 'application/octet-stream',
      }),
    })
  })

  await page.goto('/#/files')
  await page.getByRole('button', { name: 'History' }).click()
  await page.getByText('secret.bin').click()
  const modal = page.locator('.modal')
  await expect(modal).toBeVisible()
  await expect(modal.getByText('Size: 345 B', { exact: true })).toBeVisible()
  await modal.getByRole('button', { name: 'More copy options' }).click()
  await modal.getByRole('menuitem', { name: /Copy preview URL/ }).click()
  await expect.poll(() => page.evaluate(() => (navigator.clipboard as any).__written())).toContain(`/preview#${decryptKey}`)
})

test('history prompts for a decryption key for locked rpenc previews', async ({ page }) => {
  await signInWithToken(page)
  await page.route('**/api/list**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{
        file_name: 'locked-image.png.rpenc',
        file_size: 2048,
        creation_date_utc: '2026-04-18T00:00:00Z',
        expires_at_utc: null,
      }]),
    })
  })

  await page.goto('/#/files')
  await page.getByRole('button', { name: 'History' }).click()
  const row = page.locator('tr.file-row').first()
  await expect(row.locator('.lock-icon')).toBeVisible()
  await row.locator('.filename').click()
  const modal = page.getByRole('dialog', { name: 'Preview encrypted file' })
  await expect(modal).toBeVisible()
  await expect(modal.getByLabel('Decryption key')).toBeVisible()
})

test('history decrypts rpenc previews when legacy key entries omit origin', async ({ page }) => {
  await signInWithToken(page)
  let uploadedEncryptedBody: Buffer | null = null
  const encryptedName = 'legacy-image.png.rpenc'

  await page.route('**/api/', async (route) => {
    const body = route.request().postDataBuffer()
    if (!body) throw new Error('Missing upload body')
    uploadedEncryptedBody = extractMultipartField(body, route.request().headers()['content-type'] ?? '', 'file')
    await route.fulfill({
      status: 200,
      contentType: 'text/plain',
      body: `${APP_ORIGIN}/${encryptedName}`,
    })
  })
  await page.route('**/api/list**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{
        file_name: encryptedName,
        file_size: 256,
        creation_date_utc: '2026-04-18T00:00:00Z',
        expires_at_utc: null,
      }]),
    })
  })
  await page.route(`**/api/${encryptedName}?raw=1`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/octet-stream',
      body: uploadedEncryptedBody ?? Buffer.from(''),
    })
  })

  await page.goto('/#/files')
  await page.getByTestId('encrypt-toggle').click()
  await page.locator('input[type="file"]').setInputFiles({
    name: 'legacy-image.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7fM7cAAAAASUVORK5CYII=',
      'base64',
    ),
  })
  await page.evaluate(() => {
    const raw = localStorage.getItem('rp_e2ee_keys')
    if (!raw) return
    const parsed = JSON.parse(raw) as Record<string, any>
    const migrated: Record<string, any> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object') continue
      if (typeof value.key === 'string' && !value.key.startsWith('pw:')) {
        value.key = `${value.key.replace(/-/g, '+').replace(/_/g, '/')}==`
      }
      delete value.origin
      const targetKey = key.endsWith('.rpenc') ? key.slice(0, -6) : key
      migrated[targetKey] = value
    }
    localStorage.setItem('rp_e2ee_keys', JSON.stringify(migrated))
  })

  await page.getByRole('button', { name: 'History' }).click()
  const row = page.locator('tr.file-row').first()
  await expect(row).toContainText('legacy-image')
  await expect(row).toContainText('.png')
  await expect(row).not.toContainText('.rpenc')
  await row.locator('.filename').click()
  const modal = page.locator('.modal')
  await expect(modal).toBeVisible()
  await expect(modal.getByRole('img')).toBeVisible()
  await expect(modal.getByText('This is an encrypted file. Add the decryption key/password to preview it.')).toHaveCount(0)
})

test('history decrypts and previews inline text for encrypted text files', async ({ page }) => {
  await signInWithToken(page)
  let encryptedPayload: Buffer | null = null
  const encryptedName = 'secret-note.txt.rpenc'
  const plainText = 'encrypted text should preview inline'

  await page.route('**/api/', async (route) => {
    const body = route.request().postDataBuffer()
    if (!body) throw new Error('Missing upload body')
    encryptedPayload = extractMultipartField(body, route.request().headers()['content-type'] ?? '', 'file')
    await route.fulfill({
      status: 200,
      contentType: 'text/plain',
      body: `${APP_ORIGIN}/${encryptedName}`,
    })
  })
  await page.route('**/api/list**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{
        file_name: encryptedName,
        file_size: 256,
        creation_date_utc: '2026-04-18T00:00:00Z',
        expires_at_utc: null,
      }]),
    })
  })
  await page.route(`**/api/${encryptedName}?raw=1`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/octet-stream',
      body: encryptedPayload ?? Buffer.from(''),
    })
  })

  await page.goto('/#/files')
  await page.getByTestId('encrypt-toggle').click()
  await page.locator('input[type="file"]').setInputFiles({
    name: 'secret-note.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(plainText),
  })

  await page.getByRole('button', { name: 'History' }).click()
  await page.locator('tr.file-row .filename').first().click()
  const modal = page.locator('.modal')
  await expect(modal).toBeVisible()
  await expect(modal.getByText(plainText)).toBeVisible()
  await expect(modal.getByText('No inline preview available')).toHaveCount(0)
})

test('encrypted upload keeps history key when server returns /file/<token>/preview URL', async ({ page }) => {
  await signInWithToken(page)
  await mockClipboard(page)
  const encryptedName = 'tokenized-short-path.txt.rpenc'
  const token = Buffer.from(encryptedName).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')

  await page.route('**/api/', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/plain',
      body: `${APP_ORIGIN}/file/${token}/preview`,
    })
  })
  await page.route('**/api/list**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{
        file_name: encryptedName,
        file_size: 64,
        creation_date_utc: '2026-04-18T00:00:00Z',
        expires_at_utc: null,
      }]),
    })
  })

  await page.goto('/#/files')
  await page.getByTestId('encrypt-toggle').click()
  await page.locator('input[type="file"]').setInputFiles({
    name: 'tokenized-short-path.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('tokenized-short-path'),
  })
  await page.getByRole('button', { name: 'History' }).click()
  await page.getByRole('button', { name: 'Copy' }).click()
  await expect.poll(() => page.evaluate(() => (navigator.clipboard as any).__written())).toContain('/preview#')
})

test('encrypted upload keeps history key when server returns /file/<id>/preview URL', async ({ page }) => {
  await signInWithToken(page)
  await mockClipboard(page)
  const encryptedName = 'tokenized-modern-path.txt.rpenc'
  const fileId = 'tokenized-modern-path'

  await page.route('**/api/', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/plain',
      body: `${APP_ORIGIN}/file/${fileId}/preview`,
    })
  })
  await page.route('**/api/list**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{
        file_name: encryptedName,
        file_size: 64,
        creation_date_utc: '2026-04-18T00:00:00Z',
        expires_at_utc: null,
      }]),
    })
  })

  await page.goto('/#/files')
  await page.getByTestId('encrypt-toggle').click()
  await page.locator('input[type="file"]').setInputFiles({
    name: 'tokenized-modern-path.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('tokenized-modern-path'),
  })
  await page.getByRole('button', { name: 'History' }).click()
  await page.getByRole('button', { name: 'Copy' }).click()
  await expect.poll(() => page.evaluate(() => (navigator.clipboard as any).__written())).toContain('/preview#')
})

test('history password-encrypted download requires password prompt', async ({ page }) => {
  await signInWithToken(page)
  let rawRequested = false
  const fileName = 'secret.png.rpenc'
  await page.addInitScript(({ name }) => {
    const payload = {
      [name]: {
        key: 'pw:header-token',
        origin: 'https://paste.example.test',
        name: 'secret.png',
        type: 'application/octet-stream',
        size: 123,
        createdAt: '2026-04-18T00:00:00Z',
        uploader: 'owner',
      },
    }
    localStorage.setItem('rp_e2ee_keys', JSON.stringify(payload))
  }, { name: fileName })

  await page.route('**/api/list**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{
        file_name: fileName,
        file_size: 123,
        creation_date_utc: '2026-04-18T00:00:00Z',
        expires_at_utc: null,
      }]),
    })
  })
  await page.route('**/api/secret.png.rpenc?raw=1', async (route) => {
    rawRequested = true
    await route.fulfill({ status: 200, body: '' })
  })

  await page.goto('/#/files')
  await page.getByRole('button', { name: 'History' }).click()
  await page.getByRole('button', { name: 'Download', exact: true }).click()
  await expect(page.getByText('Download password-encrypted file')).toBeVisible()
  await expect.poll(() => rawRequested).toBeFalsy()
})

test('history password-encrypted text preview decrypts inline', async ({ page }) => {
  await signInWithToken(page)

  const fileName = 'secret-note.txt.rpenc'
  const password = 'PreviewPass!123'
  const textBody = 'password protected inline text'
  const encrypted = await encryptFileWithPassword(
    new File([textBody], 'secret-note.txt', { type: 'text/plain' }),
    password,
    'owner',
  )
  const encryptedPayload = {
    salt: encrypted.salt,
    bytes: Array.from(new Uint8Array(await encrypted.blob.arrayBuffer())),
  }

  await page.addInitScript(({ fileName, salt }) => {
    localStorage.setItem('rp_e2ee_keys', JSON.stringify({
      [fileName]: {
        key: `pw:${salt}`,
        origin: 'https://paste.example.test',
        name: 'secret-note.txt',
        type: 'application/octet-stream',
        size: 30,
        createdAt: '2026-04-18T00:00:00Z',
        uploader: 'owner',
      },
    }))
  }, { fileName, salt: encryptedPayload.salt })

  await page.route('**/api/list**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{
        file_name: fileName,
        file_size: encryptedPayload.bytes.length,
        creation_date_utc: '2026-04-18T00:00:00Z',
        expires_at_utc: null,
      }]),
    })
  })
  await page.route('**/api/meta/secret-note.txt.rpenc', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        file_name: fileName,
        display_name: fileName,
        uploader: 'owner',
        upload_date_utc: '2026-04-18 00:00:00',
        download_name: fileName,
        file_size: encryptedPayload.bytes.length,
        mime_type: 'application/octet-stream',
      }),
    })
  })
  await page.route('**/api/secret-note.txt.rpenc?raw=1', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/octet-stream',
      body: Buffer.from(encryptedPayload.bytes),
    })
  })

  await page.goto('/#/files')
  await page.getByRole('button', { name: 'History' }).click()
  await page.locator('tr.file-row .filename').first().click()
  await expect(page.getByText('Preview password-encrypted file')).toBeVisible()
  await page.getByLabel('Decryption password').fill(password)
  await page.getByRole('button', { name: 'Preview file' }).click()
  await expect(page.getByText('This password-encrypted file type has no inline preview')).toHaveCount(0)
  await expect(page.locator('.text-preview')).toContainText(textBody)
})

test('history password change closes modal and keeps success notification after encrypted upload flow', async ({ page }) => {
  await signInWithToken(page)

  let uploadCalls = 0
  let firstEncryptedBody: Buffer | null = null
  let historyFileName = 'change-target.rpenc'
  let deleteCalled = false

  await page.route('**/api/', async (route) => {
    uploadCalls += 1
    const body = route.request().postDataBuffer()
    if (!body) throw new Error('Missing upload body')
    const contentType = route.request().headers()['content-type'] ?? ''
    const encryptedFile = extractMultipartField(body, contentType, 'file')
    if (uploadCalls === 1) {
      firstEncryptedBody = encryptedFile
      await route.fulfill({
        status: 200,
        contentType: 'text/plain',
        body: `${APP_ORIGIN}/change-target.rpenc`,
      })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'text/plain',
      body: `${APP_ORIGIN}/change-target-rotated.rpenc`,
    })
  })
  await page.route('**/api/list**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{
        file_name: historyFileName,
        file_size: 128,
        creation_date_utc: '2026-04-18T00:00:00Z',
        expires_at_utc: null,
      }]),
    })
  })
  await page.route('**/api/meta/*', async (route) => {
    const last = route.request().url().split('/').pop() ?? historyFileName
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        file_name: last,
        display_name: last,
        uploader: 'owner',
        upload_date_utc: '2026-04-18 00:00:00',
        download_name: last,
        file_size: 128,
        mime_type: 'application/octet-stream',
      }),
    })
  })
  await page.route('**/api/change-target.rpenc*', async (route) => {
    if (route.request().url().includes('?raw=1')) {
      await new Promise((resolve) => setTimeout(resolve, 200))
      await route.fulfill({
        status: 200,
        contentType: 'application/octet-stream',
        body: firstEncryptedBody ?? Buffer.from(''),
      })
      return
    }
    deleteCalled = true
    historyFileName = 'change-target-rotated.rpenc'
    await route.fulfill({ status: 200, body: '' })
  })

  await page.goto('/#/files')
  await page.getByTestId('encrypt-toggle').click()
  await page.getByTestId('encrypt-toggle').click()
  await page.locator('.pw-input').fill('old-pass')
  await page.locator('input[type="file"]').setInputFiles({
    name: 'change-target.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('password-change-check'),
  })
  await expect.poll(() => uploadCalls).toBe(1)

  await page.getByRole('button', { name: 'History' }).click()
  const historyRow = page.locator('tr.file-row').first()
  await expect(historyRow).toBeVisible()
  await historyRow.getByRole('button', { name: 'More' }).click()
  await historyRow.getByRole('button', { name: 'Change decryption password' }).click()

  await page.getByLabel('Current password').fill('old-pass')
  await page.getByLabel('New password', { exact: true }).fill('new-pass')
  await page.getByLabel('Confirm new password', { exact: true }).fill('new-pass')
  await page.getByRole('button', { name: 'Save password' }).click()

  await expect(page.getByText(/Downloading encrypted file|Decrypting with current password|Encrypting and uploading/)).toBeVisible()
  await expect(page.locator('.password-modal')).toHaveCount(0)
  await expect(page.getByTestId('notification-list')).toContainText('Decryption password updated')
  await expect(page.locator('.row-item-menu')).toHaveCount(0)
  await expect.poll(() => uploadCalls).toBe(2)
  await expect.poll(() => deleteCalled).toBeTruthy()
})

test('history auto-refreshes after upload refresh event', async ({ page }) => {
  await signInWithToken(page)
  let listVersion = 0
  await page.route('**/api/list**', async (route) => {
    const files = listVersion === 0
      ? [{
        file_name: 'existing-history.txt',
        file_size: 10,
        creation_date_utc: '2026-04-17T01:00:00Z',
        expires_at_utc: null,
      }]
      : [{
        file_name: 'existing-history.txt',
        file_size: 10,
        creation_date_utc: '2026-04-17T01:00:00Z',
        expires_at_utc: null,
      }, {
        file_name: 'new-upload.txt',
        file_size: 15,
        creation_date_utc: '2026-04-17T01:05:00Z',
        expires_at_utc: null,
      }]
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(files),
    })
  })

  await page.goto('/#/files')
  await page.getByRole('button', { name: 'History' }).click()
  await expect(page.getByLabel('Select existing-history.txt')).toBeVisible()
  await expect(page.getByText('new-upload.txt')).toHaveCount(0)

  listVersion = 1
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('rp:history-refresh')))
  await expect(page.getByText('new-upload.txt')).toBeVisible()
})

test('history refreshes when History tab is clicked again', async ({ page }) => {
  await signInWithToken(page)
  let listVersion = 0
  await page.route('**/api/list**', async (route) => {
    const files = listVersion === 0
      ? [{
        file_name: 'first-list.txt',
        file_size: 10,
        creation_date_utc: '2026-04-17T01:00:00Z',
        expires_at_utc: null,
      }]
      : [{
        file_name: 'first-list.txt',
        file_size: 10,
        creation_date_utc: '2026-04-17T01:00:00Z',
        expires_at_utc: null,
      }, {
        file_name: 'second-list.txt',
        file_size: 12,
        creation_date_utc: '2026-04-17T01:01:00Z',
        expires_at_utc: null,
      }]
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(files),
    })
  })

  await page.goto('/#/files')
  await page.getByRole('button', { name: 'History' }).click()
  await expect(page.getByText('first-list.txt')).toBeVisible()
  await expect(page.getByText('second-list.txt')).toHaveCount(0)

  listVersion = 1
  await page.getByRole('button', { name: 'Files' }).click()
  await page.getByRole('button', { name: 'History' }).click()
  await expect(page.getByText('second-list.txt')).toBeVisible()
})

test('history and admin close transient controls when the page becomes hidden', async ({ page }) => {
  await signInAsAdmin(page)
  await mockAdminApi(page)
  await page.route('**/api/list**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{
        file_name: 'visibility-history.txt',
        file_size: 10,
        creation_date_utc: '2026-04-17T01:00:00Z',
        expires_at_utc: null,
      }]),
    })
  })

  await page.goto('/#/files')
  await page.getByRole('button', { name: 'History' }).click()
  const historyRow = page.locator('tr.file-row').first()
  await expect(historyRow).toBeVisible()
  await historyRow.getByRole('button', { name: 'More' }).click()
  await expect(historyRow.locator('.row-item-menu')).toBeVisible()

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect(historyRow.locator('.row-item-menu')).toHaveCount(0)

  await page.goto('/admin/uploads')
  const uploadRow = page.locator('.admin-table tbody tr').filter({ hasText: 'ShareX screenshot.png' }).first()
  await expect(uploadRow).toBeVisible()
  await uploadRow.getByRole('button', { name: 'More' }).click()
  await expect(uploadRow.locator('.upload-row-menu-panel')).toBeVisible()

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect(uploadRow.locator('.upload-row-menu-panel')).toHaveCount(0)

  await expect(page.locator('.info-box')).toHaveCount(0)
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect(page.locator('.info-box')).toHaveCount(0)
})

test('preview action groups keep Copy aligned with Open', async ({ page }) => {
  await signInAsAdmin(page)
  await mockAdminApi(page)
  await page.goto('/admin/uploads')

  await page.getByRole('button', { name: 'ShareX screenshot.png', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Preview ShareX screenshot.png' })
  await page.waitForTimeout(400)
  const openButton = dialog.getByRole('button', { name: 'Open file preview or raw content' })
  const primaryCopyButton = dialog.getByRole('button', { name: 'Copy file content or URL' })
  const copyMenuButton = dialog.getByRole('button', { name: 'More copy options' })
  const openChevron = openButton.locator('.copy-chevron')
  const copyChevron = copyMenuButton.locator('.copy-chevron')
  const copyActions = dialog.locator('.copy-actions')
  const openBox = await openButton.boundingBox()
  const copyBox = await primaryCopyButton.boundingBox()
  const copyMenuBox = await copyMenuButton.boundingBox()
  const copyActionsBox = await copyActions.boundingBox()

  expect(openBox).not.toBeNull()
  expect(copyBox).not.toBeNull()
  expect(copyMenuBox).not.toBeNull()
  expect(copyActionsBox).not.toBeNull()
  expect(await dialog.evaluate((element) => element.closest('.modal-backdrop')?.parentElement === document.body)).toBeTruthy()
  await expect(copyActions).toHaveCSS('align-items', 'stretch')
  await expect(copyChevron).not.toHaveClass(/is-open/)
  const copyMenuButtonBox = await copyMenuButton.boundingBox()
  const copyChevronBox = await copyChevron.boundingBox()
  expect(copyMenuButtonBox).not.toBeNull()
  expect(copyChevronBox).not.toBeNull()
  if (copyMenuButtonBox && copyChevronBox) {
    expect(Math.abs((copyMenuButtonBox.x + copyMenuButtonBox.width / 2) - (copyChevronBox.x + copyChevronBox.width / 2))).toBeLessThanOrEqual(1)
    expect(Math.abs((copyMenuButtonBox.y + copyMenuButtonBox.height / 2) - (copyChevronBox.y + copyChevronBox.height / 2))).toBeLessThanOrEqual(1)
  }
  await copyMenuButton.click()
  await expect(copyChevron).toHaveClass(/is-open/)
  await copyMenuButton.click()
  await expect(copyChevron).not.toHaveClass(/is-open/)
  await openButton.click()
  await expect(openChevron).toHaveClass(/is-open/)
  await openButton.click()
  await expect(openChevron).not.toHaveClass(/is-open/)
  if (openBox && copyBox && copyMenuBox && copyActionsBox) {
    const viewport = page.viewportSize()!
    if (viewport.width > 600) {
      expect(Math.abs(openBox.width - copyBox.width)).toBeLessThanOrEqual(1)
    } else {
      expect(Math.abs(openBox.width - copyActionsBox.width)).toBeLessThanOrEqual(1)
    }
    expect(Math.abs(openBox.y - copyBox.y)).toBeLessThanOrEqual(1)
    expect(Math.abs(copyActionsBox.width - (copyBox.width + copyMenuBox.width - 1))).toBeLessThanOrEqual(1)
    if (viewport.width <= 600) {
      expect(copyActionsBox.x).toBeGreaterThanOrEqual(0)
      expect(copyActionsBox.x + copyActionsBox.width).toBeLessThanOrEqual(viewport.width)
    }
  }

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.waitForTimeout(400)
  const recoveredBox = await dialog.boundingBox()
  const viewport = page.viewportSize()!
  expect(recoveredBox).not.toBeNull()
  if (recoveredBox) {
    expect(recoveredBox.x).toBeGreaterThanOrEqual(0)
    expect(recoveredBox.y).toBeGreaterThanOrEqual(0)
    expect(recoveredBox.x + recoveredBox.width).toBeLessThanOrEqual(viewport.width)
    expect(recoveredBox.y + recoveredBox.height).toBeLessThanOrEqual(viewport.height)
  }
})

test('workspace navigation fades between pages', async ({ page }) => {
  await signInWithToken(page)
  await page.route('**/api/list**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  })

  await page.goto('/files')
  await expect(page.getByRole('button', { name: 'History' })).toBeVisible()
  await page.evaluate(() => {
    const events: string[] = []
    document.addEventListener('transitionrun', (event) => {
      if (event.propertyName === 'opacity') events.push('run')
    }, true)
    document.addEventListener('transitionend', (event) => {
      if (event.propertyName === 'opacity') events.push('end')
    }, true)
    ;(window as Window & { __opacityTransitions?: string[] }).__opacityTransitions = events
  })

  await page.getByRole('button', { name: 'History' }).click()
  await expect(page).toHaveURL(/\/history$/)
  await expect(page.locator('.history-tab')).toBeVisible()
  await page.waitForTimeout(350)
  await expect.poll(() => page.evaluate(() => (window as Window & { __opacityTransitions?: string[] }).__opacityTransitions ?? [])).toContain('run')
  await expect.poll(() => page.evaluate(() => (window as Window & { __opacityTransitions?: string[] }).__opacityTransitions ?? [])).toContain('end')
})

test('history shows ShareX badge for token-uploaded screenshot files', async ({ page }) => {
  await signInWithToken(page)
  await page.route('**/api/list**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{
        file_name: 'Ab12Cd34.png',
        file_size: 4096,
        creation_date_utc: '2026-04-17T01:00:00Z',
        expires_at_utc: null,
      }]),
    })
  })
  await page.route('**/api/meta/Ab12Cd34.png', async (route) => {
    if ((route.request().headers().authorization ?? '') !== 'test-token') {
      await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ detail: 'Unauthorized' }) })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        file_name: 'Ab12Cd34.png',
        display_name: 'Ab12Cd34.png',
        uploader: 'test-user (ShareX)',
        source: 'ShareX',
        upload_date_utc: '2026-04-17T01:00:00Z',
        download_name: 'Ab12Cd34.png',
        file_size: 4096,
        mime_type: 'image/png',
      }),
    })
  })

  await page.goto('/#/files')
  await page.getByRole('button', { name: 'History' }).click()
  await expect(page.getByLabel('Uploaded with ShareX')).toBeVisible()
})

test('history does not show ShareX badge when source marker says WebUI', async ({ page }) => {
  await signInWithToken(page)
  await page.route('**/api/list**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{
        file_name: 'from-files-page.png',
        file_size: 4096,
        creation_date_utc: '2026-04-17T01:00:00Z',
        expires_at_utc: null,
      }]),
    })
  })
  await page.route('**/api/meta/from-files-page.png', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        file_name: 'from-files-page.png',
        display_name: 'from-files-page.png',
        uploader: 'ShareX',
        source: 'WebUI',
        upload_date_utc: '2026-04-17T01:00:00Z',
        download_name: 'from-files-page.png',
        file_size: 4096,
        mime_type: 'image/png',
      }),
    })
  })

  await page.goto('/#/files')
  await page.getByRole('button', { name: 'History' }).click()
  await expect(page.getByLabel('Uploaded with ShareX')).toHaveCount(0)
})

test('history does not show ShareX badge when source is explicit webui even with sharex-like uploader text', async ({ page }) => {
  await signInWithToken(page)
  await page.route('**/api/list**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{
        file_name: 'explicit-webui-source.png',
        file_size: 4096,
        creation_date_utc: '2026-04-17T01:00:00Z',
        expires_at_utc: null,
      }]),
    })
  })
  await page.route('**/api/meta/explicit-webui-source.png', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        file_name: 'explicit-webui-source.png',
        display_name: 'explicit-webui-source.png',
        uploader: 'test-user (ShareX)',
        source: 'WebUI',
        upload_date_utc: '2026-04-17T01:00:00Z',
        download_name: 'explicit-webui-source.png',
        file_size: 4096,
        mime_type: 'image/png',
      }),
    })
  })

  await page.goto('/#/files')
  await page.getByRole('button', { name: 'History' }).click()
  await expect(page.getByLabel('Uploaded with ShareX')).toHaveCount(0)
})

test('history does not show ShareX badge for legacy ShareX uploader value without source marker', async ({ page }) => {
  await signInWithToken(page)
  await page.route('**/api/list**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{
        file_name: 'legacy-sharex.png',
        file_size: 4096,
        creation_date_utc: '2026-04-17T01:00:00Z',
        expires_at_utc: null,
      }]),
    })
  })
  await page.route('**/api/meta/legacy-sharex.png', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        file_name: 'legacy-sharex.png',
        display_name: 'legacy-sharex.png',
        uploader: 'ShareX',
        upload_date_utc: '2026-04-17T01:00:00Z',
        download_name: 'legacy-sharex.png',
        file_size: 4096,
        mime_type: 'image/png',
      }),
    })
  })

  await page.goto('/#/files')
  await page.getByRole('button', { name: 'History' }).click()
  await expect(page.getByLabel('Uploaded with ShareX')).toHaveCount(0)
})

test('history does not show ShareX badge for legacy token-uploaded media rows without explicit source marker', async ({ page }) => {
  await signInWithToken(page)
  await page.route('**/api/list**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{
        file_name: '03kZwAgf.png',
        file_size: 25500,
        creation_date_utc: '2026-04-17T01:00:00Z',
        expires_at_utc: null,
      }]),
    })
  })
  await page.route('**/api/meta/03kZwAgf.png', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        file_name: '03kZwAgf.png',
        display_name: '03kZwAgf.png',
        uploader: 'Unknown (token user)',
        upload_date_utc: '2026-04-17T01:00:00Z',
        download_name: '03kZwAgf.png',
        file_size: 25500,
        mime_type: 'image/png',
      }),
    })
  })

  await page.goto('/#/files')
  await page.getByRole('button', { name: 'History' }).click()
  await expect(page.getByLabel('Uploaded with ShareX')).toHaveCount(0)
})

test('history does not show ShareX badge for legacy token-uploaded rows without explicit source marker', async ({ page }) => {
  await signInWithToken(page)
  await page.route('**/api/list**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{
        file_name: '03kZwAgf.txt',
        file_size: 25500,
        creation_date_utc: '2026-04-17T01:00:00Z',
        expires_at_utc: null,
      }]),
    })
  })
  await page.route('**/api/meta/03kZwAgf.txt', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        file_name: '03kZwAgf.txt',
        display_name: '03kZwAgf.txt',
        uploader: 'Unknown (token user)',
        upload_date_utc: '2026-04-17T01:00:00Z',
        download_name: '03kZwAgf.txt',
        file_size: 25500,
        mime_type: 'text/plain',
      }),
    })
  })

  await page.goto('/#/files')
  await page.getByRole('button', { name: 'History' }).click()
  await expect(page.getByLabel('Uploaded with ShareX')).toHaveCount(0)
})

test('history preview modal provides copy action that copies preview URL', async ({ page }) => {
  await signInWithToken(page)
  await mockClipboard(page)

  await page.route('**/api/list**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{
        file_name: 'history-modal.png',
        file_size: 68,
        creation_date_utc: '2026-04-17T01:00:00Z',
        expires_at_utc: null,
      }]),
    })
  })
  await page.route('**/history-modal/file.png', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7fM7cAAAAASUVORK5CYII=',
        'base64',
      ),
    })
  })

  await page.goto('/#/files')
  await page.getByRole('button', { name: 'History' }).click()
  await page.getByText('history-modal.png').click()
  const modal = page.locator('.modal')
  await expect(modal).toBeVisible()
  await expect(modal.getByText('Size: 68 B')).toBeVisible()

  await modal.getByRole('button', { name: 'More copy options' }).click()
  await modal.getByRole('menuitem', { name: /Copy preview URL/ }).click()
  await expect.poll(() => page.evaluate(() => (navigator.clipboard as any).__written())).toMatch(
    /\/file\/[A-Za-z0-9_-]+\/preview$/,
  )
  await expect(page.getByTestId('notification-row').filter({ hasText: 'Copied!' })).toHaveCount(1)
  await expect(modal.getByRole('menuitem', { name: /Copy raw URL/ })).toHaveCount(0)
})

test('history non-image preview shows size and download button', async ({ page }) => {
  await signInWithToken(page)

  await page.route('**/api/list**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{
        file_name: 'history-doc.pdf',
        file_size: 12,
        creation_date_utc: '2026-04-17T01:00:00Z',
        expires_at_utc: null,
      }]),
    })
  })
  await page.route('**/api/history-doc.pdf?raw=1', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/pdf',
      body: Buffer.from('dummy pdf payload'),
    })
  })

  await page.goto('/#/files')
  await page.getByRole('button', { name: 'History' }).click()
  await page.getByText('history-doc.pdf').click()

  const modal = page.locator('.modal')
  await expect(modal).toBeVisible()
  await expect(modal.getByText('No inline preview available')).toBeVisible()
  await expect(modal.getByText('File size: 12 B')).toBeVisible()
  await expect(modal.getByRole('button', { name: 'Download file' })).toBeVisible()
})

test('history preview shows inline text content for text files', async ({ page }) => {
  await signInWithToken(page)

  await page.route('**/api/list**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{
        file_name: 'history-note.txt',
        file_size: 30,
        creation_date_utc: '2026-04-17T01:00:00Z',
        expires_at_utc: null,
      }]),
    })
  })
  await page.route('**/api/meta/history-note.txt', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        file_name: 'history-note.txt',
        display_name: 'history-note.txt',
        uploader: 'owner',
        upload_date_utc: '2026-04-17 01:00:00',
        download_name: 'history-note.txt',
        file_size: 30,
        mime_type: 'text/plain',
      }),
    })
  })
  await page.route('**/api/history-note.txt?raw=1', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/plain',
      body: 'hello from history text preview',
    })
  })

  await page.goto('/#/files')
  await page.getByRole('button', { name: 'History' }).click()
  await page.getByText('history-note.txt').click()

  const modal = page.locator('.modal')
  await expect(modal).toBeVisible()
  await expect(modal.getByText('hello from history text preview')).toBeVisible()
  await expect(modal.getByText('No inline preview available')).toHaveCount(0)
})

test('history non-image preview opens instantly without waiting on raw fetch', async ({ page }) => {
  await signInWithToken(page)
  let rawRequested = false

  await page.route('**/api/list**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{
        file_name: 'history-slow.docx',
        file_size: 1024,
        creation_date_utc: '2026-04-17T01:00:00Z',
        expires_at_utc: null,
      }]),
    })
  })
  await page.route('**/api/history-slow.docx?raw=1', async (route) => {
    rawRequested = true
    await page.waitForTimeout(1500)
    await route.fulfill({
      status: 200,
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      body: Buffer.from('delayed payload'),
    })
  })

  await page.goto('/#/files')
  await page.getByRole('button', { name: 'History' }).click()
  await page.getByText('history-slow.docx').click()

  const modal = page.locator('.modal')
  await expect(modal).toBeVisible({ timeout: 300 })
  await expect(modal.getByText('No inline preview available')).toBeVisible()
  await expect.poll(() => rawRequested).toBeFalsy()
})

test('history paginates at 15 by default and supports page-size menu', async ({ page }) => {
  await signInWithToken(page)
  await page.route('**/api/list**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        Array.from({ length: 20 }, (_, i) => ({
          file_name: `page-file-${String(i).padStart(2, '0')}.txt`,
          file_size: 10 + i,
          creation_date_utc: '2026-04-17T01:00:00Z',
          expires_at_utc: null,
        })),
      ),
    })
  })

  await page.goto('/#/files')
  await page.getByRole('button', { name: 'History' }).click()
  await expect(page.locator('tr.file-row')).toHaveCount(15)
  await expect(page.getByText('Page 1 of 2')).toBeVisible()
  await expect(page.getByText('page-file-00.txt')).toBeVisible()
  await expect(page.getByText('page-file-14.txt')).toBeVisible()
  await expect(page.getByText('page-file-15.txt')).toHaveCount(0)

  await page.getByRole('button', { name: 'Next' }).click()
  await expect(page.getByText('Page 2 of 2')).toBeVisible()
  await expect(page.locator('tr.file-row')).toHaveCount(5)
  await expect(page.getByText('page-file-15.txt')).toBeVisible()

  await page.getByRole('button', { name: '30' }).click()
  await expect(page.getByText('Page 1 of 1')).toBeVisible()
  await expect(page.locator('tr.file-row')).toHaveCount(20)
})

test('history does not overflow horizontally on mobile with long names', async ({ page }) => {
  await signInWithToken(page)
  await page.setViewportSize({ width: 375, height: 812 })
  await page.route('**/api/list**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{
        file_name: 'this-is-a-very-long-file-name-that-should-truncate-on-mobile-and-not-cause-horizontal-scroll-overflow.png',
        file_size: 2048,
        creation_date_utc: '2026-04-17T01:00:00Z',
        expires_at_utc: null,
      }]),
    })
  })
  await page.route('**/api/meta/this-is-a-very-long-file-name-that-should-truncate-on-mobile-and-not-cause-horizontal-scroll-overflow.png', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        file_name: 'this-is-a-very-long-file-name-that-should-truncate-on-mobile-and-not-cause-horizontal-scroll-overflow.png',
        display_name: 'this-is-a-very-long-file-name-that-should-truncate-on-mobile-and-not-cause-horizontal-scroll-overflow.png',
        uploader: 'owner',
        upload_date_utc: '2026-04-17 01:00:00',
        download_name: 'this-is-a-very-long-file-name-that-should-truncate-on-mobile-and-not-cause-horizontal-scroll-overflow.png',
        file_size: 2048,
        mime_type: 'image/png',
      }),
    })
  })

  await page.goto('/#/files')
  await page.getByRole('button', { name: 'History' }).click()
  await expect(page.locator('tr.file-row')).toHaveCount(1)
  const visibleName = (await page.locator('.filename-text').first().textContent())?.trim() ?? ''
  expect(visibleName).toMatch(/^this-is-a-very-\.\.\.png$/)
  const metrics = await page.evaluate(() => ({
    docScrollWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
    tableScrollWidth: (document.querySelector('.table-wrap') as HTMLElement | null)?.scrollWidth ?? 0,
    tableClientWidth: (document.querySelector('.table-wrap') as HTMLElement | null)?.clientWidth ?? 0,
  }))
  expect(metrics.docScrollWidth).toBeLessThanOrEqual(metrics.viewportWidth + 1)
  expect(metrics.tableScrollWidth).toBeLessThanOrEqual(metrics.tableClientWidth + 1)
})

test('history keeps file extension visible for long filenames', async ({ page }) => {
  await signInWithToken(page)
  await page.route('**/api/list**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{
        file_name: 'this-is-an-extremely-long-file-name-that-would-normally-hide-the-extension-in-a-tight-column-layout.png',
        file_size: 1024,
        creation_date_utc: '2026-04-17T01:00:00Z',
        expires_at_utc: null,
      }]),
    })
  })

  await page.goto('/#/files')
  await page.getByRole('button', { name: 'History' }).click()
  await expect(page.locator('tr.file-row')).toHaveCount(1)
  await expect(page.locator('.filename-ext').first()).toHaveText('.png')
})

test('history actions menu closes when clicking outside', async ({ page }) => {
  await signInWithToken(page)
  await page.route('**/api/list**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{
        file_name: 'outside-close.txt',
        file_size: 12,
        creation_date_utc: '2026-04-17T01:00:00Z',
        expires_at_utc: null,
      }]),
    })
  })

  await page.goto('/#/files')
  await page.getByRole('button', { name: 'History' }).click()
  await page.getByLabel('Select outside-close.txt').check()
  await page.getByRole('button', { name: 'Actions' }).click()
  await expect(page.getByRole('button', { name: 'Delete Selected' })).toBeVisible()
  await page.locator('.toolbar').click()
  await expect(page.getByRole('button', { name: 'Delete Selected' })).toHaveCount(0)
})

test('history supports multi-select delete selected', async ({ page }) => {
  await signInWithToken(page)
  const deleted = new Set<string>()

  await page.route('**/api/list**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          file_name: 'bulk-delete-a.txt',
          file_size: 12,
          creation_date_utc: '2026-04-17T01:00:00Z',
          expires_at_utc: null,
        },
        {
          file_name: 'bulk-delete-b.txt',
          file_size: 16,
          creation_date_utc: '2026-04-17T01:00:00Z',
          expires_at_utc: null,
        },
      ]),
    })
  })
  await page.route('**/api/bulk-delete-*.txt', async (route) => {
    deleted.add(route.request().url().split('/').pop() ?? '')
    await route.fulfill({ status: 204, body: '' })
  })

  await page.goto('/#/files')
  await page.getByRole('button', { name: 'History' }).click()
  await page.getByLabel('Select bulk-delete-a.txt').check()
  await page.getByLabel('Select bulk-delete-b.txt').check()
  await page.getByRole('button', { name: 'Actions' }).click()
  await page.getByRole('button', { name: 'Delete Selected' }).click()
  await page.getByRole('checkbox', { name: /I understand that these files/ }).check()
  await page.getByRole('button', { name: 'Confirm delete' }).click()

  await expect.poll(() => deleted.size).toBe(2)
  await expect(page.locator('tr.file-row').filter({ hasText: 'bulk-delete-a.txt' })).toHaveCount(0)
  await expect(page.locator('tr.file-row').filter({ hasText: 'bulk-delete-b.txt' })).toHaveCount(0)
})

test('history downloads selected files as a zip archive', async ({ page }) => {
  await signInWithToken(page)
  let firstRaw = false
  let secondRaw = false

  await page.route('**/api/list**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          file_name: 'bulk-dl-a.txt',
          file_size: 12,
          creation_date_utc: '2026-04-17T01:00:00Z',
          expires_at_utc: null,
        },
        {
          file_name: 'bulk-dl-b.txt',
          file_size: 16,
          creation_date_utc: '2026-04-17T01:00:00Z',
          expires_at_utc: null,
        },
      ]),
    })
  })
  await page.route('**/api/bulk-dl-a.txt?raw=1', async (route) => {
    firstRaw = true
    await route.fulfill({ status: 200, contentType: 'text/plain', body: 'bulk-a' })
  })
  await page.route('**/api/bulk-dl-b.txt?raw=1', async (route) => {
    secondRaw = true
    await route.fulfill({ status: 200, contentType: 'text/plain', body: 'bulk-b' })
  })

  await page.goto('/#/files')
  await page.getByRole('button', { name: 'History' }).click()
  await page.getByLabel('Select all files').check()
  await page.getByRole('button', { name: 'Actions' }).click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download Selected' }).click()
  const download = await downloadPromise

  expect(download.suggestedFilename()).toMatch(/^yaemipaste-history-\d+\.zip$/)
  await expect.poll(() => firstRaw && secondRaw).toBeTruthy()
})

test('settings shows passkey controls and branding copy', async ({ page }) => {
  await signInWithAccount(page)
  await page.route('**/auth/passkeys', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      })
      return
    }
    await route.fallback()
  })

  await page.goto('/#/files')
  await page.getByRole('button', { name: 'Preferences' }).click()
  await expect(page.getByTestId('settings-layer').getByText('yaemipaste')).toBeVisible()
  await expect(page.getByTestId('open-passkey-modal')).toBeVisible()
  await expect(page.getByTestId('settings-open-account')).toBeVisible()
  await page.getByTestId('open-passkey-modal').click()
  await expect(page.getByTestId('passkey-modal')).toBeVisible()
  await expect(page.getByTestId('passkey-add-btn')).toBeVisible()
})

test('settings keeps passkey removal available while sign-in is disabled', async ({ page }) => {
  await signInWithAccount(page)
  await page.route('**/auth/admin/public-settings', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        app_name: 'yaemipaste',
        public_title: 'yaemipaste',
        registration_enabled: true,
        base_api_url: '',
        file_size_limit_bytes: 0,
        file_size_limit_unlimited: false,
        upload_access_mode: 'private',
        passkeys_enabled: false,
      }),
    })
  })
  let deleted = false
  await page.route('**/auth/passkeys', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 7, credential_id: 'disabled-passkey', created_at: 1_775_000_000, last_used_at: null, transports: ['internal'] }]),
    })
  })
  await page.route('**/auth/passkeys/7', async (route) => {
    deleted = true
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ detail: 'Passkey deleted' }) })
  })

  await page.goto('/#/files')
  await page.getByRole('button', { name: 'Preferences' }).click()
  await page.getByTestId('open-passkey-modal').click()
  await expect(page.getByTestId('passkey-add-btn')).toHaveCount(0)
  await page.getByTestId('passkey-row').getByRole('button', { name: 'Delete' }).click()
  await expect.poll(() => deleted).toBeTruthy()
})

test('passkey can be renamed via the pencil icon', async ({ page }) => {
  await signInWithAccount(page)
  await page.route('**/auth/passkeys', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 3, credential_id: 'yubikey-cred', created_at: 1_775_000_000, last_used_at: null, transports: ['usb'], name: null }]),
    })
  })
  let renamed = false
  await page.route('**/auth/passkeys/3', async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback()
    renamed = route.request().postDataJSON().name === 'My YubiKey'
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ detail: 'Passkey renamed' }) })
  })

  await page.goto('/#/files')
  await page.getByRole('button', { name: 'Preferences' }).click()
  await page.getByTestId('open-passkey-modal').click()
  await expect(page.getByTestId('passkey-name')).toHaveText('Passkey')
  await page.getByTestId('passkey-rename-btn').click()
  await page.getByTestId('passkey-rename-input').fill('My YubiKey')
  await page.getByTestId('passkey-rename-input').press('Enter')
  await expect.poll(() => renamed).toBeTruthy()
  await expect(page.getByTestId('passkey-name')).toHaveText('My YubiKey')
})

test('admin Preferences control opens and fades closed on desktop and mobile', async ({ page }) => {
  await signInAsAdmin(page)
  await mockAdminApi(page)
  await page.goto('/admin')

  const isMobile = (page.viewportSize()?.width ?? 1280) <= 600
  if (isMobile) await openMobileNavigationMenu(page)
  const preferences = page.getByTestId(isMobile ? 'mobile-nav-preferences' : 'desktop-preferences')
  await expect(preferences).toBeVisible()
  const enterTransition = page.waitForFunction(() =>
    document.querySelector('[data-testid="settings-layer"]')?.classList.contains('settings-layer-enter-active'),
  )
  await preferences.click()
  await enterTransition

  const layer = page.getByTestId('settings-layer')
  await expect(layer).toBeVisible()
  await expect(layer.locator('.settings-panel')).toBeVisible()
  await expect(preferences).toBeVisible()
  await expect(preferences).toHaveAttribute('aria-expanded', 'true')
  await expect.poll(() => layer.evaluate((element) => getComputedStyle(element).transitionProperty)).toContain('opacity')

  const leaveTransition = page.waitForFunction(() =>
    document.querySelector('[data-testid="settings-layer"]')?.classList.contains('settings-layer-leave-active'),
  )
  await layer.locator('.overlay').click({ position: { x: 8, y: 8 } })
  await leaveTransition
  await expect(layer).toBeHidden()
  await expect(preferences).toHaveAttribute('aria-expanded', 'false')
})

test('mobile Preferences toggles the detached settings panel closed', async ({ page }) => {
  await signInAsAdmin(page)
  await mockAdminApi(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/admin')

  await openMobileNavigationMenu(page)
  const preferences = page.getByTestId('mobile-nav-preferences')
  await preferences.click()
  await expect(page.getByTestId('settings-layer')).toBeVisible()
  await expect(preferences).toBeVisible()
  await expect(preferences).toHaveAttribute('aria-expanded', 'true')
  const panel = page.locator('.settings-panel')
  const enteringPanelBox = await panel.boundingBox()
  const preferencesBox = await preferences.boundingBox()
  const enteringTabbarBox = await page.getByTestId('mobile-tabbar').boundingBox()
  expect(enteringPanelBox).not.toBeNull()
  expect(preferencesBox).not.toBeNull()
  expect(enteringTabbarBox).not.toBeNull()
  if (enteringPanelBox && preferencesBox && enteringTabbarBox) {
    expect(enteringPanelBox.x).toBeCloseTo(enteringTabbarBox.x, 1)
    expect(enteringPanelBox.x + enteringPanelBox.width).toBeCloseTo(enteringTabbarBox.x + enteringTabbarBox.width, 1)
  }
  await expect.poll(() => panel.evaluate((element) => getComputedStyle(element).transform)).toBe('none')
    const panelBox = await panel.boundingBox()
    const tabbarBox = await page.getByTestId('mobile-tabbar').boundingBox()
    expect(panelBox).not.toBeNull()
    expect(tabbarBox).not.toBeNull()
    if (panelBox && tabbarBox) {
      expect(panelBox.x).toBeCloseTo(tabbarBox.x, 1)
      expect(panelBox.x + panelBox.width).toBeCloseTo(tabbarBox.x + tabbarBox.width, 1)
    }
    if (panelBox && preferencesBox) {
      expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(preferencesBox.y - 6)
    }
  await page.getByTestId('settings-layer').locator('.overlay').click({ position: { x: 8, y: 8 } })
  await expect(page.getByTestId('settings-layer')).toBeHidden()
})

test('mobile Admin navigation controls stay detached and mobile nav collapses cleanly', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 1280) > 600, 'mobile-only navigation regression')
  await signInAsAdmin(page)
  await mockAdminApi(page)
  await page.goto('/admin')

  const tabStrip = page.locator('.admin-tabs')
  const tabsRow = page.locator('.admin-tabs-row')
  const leftControl = page.getByRole('button', { name: 'Scroll admin sections left' })
  const rightControl = page.getByRole('button', { name: 'Scroll admin sections right' })
  await expect(tabStrip).toBeVisible()
  await expect(leftControl).toBeVisible()
  await expect(rightControl).toBeVisible()

  const initialStripBox = await tabStrip.boundingBox()
  const initialRowBox = await tabsRow.boundingBox()
  const initialLeftBox = await leftControl.boundingBox()
  const initialRightBox = await rightControl.boundingBox()
  expect(initialStripBox).not.toBeNull()
  expect(initialRowBox).not.toBeNull()
  expect(initialLeftBox).not.toBeNull()
  expect(initialRightBox).not.toBeNull()
  if (initialStripBox && initialRowBox && initialLeftBox && initialRightBox) {
    expect(initialLeftBox.x + initialLeftBox.width).toBeLessThanOrEqual(initialStripBox.x + 1)
    expect(initialStripBox.x + initialStripBox.width).toBeLessThanOrEqual(initialRightBox.x + 1)
    expect(Math.abs((initialStripBox.x + initialStripBox.width / 2) - (initialRowBox.x + initialRowBox.width / 2))).toBeLessThanOrEqual(2)
    expect(initialLeftBox.width).toBeCloseTo(initialRightBox.width, 1)
    expect(initialLeftBox.height).toBeCloseTo(initialRightBox.height, 1)
  }
  const tabLabelMetrics = await tabStrip.locator('button').evaluateAll((buttons) => buttons.map((button) => ({
    label: button.textContent?.trim(),
    scrollWidth: button.scrollWidth,
    clientWidth: button.clientWidth,
  })))
  expect(tabLabelMetrics.every(({ scrollWidth, clientWidth }) => scrollWidth <= clientWidth + 1)).toBeTruthy()
  const activeMobileLabel = page.locator('.mobile-tabbar-main button.active .mobile-tab-label')
  const activeMobileLabelMetrics = await activeMobileLabel.evaluate((element) => ({
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
  }))
  expect(activeMobileLabelMetrics.scrollWidth).toBeLessThanOrEqual(activeMobileLabelMetrics.clientWidth + 1)
  await expect(leftControl).toBeDisabled()
  await expect(rightControl).toBeEnabled()

  const initialLeftX = initialLeftBox?.x ?? 0
  const initialLeftY = initialLeftBox?.y ?? 0
  const initialRightX = initialRightBox?.x ?? 0
  const initialRightY = initialRightBox?.y ?? 0
  await rightControl.click()
  await expect.poll(() => tabStrip.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
  await expect(leftControl).toBeEnabled()
  const scrolledLeftBox = await leftControl.boundingBox()
  const scrolledRightBox = await rightControl.boundingBox()
  expect(scrolledLeftBox).not.toBeNull()
  expect(scrolledRightBox).not.toBeNull()
  if (scrolledLeftBox && scrolledRightBox) {
    expect(scrolledLeftBox.x).toBeCloseTo(initialLeftX, 1)
    expect(scrolledLeftBox.y).toBeCloseTo(initialLeftY, 1)
    expect(scrolledRightBox.x).toBeCloseTo(initialRightX, 1)
    expect(scrolledRightBox.y).toBeCloseTo(initialRightY, 1)
  }

  const mobileTabbar = page.getByTestId('mobile-tabbar')
  const mobileToggle = page.getByTestId('mobile-nav-toggle')
  const expandedMainBox = await page.locator('.mobile-tabbar-main').boundingBox()
  expect(expandedMainBox).not.toBeNull()
  await expect(mobileToggle).toHaveAttribute('aria-expanded', 'true')
  await mobileToggle.click()
  await expect(mobileToggle).toHaveAttribute('aria-expanded', 'false')
  await expect(mobileTabbar).toHaveClass(/is-collapsed/)
  await expect(page.locator('.mobile-tabbar-main')).toHaveCount(0)
  const collapsedNavBox = await mobileTabbar.boundingBox()
  expect(collapsedNavBox).not.toBeNull()
  if (expandedMainBox && collapsedNavBox) expect(collapsedNavBox.width).toBeLessThan(expandedMainBox.width)

  await mobileToggle.click()
  await expect(mobileToggle).toHaveAttribute('aria-expanded', 'true')
  await expect(mobileTabbar).not.toHaveClass(/is-collapsed/)
  await expect(page.locator('.mobile-tabbar-main')).toBeVisible()
  await expect(page.locator('.mobile-tabbar-main .mobile-tab-label')).toHaveCount(3)
})

test('admin section changes keep the workspace shell mounted', async ({ page }) => {
  await signInAsAdmin(page)
  await mockAdminApi(page)
  await page.goto('/admin')

  const workspaceShell = await page.locator('.workspace-shell').elementHandle()
  const adminHeader = await page.locator('.admin-header').elementHandle()
  const adminTabs = await page.locator('.admin-tabs').elementHandle()
  const initialHeaderBox = await page.locator('.admin-header').boundingBox()
  expect(workspaceShell).not.toBeNull()
  expect(adminHeader).not.toBeNull()
  expect(adminTabs).not.toBeNull()
  expect(initialHeaderBox).not.toBeNull()

  const webhooksTransition = page.waitForFunction(() => document.querySelector('.admin-content-enter-active') !== null)
  await page.locator('.admin-tabs').getByRole('button', { name: 'Webhooks', exact: true }).click()
  await webhooksTransition
  await expect(page).toHaveURL(/\/admin\/webhooks$/)
  await expect(page.getByRole('heading', { name: 'Create webhook' })).toBeVisible()
  expect(await workspaceShell?.evaluate((element) => element.isConnected)).toBe(true)
  expect(await adminHeader?.evaluate((element) => element.isConnected)).toBe(true)
  expect(await adminTabs?.evaluate((element) => element.isConnected)).toBe(true)
  const webhooksHeaderBox = await page.locator('.admin-header').boundingBox()
  expect(webhooksHeaderBox).not.toBeNull()
  if (initialHeaderBox && webhooksHeaderBox) {
    expect(webhooksHeaderBox.x).toBeCloseTo(initialHeaderBox.x, 1)
    expect(webhooksHeaderBox.y).toBeCloseTo(initialHeaderBox.y, 1)
    expect(webhooksHeaderBox.width).toBeCloseTo(initialHeaderBox.width, 1)
    expect(webhooksHeaderBox.height).toBeCloseTo(initialHeaderBox.height, 1)
  }

  const auditTransition = page.waitForFunction(() => document.querySelector('.admin-content-enter-active') !== null)
  await page.locator('.admin-tabs').getByRole('button', { name: 'Audit', exact: true }).click()
  await auditTransition
  await expect(page).toHaveURL(/\/admin\/audit$/)
  await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible()
  expect(await workspaceShell?.evaluate((element) => element.isConnected)).toBe(true)
  expect(await adminHeader?.evaluate((element) => element.isConnected)).toBe(true)
  expect(await adminTabs?.evaluate((element) => element.isConnected)).toBe(true)
})

test('admin branding fields are visible and use responsive layout', async ({ page }) => {
  await signInAsAdmin(page)
  await mockAdminApi(page)
  await page.goto('/admin')
  await page.locator('.admin-tabs').getByRole('button', { name: 'Settings', exact: true }).click()

  const branding = page.locator('.settings-group-branding')
  const appName = page.getByLabel('App name')
  const publicTitle = page.getByLabel('Public title')
  const baseApiUrl = page.getByLabel('Base API URL')
  await expect(branding).toBeVisible()
  await expect(appName).toBeVisible()
  await expect(publicTitle).toBeVisible()
  await expect(baseApiUrl).toBeVisible()

  await page.setViewportSize({ width: 1280, height: 900 })
  const desktopAppBox = await appName.boundingBox()
  const desktopTitleBox = await publicTitle.boundingBox()
  const desktopApiBox = await baseApiUrl.boundingBox()
  expect(desktopAppBox).not.toBeNull()
  expect(desktopTitleBox).not.toBeNull()
  expect(desktopApiBox).not.toBeNull()
  if (desktopAppBox && desktopTitleBox && desktopApiBox) {
    expect(Math.abs(desktopAppBox.y - desktopTitleBox.y)).toBeLessThanOrEqual(2)
    expect(desktopApiBox.y).toBeGreaterThan(desktopAppBox.y + desktopAppBox.height)
    expect(desktopApiBox.width).toBeGreaterThan(desktopAppBox.width)
  }

  await page.setViewportSize({ width: 600, height: 900 })
  const mobileAppBox = await appName.boundingBox()
  const mobileTitleBox = await publicTitle.boundingBox()
  const mobileApiBox = await baseApiUrl.boundingBox()
  expect(mobileAppBox).not.toBeNull()
  expect(mobileTitleBox).not.toBeNull()
  expect(mobileApiBox).not.toBeNull()
  if (mobileAppBox && mobileTitleBox && mobileApiBox) {
    expect(mobileTitleBox.y).toBeGreaterThan(mobileAppBox.y + mobileAppBox.height)
    expect(mobileApiBox.y).toBeGreaterThan(mobileTitleBox.y + mobileTitleBox.height)
  }
})

test('guest uploads persist Anonymous as the uploader', async ({ page }) => {
  await page.route('**/auth/admin/public-settings', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ upload_access_mode: 'public' }),
    })
  })

  let uploadedMeta: Record<string, unknown> | null = null
  await page.route('**/api/', async (route) => {
    expect(route.request().headers().authorization).toBeUndefined()
    const body = route.request().postDataBuffer()
    if (!body) throw new Error('Missing upload body')
    uploadedMeta = JSON.parse(extractMultipartField(body, route.request().headers()['content-type'] ?? '', 'meta').toString('utf8'))
    await route.fulfill({ status: 200, contentType: 'text/plain', body: `${APP_ORIGIN}/anonymous-owner.txt` })
  })

  await page.goto('/files')
  await page.locator('input[type="file"]').setInputFiles({
    name: 'anonymous-owner.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('anonymous upload'),
  })

  await expect.poll(() => uploadedMeta?.uploader).toBe('Anonymous')
})

test('account page changes the password and logs out other devices', async ({ page }) => {
  await signInWithAccount(page)
  let changePayload: any = null
  let logoutAllCalled = false

  await page.route('**/auth/password/change', async (route) => {
    changePayload = route.request().postDataJSON()
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    })
  })
  await page.route('**/auth/logout-all-devices', async (route) => {
    logoutAllCalled = true
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    })
  })

  await page.goto('/account-settings')
  await expect(page.getByTestId('account-page')).toBeVisible()

  await page.getByTestId('account-current-password').fill('old-secret-123')
  await page.getByTestId('account-new-password').fill('new-secret-123')
  await page.getByTestId('account-confirm-password').fill('new-secret-123')
  await page.getByTestId('account-change-password').click()
  await expect(page.getByTestId('account-password-success')).toBeVisible()
  await expect.poll(() => changePayload).toEqual({
    old_password: 'old-secret-123',
    new_password: 'new-secret-123',
  })

  await page.getByTestId('account-logout-all').click()
  await expect.poll(() => logoutAllCalled).toBeTruthy()
})

test('admin logout asks for confirmation before signing out', async ({ page }) => {
  await signInAsAdmin(page)
  await mockAdminApi(page)
  await page.goto('/admin')
  await expect(page.getByRole('heading', { name: 'Admin panel' })).toBeVisible()

  const dialog = page.getByTestId('account-logout-confirm')
  await page.getByRole('button', { name: 'Logout' }).click()
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Log out of yaemipaste?')

  // Cancel keeps the session and stays on the admin panel.
  await page.getByTestId('account-logout-confirm-cancel').click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Admin panel' })).toBeVisible()

  // Confirming signs out and clears the session.
  await page.getByRole('button', { name: 'Logout' }).click()
  await page.getByTestId('account-logout-confirm-submit').click()
  await expect(page).toHaveURL(/\/login$/)
  const remaining = await page.evaluate(() => ({
    jwt: localStorage.getItem('rp_jwt'),
    token: localStorage.getItem('rp_token'),
  }))
  expect(remaining.jwt).toBeNull()
  expect(remaining.token).toBeNull()
})

test('account page customizes the avatar and changes the password', async ({ page }) => {
  await signInWithAccount(page)
  let changePayload: any = null
  await page.route('**/auth/password/change', async (route) => {
    changePayload = route.request().postDataJSON()
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ detail: 'Password changed' }),
    })
  })

  await page.goto('/#/files')
  const sidebarChip = page.getByTestId('sidebar-account')
  let usedSidebarChip = false
  try {
    await sidebarChip.waitFor({ state: 'visible', timeout: 3000 })
    usedSidebarChip = true
  } catch {
    // Sidebar is hidden on mobile viewports.
  }
  if (usedSidebarChip) {
    await sidebarChip.click()
  } else {
    await page.getByTestId('mobile-nav-preferences').click()
    await page.getByTestId('settings-open-account').click()
  }
  await expect(page).toHaveURL(/\/account-settings$/)
  const accountPage = page.getByTestId('account-page')
  await expect(accountPage.getByText('test-user')).toBeVisible()

  // Avatar: pick an orange tile, then upload a picture.
  await accountPage.getByTestId('account-avatar-color-d97706').click()
  await accountPage.getByTestId('account-avatar-file').setInputFiles({
    name: 'avatar.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7fM7cAAAAASUVORK5CYII=',
      'base64',
    ),
  })
  const avatarImg = accountPage.locator('.profile-card img')
  await expect(avatarImg).toBeVisible()
  await expect(avatarImg).toHaveAttribute('src', /^data:image\/png/)

  // Password change flow with the inline form.
  await accountPage.getByTestId('account-current-password').fill('old-secret-123')
  await accountPage.getByTestId('account-new-password').fill('new-secret-123')
  await accountPage.getByTestId('account-confirm-password').fill('new-secret-123')
  await accountPage.getByTestId('account-change-password').click()
  await expect(accountPage.getByTestId('account-password-success')).toBeVisible()
  await expect.poll(() => changePayload).toEqual({
    old_password: 'old-secret-123',
    new_password: 'new-secret-123',
  })

  // The picture choice survives a reload (local persistence).
  await page.reload({ waitUntil: 'networkidle' })
  await expect(page.locator('.profile-card img')).toHaveAttribute('src', /^data:image\/png/)
})

test('passkey modal surfaces non-JSON API errors without JSON parse crashes', async ({ page }) => {
  await signInWithAccount(page)
  await page.route('**/auth/passkeys', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 404,
        contentType: 'text/plain',
        body: 'Passkeys endpoint is unavailable',
      })
      return
    }
    await route.fallback()
  })

  await page.goto('/#/files')
  await page.getByRole('button', { name: 'Preferences' }).click()
  await page.getByTestId('open-passkey-modal').click()
  await expect(page.getByTestId('passkey-modal')).toBeVisible()
  const error = page.locator('.passkey-error')
  await expect(error).toContainText('Passkeys endpoint is unavailable')
  await expect(error).not.toContainText('Unexpected token')
})

test('passkey registration accepts wrapped browser options', async ({ page }) => {
  await signInWithAccount(page)
  await mockWebAuthn(page)

  let finishBody: any = null
  await page.route('**/auth/passkeys', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      })
      return
    }
    await route.fallback()
  })
  await page.route('**/auth/passkeys/register/begin', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        publicKey: {
          challenge: base64Url([1, 2, 3, 4]),
          rp: { name: 'yaemipaste' },
          user: { id: base64Url([5, 6, 7]), name: 'test-user', displayName: 'test-user' },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
          exclude_credentials: [{ type: 'public-key', id: base64Url([8, 9]), transports: ['internal'] }],
        },
      }),
    })
  })
  await page.route('**/auth/passkeys/register/finish', async (route) => {
    finishBody = route.request().postDataJSON()
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  })

  await page.goto('/#/files')
  await page.getByRole('button', { name: 'Preferences' }).click()
  await page.getByTestId('open-passkey-modal').click()
  await page.getByTestId('passkey-add-btn').click()

  await expect.poll(() => page.evaluate(() => (window as any).__lastCreateOptions)).toEqual({
    challenge: [1, 2, 3, 4],
    userId: [5, 6, 7],
    excludeId: [8, 9],
  })
  await expect.poll(() => finishBody?.credential?.id).toBe('mock-passkey')
})

test('passkey registration reports malformed options clearly', async ({ page }) => {
  await signInWithAccount(page)
  await mockWebAuthn(page)

  await page.route('**/auth/passkeys', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
      return
    }
    await route.fallback()
  })
  await page.route('**/auth/passkeys/register/begin', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ publicKey: { user: { id: base64Url([1]) } } }),
    })
  })

  await page.goto('/#/files')
  await page.getByRole('button', { name: 'Preferences' }).click()
  await page.getByTestId('open-passkey-modal').click()
  await page.getByTestId('passkey-add-btn').click()

  await expect(page.locator('.passkey-error')).toContainText('Could not register passkey')
})

for (const viewport of [
  { name: 'desktop', width: 1280, height: 720 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 375, height: 812 },
]) {
  test(`settings and expiry controls are usable on ${viewport.name}`, async ({ page }) => {
    await signInWithToken(page)
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await page.goto('/#/files')

    await expandExpiryIfCollapsed(page)
    await page.getByTestId('expiry-trigger').click()
    await expect(page.getByTestId('expiry-options')).toBeVisible()
    await page.getByTestId('expiry-option-7d').click()
    if (viewport.width <= 600) {
      await expect(page.getByTestId('expiry-mobile-toggle')).toContainText('7 days')
    } else {
      await expect(page.getByTestId('expiry-trigger')).toContainText('7 days')
    }

    await page.getByRole('button', { name: 'Preferences' }).click()
    await expect(page.getByText('Settings')).toBeVisible()
    await expect(page.getByTestId('settings-open-account')).toBeVisible()

    const settingsBox = await page.locator('.settings-panel').boundingBox()
    const expiryBox = await page.getByTestId('expiry-menu').boundingBox()
    expect(settingsBox).not.toBeNull()
    expect(expiryBox).not.toBeNull()
    if (settingsBox && expiryBox) {
      expect(settingsBox.y + settingsBox.height).toBeLessThanOrEqual(viewport.height)
      expect(expiryBox.y + expiryBox.height).toBeLessThanOrEqual(viewport.height)
    }

    await page.getByTestId('settings-open-account').click()
    await expect(page).toHaveURL(/\/account-settings$/)
    await page.getByTestId('account-logout').click()
    await expect(page.getByTestId('account-logout-confirm')).toBeVisible()
    await expect(page.getByTestId('account-logout-confirm')).toContainText('Log out of yaemipaste?')
    await page.getByTestId('account-logout-confirm-submit').click()
    await expect(page).toHaveURL(/\/login$/)
    // Logout must actually clear the session, not just navigate away.
    const remaining = await page.evaluate(() => ({
      jwt: localStorage.getItem('rp_jwt'),
      token: localStorage.getItem('rp_token'),
      username: localStorage.getItem('rp_username'),
    }))
    expect(remaining.jwt).toBeNull()
    expect(remaining.token).toBeNull()
    expect(remaining.username).toBeNull()
    // Navigate in-SPA (a hard goto would re-run the session init script and
    // re-log-in the mock user); the guard must bounce the logged-out visitor
    // back to /login.
    await page.evaluate(() => {
      history.pushState({}, '', '/files')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await expect(page).toHaveURL(/\/login$/)
  })

  test(`register page is centered on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await page.goto('/register')

    const box = await page.getByTestId('register-center').boundingBox()
    expect(box).not.toBeNull()
    if (!box) return

    const centerX = box.x + box.width / 2
    const centerY = box.y + box.height / 2
    expect(Math.abs(centerX - viewport.width / 2)).toBeLessThanOrEqual(1)
    expect(Math.abs(centerY - viewport.height / 2)).toBeLessThanOrEqual(1)

    await page.locator('input[autocomplete="username"]').click()
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
  })
}

test('shift click reveals Forever expiry and omits expire header', async ({ page }) => {
  await signInWithToken(page)
  await mockClipboard(page)
  let uploadExpiry = '__unset__'
  await page.route('**/api/', async (route) => {
    uploadExpiry = route.request().headers().expire ?? ''
    await route.fulfill({
      status: 200,
      contentType: 'text/plain',
      body: `${APP_ORIGIN}/never-check.txt`,
    })
  })

  await page.goto('/#/files')
  await expandExpiryIfCollapsed(page)
  await page.getByTestId('expiry-trigger').click()
  await expect(page.getByTestId('expiry-option-never')).toHaveCount(0)
  await page.getByTestId('expiry-trigger').click({ modifiers: ['Shift'] })
  await page.getByTestId('expiry-option-never').click()
  if (await page.getByTestId('expiry-mobile-toggle').isVisible()) {
    await expect(page.getByTestId('expiry-mobile-toggle')).toContainText('Forever')
  } else {
    await expect(page.getByTestId('expiry-trigger')).toContainText('Forever')
  }
  await page.locator('input[type="file"]').setInputFiles({
    name: 'never-check.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('never'),
  })
  await expect.poll(() => uploadExpiry).toBe('')
})

for (const viewport of [
  { name: 'desktop', width: 1280, height: 720 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 375, height: 812 },
]) {
  test(`login page is centered on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await page.goto('/#/login')

    const box = await page.getByTestId('login-center').boundingBox()
    expect(box).not.toBeNull()
    if (!box) return

    const centerX = box.x + box.width / 2
    const centerY = box.y + box.height / 2
    expect(Math.abs(centerX - viewport.width / 2)).toBeLessThanOrEqual(1)
    expect(Math.abs(centerY - viewport.height / 2)).toBeLessThanOrEqual(1)
  })
}

test('login page offers a passkey sign-in action', async ({ page }) => {
  await page.goto('/#/login')
  await expect(page.getByRole('button', { name: 'Token' })).toHaveCount(0)
  await expect(page.getByTestId('passkey-login-btn')).toBeDisabled()
  await page.locator('input[autocomplete="username"]').fill('test-user')
  await expect(page.getByTestId('passkey-login-btn')).toBeEnabled()
})

test('login page shows the globally-configured logo', async ({ page }) => {
  const logoDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  await page.route('**/auth/admin/public-settings', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ logo_type: 'upload', branding_logo: logoDataUrl, accent_color: '#4ade80' }),
    })
  })
  await page.goto('/#/login')
  await expect(page.locator('.login-brand-mark img')).toHaveAttribute('src', logoDataUrl)
  await expect(page.locator('.login-brand-mark svg')).toHaveCount(0)
})

test('login page explains when registration is disabled', async ({ page }) => {
  await page.route('**/auth/admin/public-settings', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ registration_enabled: false }),
    })
  })

  await page.goto('/#/login')
  await expect(page.getByText('Registration is disabled.', { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Register' })).toHaveCount(0)
  const footer = page.locator('.form-footer')
  const loginButton = footer.getByRole('button', { name: 'Login' })
  const footerBox = await footer.boundingBox()
  const loginBox = await loginButton.boundingBox()
  expect(footerBox).not.toBeNull()
  expect(loginBox).not.toBeNull()
  if (footerBox && loginBox) expect(Math.abs(footerBox.width - loginBox.width)).toBeLessThanOrEqual(1)
})

test('login password field toggles visibility', async ({ page }) => {
  await page.goto('/#/login')
  const passwordField = page.locator('input[autocomplete="current-password"]')
  await expect(passwordField).toHaveAttribute('type', 'password')
  await page.getByRole('button', { name: 'Show password' }).click()
  await expect(passwordField).toHaveAttribute('type', 'text')
  await page.getByRole('button', { name: 'Hide password' }).click()
  await expect(passwordField).toHaveAttribute('type', 'password')
})

test('login remember me unchecked stores auth in session storage', async ({ page }) => {
  await page.route('**/auth/login', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        access_token: 'jwt-session',
        paste_token: 'token-session',
        username: 'session-user',
      }),
    })
  })
  await page.route('**/api/list**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  })

  await page.goto('/#/login')
  await page.locator('input[autocomplete="username"]').fill('session-user')
  await page.locator('input[autocomplete="current-password"]').fill('password123')
  await page.getByLabel('remember me').uncheck()
  await page.getByRole('button', { name: 'Login' }).click()

  await expect(page).toHaveURL(/\/files$/)
  await expect.poll(() => page.evaluate(() => ({
    localToken: localStorage.getItem('rp_token'),
    sessionToken: sessionStorage.getItem('rp_token'),
    remember: localStorage.getItem('rp_remember_me'),
  }))).toEqual({
    localToken: null,
    sessionToken: 'token-session',
    remember: '0',
  })
})

test('admin route is guarded and sidebar entry only appears for admins', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('rp_token', 'user-paste-token')
    localStorage.setItem('rp_username', 'regular-user')
    localStorage.setItem('rp_jwt', 'regular-jwt')
    localStorage.setItem('rp_is_admin', '0')
  })

  await page.goto('/#/files')
  await expect(page.getByTestId('desktop-nav-admin')).toHaveCount(0)

  await page.goto('/admin')
  await expect(page).toHaveURL(/\/files$/)
  await expect(page.getByRole('heading', { name: 'Admin panel' })).toHaveCount(0)

  await signInAsAdmin(page)
  await mockAdminApi(page)
  await page.goto('/#/files')
  const adminNavTestId = (page.viewportSize()?.width ?? 1280) <= 600 ? 'mobile-nav-admin' : 'desktop-nav-admin'
  await expect(page.getByTestId(adminNavTestId)).toBeVisible()
  await page.getByTestId(adminNavTestId).click()
  await expect(page).toHaveURL(/\/admin$/)
  await expect(page.getByRole('heading', { name: 'Admin panel' })).toBeVisible()
})

test('admin claim submits one-time token and stores admin session', async ({ page }) => {
  let claimPayload: Record<string, unknown> | null = null

  // The claim redirects straight into /admin, whose mount immediately loads
  // the full admin dashboard with the newly claimed JWT. Without this, those
  // requests race a real, unmocked backend that rejects the fake
  // claimed-jwt with a genuine 401, clearing the session this test is
  // trying to verify. This test only cares about the claim flow itself, so
  // minimal empty-but-valid data is enough - the specific claim/claim-status
  // routes registered below take precedence over this catch-all.
  await page.route('**/auth/admin/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    const emptyArrayEndpoints = ['users', 'uploads', 'webhooks', 'audit', 'registration-tokens']
    if (path.endsWith('/webhooks/deliveries')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
    }
    if (emptyArrayEndpoints.some((endpoint) => path.endsWith(`/${endpoint}`))) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
    }
    if (path.endsWith('/dashboard')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          total_disk_usage_bytes: 0, upload_count: 0, user_count: 0, suspended_user_count: 0, admin_count: 0,
          users: [], recent_uploads: [], recent_audit: [], failed_webhook_deliveries: [],
          config_status: { registration_enabled: true }, warnings: [],
        }),
      })
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  })

  await page.route('**/auth/admin/claim/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ admin_exists: false, pending_claim: true, claim_available: true }),
    })
  })
  await page.route('**/auth/admin/claim', async (route) => {
    claimPayload = route.request().postDataJSON()
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        access_token: 'claimed-jwt',
        paste_token: 'claimed-paste-token',
        username: 'claimed-admin',
        is_admin: true,
      }),
    })
  })

  await page.goto('/admin/claim')
  await expect(page.getByRole('heading', { name: 'Claim administrator access' })).toBeVisible()
  await page.getByLabel('Claim token').fill('one-time-claim-token')
  await page.getByLabel('Admin username').fill('claimed-admin')
  await page.getByLabel('Admin password').fill('strong-password')
  await page.getByLabel(/Custom upload token/).fill('custom-upload-token')
  await page.getByRole('button', { name: 'Claim admin' }).click()

  await expect.poll(() => claimPayload).toEqual({
    claim_token: 'one-time-claim-token',
    username: 'claimed-admin',
    password: 'strong-password',
    upload_token: 'custom-upload-token',
  })
  await expect(page).toHaveURL(/\/admin$/)
  await expect.poll(() => page.evaluate(() => ({
    jwt: localStorage.getItem('rp_jwt'),
    token: localStorage.getItem('rp_token'),
    username: localStorage.getItem('rp_username'),
    isAdmin: localStorage.getItem('rp_is_admin'),
  }))).toEqual({
    jwt: 'claimed-jwt',
    token: 'claimed-paste-token',
    username: 'claimed-admin',
    isAdmin: '1',
  })
})

test('admin dashboard paginates users and uploads, filters uploads, and saves safe settings', async ({ page }) => {
  await signInAsAdmin(page)
  await mockAdminApi(page)

  await page.goto('/admin')
  await expect(page.getByRole('heading', { name: 'Admin panel' })).toBeVisible()
  await expect(page.getByText('Storage usage is above warning threshold')).toBeVisible()
  const recentUploads = page.getByRole('heading', { name: 'Recent uploads' }).locator('..').locator('..')
  await expect(recentUploads.getByText('ShareX screenshot.png', { exact: true })).toBeVisible()
  await expect(recentUploads.getByLabel('Uploaded with ShareX')).toBeVisible()
  await expect(recentUploads.getByText('files/upload-1.txt', { exact: true })).toHaveCount(0)
  await expect(page.getByText('settings.update')).toBeVisible()

  await page.getByRole('button', { name: 'Users' }).click()
  await expect(page.getByText('1 of 2')).toBeVisible()
  await expect(page.getByText('user-1', { exact: true })).toBeVisible()
  await expect(page.getByText('user-11', { exact: true })).toHaveCount(0)
  await page.locator('[aria-label="User pagination"]').getByRole('button', { name: 'Next' }).click()
  await expect(page.getByText('2 of 2')).toBeVisible()
  await expect(page.getByText('user-11', { exact: true })).toBeVisible()

  await page.locator('.admin-tabs').getByRole('button', { name: 'Uploads', exact: true }).click()
  await expect(page.getByText('1-12 of 12')).toBeVisible()
  const ownerFilter = page.locator('.upload-toolbar .custom-select-trigger').first()
  const searchInput = page.getByLabel('Search uploads')
  await expect.poll(async () => {
    const [ownerBox, searchBox] = await Promise.all([ownerFilter.boundingBox(), searchInput.boundingBox()])
    return ownerBox && searchBox ? Math.abs(ownerBox.height - searchBox.height) : -1
  }).toBeLessThan(1)
  // The upload search box should stretch to fill the toolbar, not stay tiny.
  const toolbarBox = await page.locator('.upload-toolbar').boundingBox()
  const searchBox = await searchInput.boundingBox()
  if (toolbarBox && searchBox) expect(searchBox.width).toBeGreaterThan(toolbarBox.width * 0.4)
  const expiringRow = page.locator('.uploads-table tbody tr').filter({ hasText: 'expiring-paste.txt' }).first()
  await expiringRow.getByRole('button', { name: 'More' }).click()
  await expiringRow.getByRole('menuitem', { name: 'Delete' }).click()
  const deleteDialog = page.getByRole('dialog', { name: 'Delete upload?' })
  await expect(deleteDialog).toBeVisible()
  await expect(deleteDialog.locator('.action-confirm-detail')).toHaveText('expiring-paste.txt')
  await deleteDialog.getByRole('button', { name: 'Cancel' }).click()
  await page.getByLabel('Search uploads').fill('upload-12')
  await expect(page.getByText('1-1 of 1')).toBeVisible()
  await expect(page.getByText('upload-12.txt')).toBeVisible()

  await page.locator('.admin-tabs').getByRole('button', { name: 'Settings' }).click()
  await page.getByLabel('App name').fill('Verified Paste')
  await page.getByLabel('Public title').fill('Verified public title')
  await page.getByLabel('Maximum file size in gigabytes').fill('2')
  // Dragging the slider must not cause the label ("no application-level limit"
  // description) to reflow/jump; the output should stay right-aligned and stable.
  await expect(page.locator('.setting-slider output')).toHaveText('2 GB')
  await page.getByRole('button', { name: 'Public uploads' }).click()
  await page.getByRole("checkbox", { name: /Allow new registrations/ }).uncheck()
  await page.getByRole("checkbox", { name: /Enable passkeys/ }).uncheck()
  const saveSettings = page.getByRole('button', { name: 'Save settings' })
  await expect.poll(() => saveSettings.evaluate((button) => getComputedStyle(button).backgroundColor)).toMatch(
    /rgb\((28, 25, 23|41, 37, 36)\)/,
  )
  await saveSettings.click()
  await expect(page.getByTestId('notification-list')).toContainText('Settings updated')
})

test('a confirmed-dead session (401) logs out cleanly with a clear message', async ({ page }) => {
  await signInWithAccount(page)
  await page.route('**/auth/me', async (route) => {
    await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ detail: 'Session revoked' }) })
  })

  await page.goto('/files')
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByText('Your session has ended. Please log in again.')).toBeVisible()

  const stored = await page.evaluate(() => ({
    jwt: localStorage.getItem('rp_jwt') ?? sessionStorage.getItem('rp_jwt'),
    token: localStorage.getItem('rp_token') ?? sessionStorage.getItem('rp_token'),
  }))
  expect(stored.jwt).toBeNull()
  expect(stored.token).toBeNull()
})

test('a permission error (403) never clears a valid session', async ({ page }) => {
  // Suspended or non-admin accounts still have a perfectly valid session -
  // only the dead-session 401 path may clear stored tokens.
  await signInWithAccount(page)
  await page.route('**/auth/me', async (route) => {
    await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ detail: 'Account is suspended' }) })
  })

  await page.goto('/files')
  await expect(page).toHaveURL(/\/files$/)
  await expect(page.getByText('Your session has ended. Please log in again.')).toHaveCount(0)

  const stored = await page.evaluate(() => ({
    jwt: localStorage.getItem('rp_jwt') ?? sessionStorage.getItem('rp_jwt'),
    token: localStorage.getItem('rp_token') ?? sessionStorage.getItem('rp_token'),
  }))
  expect(stored.jwt).toBe('test-jwt')
  expect(stored.token).toBe('test-token')
})

test('an invalid JWT is caught by the boot-time check alone, before any feature calls authMe()', async ({ page }) => {
  // /login never calls authMe()/refreshAuthAdmin() itself - if a dead
  // session still gets cleared here, it can only be verifyStoredSession()
  // running unconditionally at boot, not some incidental admin/history call.
  await signInWithAccount(page)
  await page.route('**/auth/me', async (route) => {
    await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ detail: 'Token expired' }) })
  })

  await page.goto('/login')
  await expect(page.getByText('Your session has ended. Please log in again.')).toBeVisible()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('rp_jwt'))).toBeNull()
})

test('a paste-token-only session is not validated at boot - every account always has a JWT too', async ({ page }) => {
  // createUser() requires a password, so every account can always produce a
  // JWT; a bare paste token with no JWT is not a state any current login
  // path can create. verifyStoredSession() only checks hasAccountAuth().
  await signInWithToken(page)
  let versionChecked = false
  await page.route('**/api/version**', async (route) => {
    versionChecked = true
    await route.fulfill({ status: 200, contentType: 'text/plain', body: '1.0.0' })
  })

  await page.goto('/login')
  await page.waitForTimeout(500)
  expect(versionChecked).toBe(false)
})

test('an upload rejected as unauthorized clears the session instead of just failing silently', async ({ page }) => {
  await signInWithToken(page)
  await page.route('**/api/', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    await route.fulfill({ status: 401, contentType: 'text/plain', body: 'Unauthorized' })
  })

  await page.goto('/#/files')
  await page.locator('input[type="file"]').setInputFiles({
    name: 'rejected-upload.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('content'),
  })
  await expect(page.getByText('Your session has ended. Please log in again.')).toBeVisible()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('rp_token'))).toBeNull()
})

test('returning to a visible admin tab does not refetch on every alt-tab', async ({ page }) => {
  await signInAsAdmin(page)
  await mockAdminApi(page)
  let dashboardCalls = 0
  await page.route('**/auth/admin/dashboard**', async (route) => {
    dashboardCalls++
    await route.fallback()
  })

  await page.goto('/admin')
  await expect.poll(() => dashboardCalls).toBe(1)

  // Backgrounding the tab must not itself trigger a refetch.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.waitForTimeout(200)
  expect(dashboardCalls).toBe(1)

  // Returning to the tab refetches once...
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect.poll(() => dashboardCalls).toBe(2)

  // ...but rapid repeats (e.g. flicking between two more alt-tabs) within the
  // cooldown window must not each force another full refetch.
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange'))
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.waitForTimeout(300)
  expect(dashboardCalls).toBe(2)
})

test('registration tokens still load when returning to a warm Users tab via browser back', async ({ page }) => {
  // AdminView stays mounted while switching admin sections, but leaving the
  // workspace for /files and returning still creates a fresh admin instance.
  // With prefetched admin data already warm in module memory, refreshAll()
  // is skipped on mount, and if the route already points at /admin/users the
  // reactive tab watcher never fires either - it only reacts to a *change*
  // into 'Users', not to already starting there. Both paths funnel through
  // registration tokens only via that watcher or via refreshAll(), so a
  // fresh mount that skips both would silently show an empty list.
  await signInAsAdmin(page)
  await mockAdminApi(page)

  await page.goto('/admin')
  await page.getByRole('button', { name: 'Users', exact: true }).click()
  await expect(page.getByText('contractor invite', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Files', exact: true }).click()
  await expect(page).toHaveURL(/\/files$/)

  await page.goBack()
  await expect(page).toHaveURL(/\/admin\/users$/)
  await expect(page.getByText('contractor invite', { exact: true })).toBeVisible()
  await expect(page.getByText('No registration tokens', { exact: false })).toHaveCount(0)
})

test('admin generates a single-use registration token with expiration', async ({ page }) => {
  await signInAsAdmin(page)
  await mockAdminApi(page)
  await mockClipboard(page)

  await page.goto('/admin/users')
  await page.locator('.create-mode-tabs').getByRole('tab', { name: 'Token' }).last().click()
  await page.getByLabel('Token label').fill('contractor invite')
  await page.getByRole('button', { name: 'Token expiration' }).click()
  await page.getByRole('option', { name: '1 hour' }).click()
  await page.getByRole('button', { name: 'Generate token' }).click()

  const dialog = page.getByRole('dialog', { name: 'Registration token ready' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('single-use-registration-token', { exact: true })).toBeVisible()
  await expect(dialog).toContainText('Expires')
  await dialog.getByRole('button', { name: 'Copy token' }).click()
  await expect(dialog.getByRole('button', { name: 'Copied' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Done' }).click()
  await expect(page.getByRole('heading', { name: 'Registration tokens' }).last()).toBeVisible()
  await expect(page.getByText('Active', { exact: true }).last()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Revoke contractor invite token' }).last()).toBeVisible()
  await page.getByRole('button', { name: 'Clear history' }).last().click()
  const clearDialog = page.getByRole('dialog', { name: 'Clear token history?' })
  await expect(clearDialog).toBeVisible()
  await clearDialog.getByRole('checkbox').check()
  await clearDialog.getByRole('button', { name: 'Clear history', exact: true }).click()
  await expect(page.getByText('old invite', { exact: true })).toHaveCount(0)
})

test('admin paginates recent webhook deliveries', async ({ page }) => {
  await signInAsAdmin(page)
  await mockAdminApi(page)
  const deliveries = Array.from({ length: 23 }, (_, index) => ({
    id: index + 1,
    webhook_id: 1,
    event: index % 2 ? 'file.deleted' : 'file.uploaded',
    status: index % 3 ? 'delivered' : 'failed',
    status_code: index % 3 ? 200 : 500,
    error: index % 3 ? null : `delivery-${index + 1} failed`,
    created_at: 1_775_000_000 + index,
    delivered_at: 1_775_000_001 + index,
  }))
  await page.route('**/auth/admin/webhooks/deliveries**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(deliveries) })
  })

  await page.goto('/admin')
  await page.getByRole('button', { name: 'Webhooks', exact: true }).click()
  const table = page.locator('.webhook-deliveries-table')
  const pagination = page.locator('[aria-label="Delivery pagination"]')
  await expect(pagination).toContainText('1-10 of 23')
  await expect(table.locator('tbody tr')).toHaveCount(10)
  await expect(table.getByText('delivery-11 failed', { exact: true })).toHaveCount(0)

  await pagination.getByRole('button', { name: 'Next' }).click()
  await expect(pagination).toContainText('11-20 of 23')
  await expect(table.locator('tbody tr')).toHaveCount(10)
  await expect(table.getByText('delivery-13 failed', { exact: true })).toBeVisible()

  await pagination.getByRole('button', { name: 'Next' }).click()
  await expect(pagination).toContainText('21-23 of 23')
  await expect(table.locator('tbody tr')).toHaveCount(3)
})

test('admin users cannot take actions against their own account', async ({ page }) => {
  await signInAsAdmin(page)
  await mockAdminApi(page)
  await page.route('**/auth/admin/users**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        { username: 'admin-user', created_at: 1_775_000_000, is_admin: true, suspended_at: null, suspended_reason: null, upload_token_preview: 'tok…admin', upload_count: 1, disk_usage_bytes: 10 },
        { username: 'managed-user', created_at: 1_775_000_001, is_admin: false, suspended_at: null, suspended_reason: null, upload_token_preview: 'tok…user', upload_count: 0, disk_usage_bytes: 0 },
      ]),
    })
  })

  await page.goto('/admin')
  await page.getByRole('button', { name: 'Users', exact: true }).click()
  const row = page.locator('.users-table tbody tr').filter({ hasText: 'admin-user' }).first()
  await row.getByRole('button', { name: 'Delete' }).click()
  await expect(page.getByTestId('notification-list')).toContainText('You cannot take action on your own account')
  await expect(page.getByRole('dialog', { name: 'Delete user?' })).toHaveCount(0)

  await row.getByRole('button', { name: 'More actions' }).click()
  const menu = page.getByRole('group', { name: 'User actions' })
  await menu.getByRole('button', { name: 'Suspend' }).click()
  await expect(page.getByTestId('notification-list')).toContainText('You cannot take action on your own account')

  await row.getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('group', { name: 'User actions' }).getByRole('button', { name: 'Rotate token' }).click()
  await expect(page.getByRole('dialog', { name: 'Upload token ready' })).toBeVisible()
  await page.getByRole('button', { name: 'Close token dialog' }).click()

  await row.getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('group', { name: 'User actions' }).getByRole('button', { name: 'Purge uploads' }).click()
  const purgeDialog = page.getByRole('dialog', { name: 'Purge user uploads?' })
  await expect(purgeDialog).toBeVisible()
  await purgeDialog.getByRole('checkbox').check()
  await purgeDialog.getByRole('button', { name: 'Purge uploads' }).click()
  await expect(page.getByTestId('notification-list')).toContainText('Uploads purged')
})

test('history falls back to the public API when the configured API host is unavailable', async ({ page }) => {
  await signInWithToken(page)
  await page.route('**/auth/admin/public-settings', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        app_name: 'yaemipaste',
        public_title: 'yaemipaste',
        registration_enabled: true,
        base_api_url: 'https://papi.example.test',
        file_size_limit_bytes: 0,
        file_size_limit_unlimited: false,
        upload_access_mode: 'private',
      }),
    })
  })
  await page.route('https://papi.example.test/list**', async (route) => {
    await route.abort()
  })
  await page.route('**/api/list**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ file_name: 'sharex-text.txt', file_size: 24, creation_date_utc: '2026-07-26 22:00:00', expires_at_utc: null }]),
    })
  })
  await page.route('**/api/meta/sharex-text.txt', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        file_name: 'sharex-text.txt',
        display_name: 'sharex-text.txt',
        uploader: 'test-user',
        source: 'ShareX',
        upload_date_utc: '2026-07-26 22:00:00',
        download_name: 'sharex-text.txt',
        file_size: 24,
        mime_type: 'text/plain',
      }),
    })
  })

  await page.goto('/history')
  await expect(page.getByText('sharex-text.txt', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Uploaded with ShareX')).toBeVisible()
})

test('admin panel covers every tab and responsive viewport class', async ({ page }) => {
  await signInAsAdmin(page)
  await mockAdminApi(page)
  await page.goto('/admin')

  await expect(page.getByRole('heading', { name: 'Admin panel' })).toBeVisible()
  await expect(page.getByText('Signed in as admin-user')).toBeVisible()
  await expect(page.getByText('Storage usage is above warning threshold')).toBeVisible()
  await expect(page.getByText('Recent uploads')).toBeVisible()
  await expect(page.getByText('Recent admin actions')).toBeVisible()

  const tabs = page.locator('.admin-tabs')
  await tabs.getByRole('button', { name: 'Users', exact: true }).click()
  await expect(page.getByText('user-1', { exact: true })).toBeVisible()
  await expect(page.getByText('token configured').first()).toBeVisible()
  await expect(page.getByText('no token').first()).toBeVisible()
  const userPagination = page.locator('[aria-label="User pagination"]')
  await expect(userPagination).toContainText('1 of 2')
  await userPagination.getByRole('button', { name: 'Next' }).click()
  await expect(userPagination).toContainText('2 of 2')
  await expect(page.getByText('user-11', { exact: true })).toBeVisible()

  await tabs.getByRole('button', { name: 'Uploads', exact: true }).click()
  await expect(page.getByText('ShareX screenshot.png')).toBeVisible()
  await expect(page.getByLabel('Search uploads')).toBeVisible()
  await expect(page.getByText('Auto-refreshing')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Delete all', exact: true })).toBeVisible()
  expect(await page.locator('.admin-table thead th').allTextContents()).toEqual(['', 'Name', 'Owner', 'Size', 'Created', 'Expires', ''])
  const shareXRow = page.locator('.admin-table tbody tr').filter({ hasText: 'ShareX screenshot.png' }).first()
  await expect(shareXRow.locator('.upload-owner-cell > span').first()).toHaveText('user-1')
  await expect(shareXRow.locator('.upload-owner-cell')).not.toContainText('(ShareX)')
  await page.getByRole('button', { name: 'Owner' }).click()
  await page.getByRole('option', { name: 'user-1', exact: true }).click()
  await expect(page.getByText('ShareX screenshot.png', { exact: true })).toBeVisible()
  await expect(page.getByText('upload-2.txt', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Owner' }).click()
  await page.getByRole('option', { name: 'All owners' }).click()
  await expect(page.getByRole('group', { name: 'Uploads per page' }).getByRole('button', { name: '15', exact: true })).toHaveAttribute('aria-pressed', 'true')
  const uploadPagination = page.locator('[aria-label="Upload pagination"]')
  await expect(uploadPagination).toContainText('1-12 of 12')
  await page.getByLabel('Search uploads').fill('upload-12')
  await expect(uploadPagination).toContainText('1-1 of 1')
  await expect(page.getByText('upload-12.txt')).toBeVisible()
  await page.getByLabel('Search uploads').fill('image/png')
  await expect(page.getByText('upload-2.txt')).toBeVisible()
  await page.getByLabel('Search uploads').fill('')

  await tabs.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Configure your service' })).toBeVisible()
  await expect(page.getByLabel('App name')).toHaveValue('yaemipaste')
  await expect(page.getByLabel('Public title')).toHaveValue('yaemipaste')
  await expect(page.getByLabel('Base API URL')).toBeVisible()
  await expect(page.getByLabel('Maximum file size in gigabytes')).toHaveValue('1')
  await expect(page.getByRole('checkbox', { name: /Allow new registrations/ })).toBeChecked()

  await tabs.getByRole('button', { name: 'Webhooks', exact: true }).click()
  await expect(page.getByText('https://example.test/webhook')).toBeVisible()
  await expect(page.getByLabel('Subscribed events').getByText('File uploaded')).toBeVisible()
  await expect(page.getByLabel('Subscribed events').getByText('File deleted')).toBeVisible()
  await expect(page.getByText('Enabled', { exact: true })).toBeVisible()
  await expect(page.getByText('timeout')).toBeVisible()
  await expect(page.locator('[aria-label="Webhook pagination"]')).toContainText('1 of 1')

  await tabs.getByRole('button', { name: 'Audit', exact: true }).click()
  await expect(page.getByText('Audit log')).toBeVisible()
  await expect(page.getByText('settings.update').first()).toBeVisible()
  await expect(page.getByText('upload.delete').first()).toBeVisible()
  await expect(page.getByText('target-1', { exact: true })).toBeVisible()
  await expect(page.locator('[aria-label="Audit pagination"]')).toContainText('1-10 of 12')

  await page.goto('/#/files')
  await page.getByRole('button', { name: 'Preferences' }).click()
  const preferencesLayer = page.getByTestId('settings-layer')
  await expect(preferencesLayer.locator('.settings-panel')).toBeVisible()
  await expect.poll(() => preferencesLayer.getAttribute('class')).toContain('settings-layer-enter-active')
  await preferencesLayer.locator('.overlay').click({ position: { x: 8, y: 8 } })
  await expect.poll(() => preferencesLayer.getAttribute('class')).toContain('settings-layer-leave-active')
  await expect(preferencesLayer).toBeHidden()
})

test('admin destructive actions send explicit confirmations', async ({ page }) => {
  await signInAsAdmin(page)
  await mockAdminApi(page)

  await page.goto('/admin')
  await page.locator('.admin-tabs').getByRole('button', { name: 'Uploads', exact: true }).click()
  await page.getByLabel('Select files/upload-1.txt').check()
  await page.locator('.upload-actions-trigger:not(:disabled)').click()
  await page.getByRole('menuitem', { name: 'Delete selected', exact: true }).click()
  let confirmation = page.getByRole('dialog', { name: 'Delete selected uploads?' })
  await expect(confirmation).toBeVisible()
  await confirmation.getByRole('checkbox').check()
  await confirmation.getByRole('button', { name: 'Delete uploads', exact: true }).click()
  await expect(page.getByTestId('notification-list')).toContainText('Selected uploads deleted')

  await page.locator('.upload-actions-trigger:not(:disabled)').click()
  await page.getByRole('menuitem', { name: 'Purge expired', exact: true }).click()
  confirmation = page.getByRole('dialog', { name: 'Purge expired uploads?' })
  await expect(confirmation).toBeVisible()
  await confirmation.getByRole('checkbox').check()
  await confirmation.getByRole('button', { name: 'Purge expired', exact: true }).click()
  await expect(page.getByTestId('notification-list')).toContainText('Expired uploads purged')

  await page.getByRole('button', { name: 'Users' }).click()
  const userRow = page.locator('tr').filter({ has: page.getByText('user-1', { exact: true }) })
  await expect(userRow.getByRole('button', { name: 'Delete', exact: true })).toBeVisible()
  await userRow.getByRole('button', { name: 'More actions' }).click()
  const userMenu = page.locator('.user-row-menu-panel')
  await expect(userMenu.getByRole('button', { name: 'Suspend', exact: true })).toBeVisible()
  await expect(userMenu.getByRole('button', { name: /Promote|Demote/, exact: true })).toBeVisible()
  await expect(userMenu.getByRole('button', { name: 'Rotate token', exact: true })).toBeVisible()
  await userMenu.getByRole('button', { name: 'Suspend', exact: true }).press('Escape')
  await expect(userMenu).toHaveCount(0)
  const moreActions = userRow.getByRole('button', { name: 'More actions' })
  await expect(moreActions).toBeFocused()
  await moreActions.click()
  await page.locator('.user-row-menu-panel').getByRole('button', { name: 'Purge uploads', exact: true }).click()
  confirmation = page.getByRole('dialog', { name: 'Purge user uploads?' })
  await expect(confirmation).toBeVisible()
  await confirmation.getByRole('checkbox').check()
  await confirmation.getByRole('button', { name: 'Purge uploads', exact: true }).click()
  await expect(page.getByTestId('notification-list')).toContainText('Uploads purged')
})

test('admin users show one page and disable navigation for a single user', async ({ page }) => {
  await signInAsAdmin(page)
  await mockAdminApi(page, 1)
  await page.goto('/admin')
  await page.getByRole('button', { name: 'Users', exact: true }).click()

  const pagination = page.locator('[aria-label="User pagination"]')
  await expect(page.getByText('user-1', { exact: true })).toBeVisible()
  await expect(pagination).toContainText('1 of 1')
  await expect(pagination.getByRole('button', { name: 'Previous' })).toBeDisabled()
  await expect(pagination.getByRole('button', { name: 'Next' })).toBeDisabled()
})

test('admin users render as balanced cards on mobile', async ({ page }) => {
  await signInAsAdmin(page)
  await mockAdminApi(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/admin')
  await page.getByRole('button', { name: 'Users', exact: true }).click()

  const table = page.locator('.users-table')
  const row = table.locator('tbody tr').filter({ hasText: 'user-1' }).first()
  await expect.poll(() => table.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBeTruthy()
  await expect(row.getByText('user-1', { exact: true })).toBeVisible()
  await expect.poll(() => page.locator('.admin-content-panel').evaluate((element) => getComputedStyle(element).transform)).toBe('none')
  await expect(row.locator('[data-label="Role"]')).toBeVisible()
  await expect(row.locator('[data-label="Storage"]')).toBeVisible()

  const more = row.getByRole('button', { name: 'More actions' })
  const remove = row.getByRole('button', { name: 'Delete', exact: true })
  await expect(more.getByText('More', { exact: true })).toBeVisible()
  const moreBox = await more.boundingBox()
  const deleteBox = await remove.boundingBox()
  expect(moreBox).not.toBeNull()
  expect(deleteBox).not.toBeNull()
  if (moreBox && deleteBox) {
    expect(Math.abs(moreBox.y - deleteBox.y)).toBeLessThanOrEqual(1)
    expect(Math.abs(moreBox.width - deleteBox.width)).toBeLessThanOrEqual(1)
  }

  await more.click()
  const panel = page.locator('.user-row-menu-panel')
  await expect(panel).toBeVisible()
  const panelBox = await panel.boundingBox()
  const viewport = page.viewportSize()!
  expect(panelBox).not.toBeNull()
  if (panelBox) {
    expect(panelBox.x).toBeGreaterThanOrEqual(8)
    expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(viewport.width - 8)
  }
})

test('admin uploads show the original name and ShareX provenance', async ({ page }) => {
  await signInAsAdmin(page)
  await mockAdminApi(page)
  await page.goto('/admin')
  await page.getByRole('button', { name: 'Uploads', exact: true }).click()

  await expect(page.getByText('ShareX screenshot.png')).toBeVisible()
  await expect(page.getByLabel('Uploaded with ShareX')).toBeVisible()
  await page.getByLabel('Search uploads').fill('sharex')
  await expect(page.getByText('ShareX screenshot.png')).toBeVisible()
})

test('admin previews expiring text uploads whose stored name has a timestamp suffix', async ({ page }) => {
  await signInAsAdmin(page)
  await mockAdminApi(page)
  await page.route('**/auth/admin/uploads/content?path=files%2Fexpiring-paste.txt.1785612876517', async (route) => {
    expect(route.request().headers().authorization).toBe('Bearer admin-jwt')
    await route.fulfill({ status: 200, contentType: 'text/plain', body: 'expiring paste preview' })
  })

  await page.goto('/admin')
  await page.getByRole('button', { name: 'Uploads', exact: true }).click()
  const expiringName = page.getByRole('button', { name: 'expiring-paste.txt', exact: true })
  await expect(expiringName.locator('.upload-filename-base')).toHaveText('expiring-paste')
  await expect(expiringName.locator('.upload-filename-ext')).toHaveText('.txt')
  await expect(expiringName).toHaveCSS('overflow', 'visible')
  await expiringName.click()

  const dialog = page.getByRole('dialog', { name: 'Preview expiring-paste.txt' })
  await expect(dialog.getByText('expiring paste preview')).toBeVisible()
})

test('admin previews images through the authenticated content endpoint', async ({ page }) => {
  await signInAsAdmin(page)
  await mockAdminApi(page)
  await page.route('**/auth/admin/uploads/content?path=files%2Fupload-1.txt', async (route) => {
    expect(route.request().headers().authorization).toBe('Bearer admin-jwt')
    await route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mNk+M/wHwAF/gL+UPnY9AAAAABJRU5ErkJggg==', 'base64'),
    })
  })

  await page.goto('/admin')
  await page.getByRole('button', { name: 'Uploads', exact: true }).click()
  await page.getByRole('button', { name: 'ShareX screenshot.png', exact: true }).click()

  const dialog = page.getByRole('dialog', { name: 'Preview ShareX screenshot.png' })
  await expect(dialog.locator('img.preview-img')).toHaveAttribute('src', /^blob:/)
})

test('admin password-encrypted previews ask only for the password', async ({ page }) => {
  const password = 'AdminPreview!123'
  const encrypted = await encryptFileWithPassword(
    new File(['admin encrypted preview'], 'admin-secret.txt', { type: 'text/plain' }),
    password,
    'admin-user',
  )
  const encryptedRow = {
    path: 'files/admin-secret.txt.rpenc',
    owner: 'admin-user',
    file_name: 'admin-secret.txt.rpenc',
    display_name: 'admin-secret.txt.rpenc',
    uploader: 'admin-user',
    source: 'WebUI',
    size_bytes: encrypted.blob.size,
    created_at: 1_775_100_100,
    expires_at: null,
    expired: false,
    content_type: 'application/octet-stream',
    password_salt: encrypted.salt,
  }
  await signInAsAdmin(page)
  await mockAdminApi(page)
  await page.route('**/auth/admin/uploads**', async (route) => {
    if (route.request().method() === 'GET' && !route.request().url().includes('/content')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([encryptedRow]) })
      return
    }
    await route.fallback()
  })
  await page.route('**/auth/admin/uploads/content?path=files%2Fadmin-secret.txt.rpenc', async (route) => {
    expect(route.request().headers().authorization).toBe('Bearer admin-jwt')
    await route.fulfill({
      status: 200,
      contentType: 'application/octet-stream',
      body: Buffer.from(await encrypted.blob.arrayBuffer()),
    })
  })

  await page.goto('/admin')
  await page.getByRole('button', { name: 'Uploads', exact: true }).click()
  await page.getByRole('button', { name: 'admin-secret.txt.rpenc', exact: true }).click()

  const dialog = page.getByRole('dialog', { name: 'Preview encrypted file' })
  await expect(dialog.getByLabel('Decryption password')).toBeVisible()
  await expect(dialog.getByLabel('Password-encrypted file link')).toHaveCount(0)
  await dialog.getByLabel('Decryption password').fill(password)
  await dialog.getByRole('button', { name: 'Preview file' }).click()
  await expect(page.locator('.text-preview')).toContainText('admin encrypted preview')
})

test('admin upload library keeps ShareX provenance beside the name and exposes row actions', async ({ page }) => {
  await signInAsAdmin(page)
  await mockAdminApi(page)
  await mockClipboard(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.route('**/file/upload-1/preview', async (route) => {
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<p>ShareX preview</p>' })
  })

  await page.goto('/admin')
  await page.getByRole('button', { name: 'Uploads', exact: true }).click()

  const row = page.locator('.admin-table tbody tr').filter({ hasText: 'ShareX screenshot.png' }).first()
  const nameCell = row.locator('.upload-name-cell')
  const nameButton = row.getByRole('button', { name: 'ShareX screenshot.png', exact: true })
  const ownerCell = row.locator('.upload-owner-cell')
  const shareXBadge = ownerCell.getByText('ShareX', { exact: true })
  await expect(row).toBeVisible()
  await expect(nameCell.getByRole('button', { name: 'Preview ShareX screenshot.png' })).toHaveCount(0)
  await expect(nameButton).toBeVisible()
  await expect(shareXBadge).toHaveAttribute('title', 'Captured and uploaded with ShareX')

  const nameBox = await nameCell.boundingBox()
  const ownerBox = await ownerCell.boundingBox()
  const badgeBox = await shareXBadge.boundingBox()
  expect(nameBox).not.toBeNull()
  expect(ownerBox).not.toBeNull()
  expect(badgeBox).not.toBeNull()
  if (nameBox && ownerBox && badgeBox) {
    expect(ownerBox.x).toBeGreaterThan(nameBox.x)
    expect(badgeBox.x).toBeGreaterThan(ownerBox.x)
    expect(Math.abs((badgeBox.y + badgeBox.height / 2) - (ownerBox.y + ownerBox.height / 2))).toBeLessThan(12)
  }

  const hoverPreview = page.locator('.upload-hover-preview')
  await nameButton.locator('.upload-filename-ext').hover()
  await expect(hoverPreview).toHaveCount(0)
  await nameButton.locator('.upload-filename-base').hover()
  await expect(nameButton.locator('.upload-filename-base')).toHaveCSS('color', 'rgb(180, 83, 9)')
  await expect(nameButton.locator('.upload-filename-ext')).toHaveCSS('color', 'rgb(87, 83, 78)')
  await expect(hoverPreview).toBeVisible()
  await expect(hoverPreview.getByRole('img', { name: 'ShareX screenshot.png' })).toBeVisible()
  await expect(hoverPreview.locator('.upload-hover-name')).toHaveText('ShareX screenshot')
  await expect(hoverPreview).toHaveCSS('pointer-events', 'none')

  const downloadLink = row.getByRole('link', { name: 'Download' })
  const copyButton = row.getByRole('button', { name: 'Copy preview link' })
  const moreButton = row.getByRole('button', { name: 'More' })
  await expect(downloadLink).toBeVisible()
  await expect(downloadLink).toHaveAttribute('href', /\/file\/upload-1\/download$/)
  await expect(downloadLink).toHaveCSS('min-width', '120px')
  await expect(copyButton).toBeVisible()
  await expect(copyButton).toHaveCSS('border-radius', '6px')
  await expect(moreButton).toHaveAttribute('aria-expanded', 'false')

  const previewHref = '/file/upload-1/preview'
  expect(previewHref).toMatch(/\/file\/upload-1\/preview$/)

  await copyButton.click()
  await expect.poll(() => page.evaluate(() => (navigator.clipboard as any).__written())).toMatch(/\/file\/upload-1\/preview$/)

  await moreButton.click()
  await expect(moreButton).toHaveAttribute('aria-expanded', 'true')
  const menu = row.getByRole('menu')
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Preview', exact: true })).toBeVisible()

  await menu.getByRole('menuitem', { name: 'Preview', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Preview ShareX screenshot.png' })
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('.modal-body')).toBeVisible()
  const openButton = dialog.getByRole('button', { name: 'Open file preview or raw content' })
  const primaryCopyButton = dialog.getByRole('button', { name: 'Copy file content or URL' })
  const copyMenuButton = dialog.getByRole('button', { name: 'More copy options' })
  await expect(openButton).toBeVisible()
  await expect(primaryCopyButton).toBeVisible()
  await expect(copyMenuButton).toBeVisible()
  await primaryCopyButton.hover()
  await expect(primaryCopyButton).toHaveCSS('transform', 'none')
  await openButton.click()
  const openMenu = dialog.getByRole('menu', { name: 'Open options' })
  await expect(openMenu).toBeVisible()
  await expect(openMenu.getByRole('menuitem', { name: /Open preview/ })).toHaveAttribute('href', /\/file\/upload-1\/preview$/)
  await expect(openMenu.getByRole('menuitem', { name: /Open raw/ })).toHaveAttribute('href', /\/upload-1\/file\.txt$/)
  const openMenuBox = await openMenu.boundingBox()
  await openButton.click()
  await expect(openMenu).toHaveCount(0)
  await copyMenuButton.click()
  const copyMenu = dialog.getByRole('menu', { name: 'Copy options' })
  await expect(copyMenu).toBeVisible()
  const copyMenuBox = await copyMenu.boundingBox()
  if (openMenuBox && copyMenuBox) {
    const viewport = page.viewportSize()!
    expect(openMenuBox.x).toBeGreaterThanOrEqual(0)
    expect(copyMenuBox.x + copyMenuBox.width).toBeLessThanOrEqual(viewport.width)
  }
  const openButtonBox = await openButton.boundingBox()
  const copyButtonBox = await primaryCopyButton.boundingBox()
  expect(openButtonBox?.width).toBe(copyButtonBox?.width)
  expect(openButtonBox?.height).toBe(copyButtonBox?.height)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})

test('admin upload library keeps row controls keyboard accessible on mobile', async ({ page }) => {
  await signInAsAdmin(page)
  await mockAdminApi(page)
  await mockClipboard(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.route('**/file/upload-1/preview', async (route) => {
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<p>ShareX preview</p>' })
  })

  await page.goto('/admin')
  await page.getByRole('button', { name: 'Uploads', exact: true }).click()

  const row = page.locator('.admin-table tbody tr').filter({ hasText: 'ShareX screenshot.png' }).first()
  await expect(row.getByLabel('Uploaded with ShareX')).toBeVisible()
  await expect.poll(() => page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth))).toBeLessThanOrEqual(390)
  const uploadsTable = page.locator('.uploads-table')
  await expect.poll(() => uploadsTable.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBeTruthy()
  await expect(row.locator('.upload-owner-cell')).toHaveCSS('display', 'flex')

  const previewButton = row.getByRole('button', { name: 'ShareX screenshot.png', exact: true })
  await previewButton.scrollIntoViewIfNeeded()
  await previewButton.focus()
  await expect(previewButton).toBeFocused()
  await previewButton.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Preview ShareX screenshot.png' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Close preview' }).click()
  await expect(dialog).toBeHidden()

  const downloadLink = row.getByRole('link', { name: 'Download' })
  const copyButton = row.getByRole('button', { name: 'Copy preview link' })
  const moreButton = row.getByRole('button', { name: 'More' })
  await downloadLink.scrollIntoViewIfNeeded()
  await expect(downloadLink).toBeVisible()
  await expect(downloadLink).toHaveAttribute('href', /\/file\/upload-1\/download$/)
  const actionBox = await row.locator('.upload-row-actions').boundingBox()
  const downloadBox = await downloadLink.boundingBox()
  const copyBox = await copyButton.boundingBox()
  const selectBox = await row.locator('.select-col').boundingBox()
  const moreBox = await moreButton.boundingBox()
  const fileIconBox = await row.locator('.upload-file-icon').boundingBox()
  const fileNameBox = await previewButton.boundingBox()
  expect(actionBox).not.toBeNull()
  expect(downloadBox).not.toBeNull()
  expect(copyBox).not.toBeNull()
  expect(selectBox).not.toBeNull()
  expect(moreBox).not.toBeNull()
  expect(fileIconBox).not.toBeNull()
  expect(fileNameBox).not.toBeNull()
  if (actionBox && downloadBox && copyBox && selectBox && moreBox && fileIconBox && fileNameBox) {
    expect(downloadBox.y).toBeGreaterThanOrEqual(actionBox.y)
    expect(Math.abs(downloadBox.y - copyBox.y)).toBeLessThanOrEqual(1)
    expect(Math.abs(actionBox.x - selectBox.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(downloadBox.width - copyBox.width)).toBeLessThanOrEqual(1)
    expect(Math.abs(copyBox.width - moreBox.width)).toBeLessThanOrEqual(1)
    expect(actionBox.width).toBeGreaterThan(downloadBox.width * 2)
    expect(Math.abs((fileNameBox.y + fileNameBox.height / 2) - (fileIconBox.y + fileIconBox.height / 2))).toBeLessThanOrEqual(1)
  }

  await copyButton.focus()
  await expect(copyButton).toBeFocused()
  await copyButton.press('Enter')
  await expect.poll(() => page.evaluate(() => (navigator.clipboard as any).__written())).toMatch(/\/file\/upload-1\/preview$/)

  await moreButton.focus()
  await expect(moreButton).toBeFocused()
  await moreButton.press('Enter')
  await expect(moreButton).toHaveAttribute('aria-expanded', 'true')
  const menu = row.getByRole('menu')
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Preview', exact: true })).toBeVisible()

  await menu.getByRole('menuitem', { name: 'Preview', exact: true }).press('Enter')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Close preview' }).click()
  await expect(dialog).toBeHidden()
})

test('admin upload preview keeps the mobile filename behind the modal', async ({ page }) => {
  await signInAsAdmin(page)
  await mockAdminApi(page)
  await mockClipboard(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.route('**/auth/admin/uploads/content?path=files%2Fupload-1.txt', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="700"><rect width="100%" height="100%" fill="#1d2734"/></svg>',
    })
  })

  await page.goto('/admin')
  await page.getByRole('button', { name: 'Uploads', exact: true }).click()

  const row = page.locator('.admin-table tbody tr').filter({ hasText: 'ShareX screenshot.png' }).first()
  const previewButton = row.getByRole('button', { name: 'ShareX screenshot.png', exact: true })
  await previewButton.click()
  const dialog = page.getByRole('dialog', { name: 'Preview ShareX screenshot.png' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveCSS('opacity', '1')
  await expect.poll(() => page.locator('.modal-backdrop').evaluate((element) => Number.parseInt(getComputedStyle(element).zIndex, 10))).toBeGreaterThan(300)

  const filenameBox = await previewButton.boundingBox()
  const filenameTextBox = await previewButton.locator('.upload-filename-base').boundingBox()
  const iconBox = await row.locator('.upload-file-icon').boundingBox()
  expect(filenameBox).not.toBeNull()
  expect(filenameTextBox).not.toBeNull()
  expect(iconBox).not.toBeNull()
  if (filenameTextBox && iconBox) {
    expect(Math.abs((filenameTextBox.y + filenameTextBox.height / 2) - (iconBox.y + iconBox.height / 2))).toBeLessThanOrEqual(1)
  }
  if (filenameBox) {
    const coveredByModal = await page.evaluate(({ x, y }) => {
      const element = document.elementFromPoint(x, y)
      return element?.closest('.modal-backdrop') !== null
    }, {
      x: filenameBox.x + filenameBox.width / 2,
      y: filenameBox.y + filenameBox.height / 2,
    })
    expect(coveredByModal).toBeTruthy()
  }
  await expect(page.locator('.upload-hover-preview')).toHaveCount(0)
})

test('admin upload filenames truncate their base while keeping extensions visible on mobile', async ({ page }) => {
  const filename = 'Screenshot_20260719_131129_Chrome_with_a_really_long_filename.jpg'
  await signInAsAdmin(page)
  await mockAdminApi(page, 12, true)
  await page.setViewportSize({ width: 390, height: 844 })

  await page.goto('/admin')
  await page.getByRole('button', { name: 'Uploads', exact: true }).click()

  const name = page.getByRole('button', { name: filename, exact: true })
  const base = name.locator('.upload-filename-base')
  const extension = name.locator('.upload-filename-ext')
  await expect(name).toBeVisible()
  await expect(extension).toHaveText('.jpg')
  await expect.poll(() => base.evaluate((element) => element.scrollWidth > element.clientWidth)).toBeTruthy()
  await expect.poll(() => page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth))).toBeLessThanOrEqual(390)

  const shortName = page.getByRole('button', { name: 'upload-2.txt', exact: true })
  const shortBaseBox = await shortName.locator('.upload-filename-base').boundingBox()
  const shortExtensionBox = await shortName.locator('.upload-filename-ext').boundingBox()
  expect(shortBaseBox).not.toBeNull()
  expect(shortExtensionBox).not.toBeNull()
  if (shortBaseBox && shortExtensionBox) {
    expect(shortExtensionBox.x - (shortBaseBox.x + shortBaseBox.width)).toBeLessThanOrEqual(1)
  }
})

test('admin copy link opens an anonymous upload with an expiry storage suffix', async ({ page }) => {
  await signInAsAdmin(page)
  await mockAdminApi(page)
  await mockClipboard(page)
  const anonymousUpload = {
    path: 'rmIRgRJG.txt.1785698019153',
    owner: null,
    file_name: 'rmIRgRJG.txt.1785698019153',
    display_name: 'paste.txt',
    uploader: null,
    source: 'WebUI',
    size_bytes: 12,
    created_at: 1_775_100_000,
    expires_at: null,
    expired: false,
    content_type: 'text/plain',
  }
  await page.route('**/auth/admin/uploads**', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([anonymousUpload]) })
  })
  await page.route('**/resolve/rmIRgRJG**', async (route) => {
    if (new URL(route.request().url()).pathname !== '/resolve/rmIRgRJG') {
      await route.fallback()
      return
    }
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body>SPA shell</body></html>' })
  })
  await page.route('**/api/resolve/rmIRgRJG**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ file_name: 'rmIRgRJG.txt.1785698019153', uploader: null }) })
  })
  await page.route('**/api/meta/rmIRgRJG.txt.1785698019153', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        file_name: 'rmIRgRJG.txt.1785698019153',
        display_name: 'paste.txt',
        uploader: 'Anonymous',
        upload_date_utc: '2026-07-19T18:24:56Z',
        download_name: 'paste.txt',
        file_size: 12,
        mime_type: 'text/plain',
      }),
    })
  })
  await page.route('**/api/rmIRgRJG.txt.1785698019153?raw=1', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/plain',
      body: 'anonymous paste',
    })
  })

  await page.goto('/admin')
  await page.getByRole('button', { name: 'Uploads', exact: true }).click()
  const row = page.locator('.admin-table tbody tr').filter({ hasText: 'paste.txt' })
  await row.getByRole('button', { name: 'Copy preview link' }).click()
  const copiedUrl = await page.evaluate(() => (navigator.clipboard as any).__written())
  expect(copiedUrl).toMatch(/\/file\/rmIRgRJG\/preview$/)

  await page.goto(copiedUrl)
  const previewPage = page.getByRole('heading', { name: 'File preview' })
  await expect(previewPage).toBeVisible({ timeout: 15000 })
  await expect(page.getByText('File not found or expired')).toHaveCount(0, { timeout: 15000 })
  await expect(page.getByText('paste.txt', { exact: true })).toBeVisible({ timeout: 15000 })
  await expect(page.getByText('Anonymous', { exact: true })).toBeVisible({ timeout: 15000 })
  await expect(page.getByText('anonymous paste')).toBeVisible({ timeout: 15000 })
})

test('admin sections update the URL and support browser history', async ({ page }) => {
  await signInAsAdmin(page)
  await mockAdminApi(page)

  await page.goto('/admin/users')
  await expect(page.getByRole('button', { name: 'Users', exact: true })).toHaveClass(/active/)

  await page.getByRole('button', { name: 'Uploads', exact: true }).click()
  await expect(page).toHaveURL(/\/admin\/uploads$/)
  await expect(page.getByRole('button', { name: 'Uploads', exact: true })).toHaveClass(/active/)

  await page.goBack()
  await expect(page).toHaveURL(/\/admin\/users$/)
  await expect(page.getByRole('button', { name: 'Users', exact: true })).toHaveClass(/active/)
})

test('admin upload filters stay inside the mobile viewport', async ({ page }) => {
  await signInAsAdmin(page)
  await mockAdminApi(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/admin')
  await page.getByRole('button', { name: 'Uploads', exact: true }).click()

  for (const label of ['Owner', 'Expiry']) {
    await page.getByRole('button', { name: label, exact: true }).click()
    const menu = page.getByRole('listbox', { name: label, exact: true })
    await expect(menu).toBeVisible()
    const box = await menu.boundingBox()
    expect(box).not.toBeNull()
    if (box) {
      expect(box.x).toBeGreaterThanOrEqual(8)
      expect(box.x + box.width).toBeLessThanOrEqual(382)
      expect(box.width).toBeLessThanOrEqual(374)
    }
    await expect.poll(() => page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth))).toBeLessThanOrEqual(390)
    await page.keyboard.press('Escape')
  }
})

test('admin uploads search filters without layout shift', async ({ page }) => {
  await signInAsAdmin(page)
  await mockAdminApi(page)
  await page.goto('/admin')
  await page.locator('.admin-tabs').getByRole('button', { name: 'Uploads', exact: true }).click()

  const search = page.getByLabel('Search uploads')
  const before = await search.boundingBox()
  await search.fill('upload-12')
  await expect(page.getByText('upload-12.txt')).toBeVisible()
  const after = await search.boundingBox()
  // Chromium can report a 1/65536px rounding delta after text input even
  // when the control keeps the same CSS height.
  expect(before && after ? Math.abs(before.height - after.height) : 0).toBeLessThanOrEqual(0.01)
})

async function mockAdminRoutes(page: Page, settings: Record<string, unknown>) {
  const publicSettings = {
    app_name: String(settings.app_name ?? 'yaemipaste'),
    public_title: String(settings.public_title ?? 'yaemipaste'),
    registration_enabled: true,
    base_api_url: '',
    file_size_limit_bytes: 0,
    file_size_limit_unlimited: false,
    upload_access_mode: String(settings.upload_access_mode ?? 'private'),
    passkeys_enabled: false,
    accent_color: String(settings.accent_color ?? ''),
    logo_type: String(settings.logo_type ?? ''),
    logo_preset: String(settings.logo_preset ?? ''),
    branding_logo: String(settings.branding_logo ?? ''),
  }
  await page.route('**/auth/admin/public-settings', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(publicSettings) })
  })
  await page.route('**/auth/admin/dashboard**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ total_disk_usage_bytes: 0, upload_count: 0, user_count: 0, suspended_user_count: 0, admin_count: 0, users: [], recent_uploads: [], recent_audit: [], failed_webhook_deliveries: [], config_status: {}, warnings: [] }) })
  })
  await page.route('**/auth/admin/users**', async (route) => { await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }) })
  await page.route('**/auth/admin/uploads**', async (route) => { await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }) })
  await page.route('**/auth/admin/settings**', async (route) => {
    if (route.request().method() === 'PUT') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(route.request().postDataJSON()) })
      return
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(settings) })
  })
  await page.route('**/auth/admin/webhooks/deliveries**', async (route) => { await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }) })
  await page.route('**/auth/admin/webhooks**', async (route) => {
    if (new URL(route.request().url()).pathname.endsWith('/deliveries')) {
      await route.fallback()
      return
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  })
  await page.route('**/auth/admin/audit**', async (route) => { await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }) })
}

async function openAdminSettings(page: Page) {
  await page.goto('/admin')
  await page.locator('.admin-tabs').getByRole('button', { name: 'Settings', exact: true }).click()
}

function htmlAccent(page: Page) {
  return page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())
}

test('accent dialog previews the chosen color live and persists via settings save', async ({ page }) => {
  await signInAsAdmin(page)
  await mockAdminRoutes(page, { app_name: 'yaemipaste', public_title: 'yaemipaste', upload_access_mode: 'private' })
  await openAdminSettings(page)

  await page.getByTestId('accent-open').click()
  const dialog = page.getByRole('dialog', { name: 'Choose accent color' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Hex color').fill('00ff88')
  await expect.poll(() => htmlAccent(page)).toBe('#00ff88')
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--primary-action').trim())).toBe('#00ff88')
  // Bright accent must switch to dark text for readable contrast.
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--on-accent').trim())).toBe('#1c1917')
  const saveButton = page.getByRole('button', { name: 'Save settings' })
  await expect.poll(() => saveButton.evaluate((button) => getComputedStyle(button).backgroundColor)).toBe('rgb(0, 255, 136)')
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByTestId('accent-open')).toContainText('#00ff88')

  await page.getByRole('button', { name: 'Save settings' }).click()
  await expect(page.getByTestId('notification-list')).toContainText('Settings updated')
})

test('accent dialog cancel reverts the live preview to the saved color', async ({ page }) => {
  await signInAsAdmin(page)
  await mockAdminRoutes(page, { app_name: 'yaemipaste', public_title: 'yaemipaste', accent_color: '#4ade80', upload_access_mode: 'private' })
  await openAdminSettings(page)
  await expect.poll(() => htmlAccent(page)).toBe('#4ade80')

  await page.getByTestId('accent-open').click()
  const dialog = page.getByRole('dialog', { name: 'Choose accent color' })
  await dialog.getByLabel('Hex color').fill('ff0000')
  await expect.poll(() => htmlAccent(page)).toBe('#ff0000')
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect.poll(() => htmlAccent(page)).toBe('#4ade80')
})

test('cached accent applies synchronously before the public-settings fetch resolves', async ({ page }) => {
  await signInAsAdmin(page)
  await mockAdminRoutes(page, { app_name: 'yaemipaste', public_title: 'yaemipaste', upload_access_mode: 'private' })
  // Hold the public-settings response so only the synchronous cache path can
  // apply branding before the async fetch is allowed to finish.
  let releasePublicSettings: () => void
  await page.route('**/auth/admin/public-settings', async (route) => {
    await new Promise<void>((resolve) => { releasePublicSettings = resolve })
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  })
  await page.addInitScript(() => {
    localStorage.setItem('yp_branding', JSON.stringify({
      '--accent': '#4ade80',
      '--accent-h': '#54d68b',
      '--accent-d': '#42bd72',
      '--on-accent': '#1c1917',
      '--primary-action': '#4ade80',
      '--primary-action-h': '#54d68b',
    }))
  })
  await page.goto('/admin')
  // The cached accent is live even though public-settings has not resolved yet.
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())).toBe('#4ade80')
  releasePublicSettings()
})

test('selecting a preset logo updates the favicon and the settings field', async ({ page }) => {
  await signInAsAdmin(page)
  await mockAdminRoutes(page, { app_name: 'yaemipaste', public_title: 'yaemipaste', upload_access_mode: 'private' })
  await openAdminSettings(page)

  await page.getByTestId('logo-open').click()
  const dialog = page.getByRole('dialog', { name: 'Choose site logo' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Use zap icon' }).click()
  await expect.poll(() => page.evaluate(() => document.querySelector('link[rel="icon"]')?.getAttribute('href') ?? '')).toContain('data:image/svg+xml')
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByTestId('logo-open')).toContainText('zap')

  await page.getByRole('button', { name: 'Save settings' }).click()
  await expect(page.getByTestId('notification-list')).toContainText('Settings updated')
})

test('uploading a logo reflects as the favicon and persists', async ({ page }) => {
  await signInAsAdmin(page)
  await mockAdminRoutes(page, { app_name: 'yaemipaste', public_title: 'yaemipaste', upload_access_mode: 'private' })
  await openAdminSettings(page)

  await page.getByTestId('logo-open').click()
  const dialog = page.getByRole('dialog', { name: 'Choose site logo' })
  await dialog.getByRole('button', { name: 'Upload image', exact: true }).click()
  const input = dialog.locator('input[type="file"]')
  await input.setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') })
  await expect.poll(() => page.evaluate(() => document.querySelector('link[rel="icon"]')?.getAttribute('href') ?? '')).toContain('data:image/png;base64,')
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByTestId('logo-open')).toContainText('Uploaded image')

  await page.getByRole('button', { name: 'Save settings' }).click()
  await expect(page.getByTestId('notification-list')).toContainText('Settings updated')
})

test('branding dialogs fit within the mobile viewport without horizontal overflow', async ({ page }) => {
  await signInAsAdmin(page)
  await mockAdminRoutes(page, { app_name: 'yaemipaste', public_title: 'yaemipaste', upload_access_mode: 'private' })
  await page.setViewportSize({ width: 390, height: 844 })
  await openAdminSettings(page)

  await page.getByTestId('accent-open').click()
  const accentDialog = page.getByRole('dialog', { name: 'Choose accent color' })
  const accentBox = await accentDialog.boundingBox()
  expect(accentBox).not.toBeNull()
  expect(accentBox!.width).toBeLessThanOrEqual(390)
  await expect.poll(() => page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth))).toBeLessThanOrEqual(390)
  await accentDialog.getByRole('button', { name: 'Cancel', exact: true }).click()

  await page.getByTestId('logo-open').click()
  const logoDialog = page.getByRole('dialog', { name: 'Choose site logo' })
  const logoBox = await logoDialog.boundingBox()
  expect(logoBox).not.toBeNull()
  expect(logoBox!.width).toBeLessThanOrEqual(390)
  await expect.poll(() => page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth))).toBeLessThanOrEqual(390)
})

test('branding dialog close buttons use the squircle icon-close style', async ({ page }) => {
  await signInAsAdmin(page)
  await mockAdminRoutes(page, { app_name: 'yaemipaste', public_title: 'yaemipaste', upload_access_mode: 'private' })
  await openAdminSettings(page)

  await page.getByTestId('logo-open').click()
  const logoDialog = page.getByRole('dialog', { name: 'Choose site logo' })
  const logoClose = logoDialog.getByRole('button', { name: 'Close logo picker' })
  await expect(logoClose).toHaveClass(/icon-close/)
  const logoBox = await logoClose.boundingBox()
  expect(logoBox).not.toBeNull()
  if (logoBox) expect(Math.abs(logoBox.width - 32)).toBeLessThanOrEqual(1)
  await logoClose.click()
  await expect(logoDialog).toBeHidden()

  await page.getByTestId('accent-open').click()
  const accentDialog = page.getByRole('dialog', { name: 'Choose accent color' })
  const accentClose = accentDialog.getByRole('button', { name: 'Close color picker' })
  await expect(accentClose).toHaveClass(/icon-close/)
  const accentBox = await accentClose.boundingBox()
  expect(accentBox).not.toBeNull()
  if (accentBox) expect(Math.abs(accentBox.width - 32)).toBeLessThanOrEqual(1)
  await accentClose.click()
  await expect(accentDialog).toBeHidden()
})

test('custom site title is cached and restored on reload without flashing the default', async ({ page }) => {
  // First visit: server returns the real public title.
  await mockAdminRoutes(page, { app_name: 'My Paste', public_title: 'My Paste', upload_access_mode: 'private' })
  await page.goto('/')
  await expect.poll(() => page.title()).toBe('My Paste')
  // The applied title must be persisted into the branding cache.
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('yp_branding') ?? '{}').title ?? '')).toBe('My Paste')

  // Reload with the cache present: the cached title must be applied synchronously,
  // before the (mocked slow) public-settings fetch can resolve.
  await page.route('**/auth/admin/public-settings', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300))
    await route.continue()
  })
  await page.reload()
  await expect.poll(() => page.title()).toBe('My Paste')
})

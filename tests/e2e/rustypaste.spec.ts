import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { encryptFileWithPassword } from '../../src/lib/e2ee'

const APP_ORIGIN = (process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:5173').replace(/\/$/, '')
const PREVIEW_RE = /\/file\/[A-Za-z0-9_-]+\/preview$/
const ENCRYPTED_PREVIEW_RE = /\/file\/[A-Za-z0-9_-]+\/preview#[A-Za-z0-9_-]+$/
const PUBLIC_ORIGIN = 'https://paste.example.test'
const API_ORIGIN = 'https://api.example.test'

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
      }),
    })
  })
})

async function signInWithToken(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('rp_token', 'test-token')
    localStorage.setItem('rp_username', 'test-user')
  })
}

async function signInAsTokenUser(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('rp_token', 'test-token')
    localStorage.setItem('rp_username', 'token-user')
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

async function mockAdminApi(page: Page, userCount = 12) {
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
  const uploads = Array.from({ length: 12 }, (_, index) => ({
    path: index === 2 ? 'files/expiring-paste.txt.1785612876517' : `files/upload-${index + 1}.txt`,
    owner: index === 0 ? 'user-1 (ShareX)' : index % 2 === 0 ? 'user-1' : 'user-2',
    file_name: index === 2 ? 'expiring-paste.txt.1785612876517' : `upload-${index + 1}.txt`,
    display_name: index === 0 ? 'ShareX screenshot.png' : index === 2 ? 'expiring-paste.txt.1785612876517' : `upload-${index + 1}.txt`,
    uploader: index % 2 === 0 ? 'user-1' : 'user-2',
    source: index === 0 ? 'ShareX' : 'WebUI',
    size_bytes: 1024 * (index + 1),
    created_at: 1_775_100_000 + index,
    expires_at: index % 3 === 0 ? 1_775_200_000 + index : null,
    expired: index === 3,
    content_type: index === 2 ? null : index === 0 || index % 2 === 1 ? 'image/png' : 'text/plain',
  }))
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

  await page.goto('/files?tab=history')
  await expect(page.getByText('History needs an account')).toBeVisible()
  await page.getByRole('button', { name: 'Log in to view history' }).click()
  await expect(page).toHaveURL(/\/login$/)
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

  await page.goto('/files?tab=history')

  await expect(page.getByRole('button', { name: 'Create account' })).toBeVisible()
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
  await expect(page.getByText('This file is not a rustypaste encrypted file')).toHaveCount(0)
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

  await page.goto('/files?tab=history')
  await page.locator('tr.file-row .filename').first().click()
  const modal = page.locator('.modal')
  await modal.getByRole('button', { name: 'Copy' }).click()
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
  await expect(page.getByText('This file is not a rustypaste encrypted file')).toHaveCount(0)
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
      body: JSON.stringify({ status: 'ok', message: 'rustypaste api root' }),
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
  await page.route('**/api/meta/preview-check.txt', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        file_name: 'preview-check.txt',
        display_name: 'Invoice-April.txt',
        uploader: 'test-user',
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

  await page.goto('/#/preview?p=/preview-check/file.txt')
  await expect(page.getByText('Invoice-April.txt')).toBeVisible()
  await expect(page.getByText('2026-04-17T01:00:00Z')).toBeVisible()
  await expect(page.getByText('test-user')).toBeVisible()
  await expect(page.getByText('preview content')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Download file' })).toHaveAttribute(
    'href',
    /\/file\/[A-Za-z0-9_-]+\/download$/,
  )
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

test('token-auth upload hydrates owner name before sending metadata', async ({ page }) => {
  await signInAsTokenUser(page)
  await mockClipboard(page)

  let uploadedMeta: Record<string, unknown> | null = null
  await page.route('**/token-owner**', async (route) => {
    expect(route.request().headers().authorization).toBe('test-token')
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ username: 'resolved-owner' }),
    })
  })
  await page.route('**/api/', async (route) => {
    const body = route.request().postDataBuffer()
    if (!body) throw new Error('Missing upload body')
    uploadedMeta = JSON.parse(extractMultipartField(body, route.request().headers()['content-type'] ?? '', 'meta').toString('utf8'))
    await route.fulfill({
      status: 200,
      contentType: 'text/plain',
      body: `${APP_ORIGIN}/resolved-owner-check.txt`,
    })
  })

  await page.goto('/#/files')
  await page.locator('input[type="file"]').setInputFiles({
    name: 'resolved-owner-check.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('resolved owner upload'),
  })

  await expect.poll(() => uploadedMeta?.uploader).toBe('resolved-owner')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('rp_username'))).toBe('resolved-owner')
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
      body: JSON.stringify({ status: 'ok', message: 'rustypaste api root' }),
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
  await modal.getByRole('button', { name: 'Copy' }).click()
  await modal.getByRole('menuitem', { name: /Copy preview URL/ }).click()
  await expect.poll(() => page.evaluate(() => (navigator.clipboard as any).__written())).toContain(`/preview#${decryptKey}`)
})

test('history marks rpenc files as encrypted and explains locked preview', async ({ page }) => {
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
  const modal = page.locator('.modal')
  await expect(modal).toBeVisible()
  await expect(modal.getByText('No inline preview available')).toBeVisible()
  await expect(modal.getByText('This is an encrypted file. Add the decryption key/password to preview it.')).toBeVisible()
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

  await modal.getByRole('button', { name: 'Copy' }).click()
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
  await expect(page.getByText('yaemipaste + rustypaste')).toBeVisible()
  await expect(page.getByTestId('open-passkey-modal')).toBeVisible()
  await expect(page.getByTestId('open-change-password')).toBeVisible()
  await page.getByTestId('open-passkey-modal').click()
  await expect(page.getByTestId('passkey-modal')).toBeVisible()
  await expect(page.getByTestId('passkey-add-btn')).toBeVisible()
})

test('admin Preferences control opens and fades closed on desktop and mobile', async ({ page }) => {
  await signInAsAdmin(page)
  await mockAdminApi(page)
  await page.goto('/admin')

  const isMobile = (page.viewportSize()?.width ?? 1280) <= 600
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
  await expect.poll(() => layer.evaluate((element) => getComputedStyle(element).transitionProperty)).toContain('opacity')

  const leaveTransition = page.waitForFunction(() =>
    document.querySelector('[data-testid="settings-layer"]')?.classList.contains('settings-layer-leave-active'),
  )
  await layer.locator('.overlay').click({ position: { x: 8, y: 8 } })
  await leaveTransition
  await expect(layer).toBeHidden()
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

test('settings password modal changes password and supports logout-all option', async ({ page }) => {
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

  await page.goto('/#/files')
  await page.getByRole('button', { name: 'Preferences' }).click()
  await page.getByTestId('open-change-password').click()
  await expect(page.getByTestId('password-modal')).toBeVisible()

  await page.getByLabel('Current Password', { exact: true }).fill('old-secret-123')
  await page.getByLabel('New Password', { exact: true }).fill('new-secret-123')
  await page.getByLabel('Confirm New Password', { exact: true }).fill('new-secret-123')
  await page.getByLabel('Logout all devices after password change').check()
  await page.getByRole('button', { name: 'Update Password' }).click()

  await expect.poll(() => changePayload).toEqual({
    old_password: 'old-secret-123',
    new_password: 'new-secret-123',
  })
  await expect.poll(() => logoutAllCalled).toBeTruthy()
  await expect(page).toHaveURL(/\/login$/)
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
    await expect(page.getByRole('button', { name: 'Logout' })).toBeVisible()

    const settingsBox = await page.locator('.settings-panel').boundingBox()
    const expiryBox = await page.getByTestId('expiry-menu').boundingBox()
    expect(settingsBox).not.toBeNull()
    expect(expiryBox).not.toBeNull()
    if (settingsBox && expiryBox) {
      expect(settingsBox.y + settingsBox.height).toBeLessThanOrEqual(viewport.height)
      expect(expiryBox.y + expiryBox.height).toBeLessThanOrEqual(viewport.height)
    }

    await page.getByRole('button', { name: 'Logout' }).click()
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
  await expect(page.getByTestId('passkey-login-btn')).toBeDisabled()
  await page.locator('input[autocomplete="username"]').fill('test-user')
  await expect(page.getByTestId('passkey-login-btn')).toBeEnabled()
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

test('token login mode blocks tokens already used by accounts', async ({ page }) => {
  await page.route('**/auth/token/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'used' }),
    })
  })

  await page.goto('/#/login')
  await page.getByRole('button', { name: 'Token' }).click()
  await page.locator('input[placeholder="enter token"]').fill('used-token')
  await page.getByRole('button', { name: 'Login' }).click()

  await expect(page.getByText('Token already used.')).toBeVisible()
  await page.getByRole('button', { name: 'Do you have an account?' }).click()
  await expect(page.locator('input[autocomplete="username"]')).toBeVisible()
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
  await page.getByLabel('Search uploads').fill('upload-12')
  await expect(page.getByText('1-1 of 1')).toBeVisible()
  await expect(page.getByText('upload-12.txt')).toBeVisible()

  await page.locator('.admin-tabs').getByRole('button', { name: 'Settings' }).click()
  await page.getByLabel('App name').fill('Verified Paste')
  await page.getByLabel('Public title').fill('Verified public title')
  await page.getByLabel('Maximum file size in gigabytes').fill('2')
  await page.getByRole('button', { name: 'Public uploads' }).click()
  await page.getByRole("checkbox", { name: /Allow new registrations/ }).uncheck()
  await page.getByRole('button', { name: 'Save settings' }).click()
  await expect(page.getByTestId('notification-list')).toContainText('Settings updated')
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
  await page.getByRole('button', { name: 'Actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Delete selected', exact: true }).click()
  let confirmation = page.getByRole('dialog', { name: 'Delete selected uploads?' })
  await expect(confirmation).toBeVisible()
  await confirmation.getByRole('checkbox').check()
  await confirmation.getByRole('button', { name: 'Delete uploads', exact: true }).click()
  await expect(page.getByTestId('notification-list')).toContainText('Selected uploads deleted')

  await page.getByRole('button', { name: 'Actions', exact: true }).click()
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
  await expect(nameButton.locator('.upload-filename-base')).toHaveCSS('color', 'rgb(78, 120, 170)')
  await expect(nameButton.locator('.upload-filename-ext')).toHaveCSS('color', 'rgb(92, 105, 120)')
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
  await expect(copyButton).toHaveCSS('border-radius', '7px')
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
  const copyMenuButton = dialog.getByRole('button', { name: 'Copy file content or URL' })
  await expect(openButton).toBeVisible()
  await expect(copyMenuButton).toBeVisible()
  await copyMenuButton.hover()
  await expect(copyMenuButton).toHaveCSS('transform', 'none')
  await openButton.click()
  const openMenu = dialog.getByRole('menu', { name: 'Open options' })
  await expect(openMenu).toBeVisible()
  await expect(openMenu.getByRole('menuitem', { name: /Open preview/ })).toHaveAttribute('href', /\/file\/upload-1\/preview$/)
  await expect(openMenu.getByRole('menuitem', { name: /Open raw/ })).toHaveAttribute('href', /\/upload-1\/file\.txt$/)
  const openMenuBox = await openMenu.boundingBox()
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
  const copyButtonBox = await copyMenuButton.boundingBox()
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
  expect(actionBox).not.toBeNull()
  expect(downloadBox).not.toBeNull()
  expect(copyBox).not.toBeNull()
  expect(selectBox).not.toBeNull()
  expect(moreBox).not.toBeNull()
  if (actionBox && downloadBox && copyBox && selectBox && moreBox) {
    expect(downloadBox.y).toBeGreaterThanOrEqual(actionBox.y)
    expect(Math.abs(downloadBox.y - copyBox.y)).toBeLessThanOrEqual(1)
    expect(Math.abs(actionBox.x - selectBox.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(downloadBox.width - copyBox.width)).toBeLessThanOrEqual(1)
    expect(Math.abs(copyBox.width - moreBox.width)).toBeLessThanOrEqual(1)
    expect(actionBox.width).toBeGreaterThan(downloadBox.width * 2)
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
  expect(before && after ? Math.abs(before.height - after.height) : 0).toBe(0)
})

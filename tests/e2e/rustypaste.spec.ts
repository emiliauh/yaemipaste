import { expect, test, type Page } from '@playwright/test'

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
      body: `http://127.0.0.1:5173/${encryptedName}`,
    })
  })

  await page.route('**/api/list', async (route) => {
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
  await page.getByTestId('encrypt-toggle').locator('input').check()
  await page.getByTestId('expiry-trigger').click()
  await page.getByTestId('expiry-option-12h').click()
  await page.locator('input[type="file"]').setInputFiles({
    name: 'expiry-check.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('expires soon'),
  })

  await expect.poll(() => uploadExpiry).toBe('12h')
  const shareUrl = await page.evaluate(() => (navigator.clipboard as any).__written())
  expect(shareUrl).toContain(`/index.html#/file?f=expiry-check.txt.rpenc&k=`)

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
  await expect(page.getByText(encryptedName)).toBeVisible()

  expired = true
  await page.reload()
  await page.getByRole('button', { name: 'History' }).click()
  await expect(page.getByText('No files.')).toBeVisible()
})

test('upload shows progress and leaves a share link', async ({ page }) => {
  await signInWithToken(page)
  await mockClipboard(page)

  await page.route('**/api/', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 400))
    await route.fulfill({
      status: 200,
      contentType: 'text/plain',
      body: 'http://127.0.0.1:5173/progress-check.bin',
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
  await expect(page.getByText(/\/progress-check\/file\.bin/)).toBeVisible()
  await expect(page.getByTestId('upload-progress')).toBeHidden()
})

test('upload accepts server short-path responses without surfacing an error', async ({ page }) => {
  await signInWithToken(page)
  await mockClipboard(page)

  await page.route('**/api/', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/plain',
      body: 'http://127.0.0.1:5173/server-id/file.txt',
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
  await expect(page.getByTestId('share-row')).toContainText('/server-id/file.txt')
  await expect.poll(() => page.evaluate(() => (navigator.clipboard as any).__written())).toContain('/server-id/file.txt')
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
      body: 'http://127.0.0.1:5173/copy-blocked.txt',
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
  await expect(page.getByTestId('share-row')).toContainText('/copy-blocked/file.txt')
})

test('mobile upload feedback stays inside the viewport and away from bottom controls', async ({ page }) => {
  await signInWithToken(page)
  await mockClipboard(page)
  await page.setViewportSize({ width: 390, height: 844 })

  await page.route('**/api/', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/plain',
      body: 'http://127.0.0.1:5173/mobile-feedback-check.txt',
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
  const expiryBox = await page.getByTestId('expiry-mobile-toggle').boundingBox()
  expect(shareBox).not.toBeNull()
  expect(notificationBox).not.toBeNull()
  expect(expiryBox).not.toBeNull()
  if (shareBox && notificationBox && expiryBox) {
    expect(shareBox.x).toBeGreaterThanOrEqual(0)
    expect(shareBox.x + shareBox.width).toBeLessThanOrEqual(390)
    expect(notificationBox.x).toBeGreaterThanOrEqual(0)
    expect(notificationBox.x + notificationBox.width).toBeLessThanOrEqual(390)
    expect(notificationBox.y + notificationBox.height).toBeLessThan(expiryBox.y)
    expect(shareBox.y + shareBox.height).toBeLessThan(expiryBox.y)
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
  test(`encrypt checkbox stays square on ${viewport.name}`, async ({ page }) => {
    await signInWithToken(page)
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await page.goto('/#/files')
    const checkbox = page.getByTestId('encrypt-toggle').locator('input')
    const style = await checkbox.evaluate((el) => {
      const computed = getComputedStyle(el)
      return {
        width: computed.width,
        height: computed.height,
        borderRadius: computed.borderRadius,
      }
    })
    await expect(page.getByTestId('encrypt-toggle')).toContainText('encrypt?')
    await expect(page.getByTestId('keep-name-toggle')).toContainText('keep file name?')
    expect(style.width).toBe(style.height)
    expect(Number.parseFloat(style.borderRadius)).toBeLessThanOrEqual(3)
  })
}

test('theme controls persist explicit choices and system mode follows the OS preference', async ({ page }) => {
  await signInWithToken(page)
  await page.emulateMedia({ colorScheme: 'dark' })

  await page.goto('/#/files')
  await expect(page.getByTestId('theme-system')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')

  await page.getByTestId('theme-light').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('rp_theme_mode'))).toBe('light')

  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect(page.getByTestId('theme-light')).toHaveAttribute('aria-pressed', 'true')

  await page.getByTestId('theme-system').click()
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
      body: `http://127.0.0.1:5173/${fileId}.txt.rpenc`,
    })
  })

  await page.goto('/#/files')
  const encryptToggle = page.getByTestId('encrypt-toggle').locator('input')
  await encryptToggle.check()
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
  await encryptToggle.uncheck()

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

  await page.route('**/api/', async (route) => {
    const body = route.request().postDataBuffer()
    if (!body) throw new Error('Missing upload body')
    const contentType = route.request().headers()['content-type'] ?? ''
    uploadedEncryptedBody = extractMultipartField(body, contentType, 'file')
    keepFileNameMeta = JSON.parse(extractMultipartField(body, contentType, 'meta').toString('utf8')).keepFileName
    await route.fulfill({
      status: 200,
      contentType: 'text/plain',
      body: 'http://127.0.0.1:5173/9q2f77m.rpenc',
    })
  })

  await page.goto('/#/files')
  await page.getByTestId('encrypt-toggle').locator('input').check()
  await page.getByTestId('keep-name-toggle').locator('input').uncheck()
  await page.locator('input[type="file"]').setInputFiles({
    name: 'original-name.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('hello from original'),
  })

  await expect.poll(() => keepFileNameMeta).toBe(false)
  let shareUrl = await page.evaluate(() => (navigator.clipboard as any).__written())
  if (!shareUrl) {
    shareUrl = (await page.locator('[data-testid="share-row"] a').first().textContent()) ?? ''
  }
  expect(shareUrl).not.toBe('')
  expect(shareUrl).not.toContain('original-name')
  expect(shareUrl).toContain('/index.html#/file?f=9q2f77m.rpenc&k=')
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
      body: 'http://127.0.0.1:5173/mobile-decrypt.txt.rpenc',
    })
  })

  await page.goto('/#/files')
  await page.getByTestId('encrypt-toggle').locator('input').check()
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
  await page.route('**/preview-check/file.txt?raw=1', async (route) => {
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
    /\/preview-check\/file\.txt\?download=true$/,
  )
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
      body: JSON.stringify({ url: 'http://127.0.0.1:5173/flow-e2e/file.txt' }),
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
  await page.route('**/flow-e2e/file.txt?raw=1', async (route) => {
    await route.fulfill({ status: deleted ? 404 : 200, contentType: 'text/plain', body: deleted ? 'not found' : body })
  })
  await page.route('**/flow-e2e/file.txt?download=true', async (route) => {
    await route.fulfill({
      status: deleted ? 404 : 200,
      contentType: 'text/plain',
      headers: { 'content-disposition': `attachment; filename="${fileName}"` },
      body: deleted ? 'not found' : body,
    })
  })
  await page.route('**/api/list', async (route) => {
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
  await expect(shareLink).toHaveText(/\/flow-e2e\/file\.txt$/)
  const href = await shareLink.getAttribute('href')
  expect(href).toBe('http://127.0.0.1:5173/flow-e2e/file.txt')

  await page.goto(href ?? '/')
  await expect(page).toHaveURL(/#\/preview\?p=/)
  await expect(page.getByRole('heading', { name: 'File preview' })).toBeVisible()
  await expect(page.locator('.text-preview')).toContainText(body)

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Download file' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe(fileName)

  await page.goto('/#/files')
  await page.getByRole('button', { name: 'History' }).click()
  await expect(page.getByText(fileName)).toBeVisible()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect.poll(() => deleteAuth).toBe('test-token')
  await expect(page.getByText(fileName)).toBeHidden()

  await page.reload()
  await page.getByRole('button', { name: 'History' }).click()
  await expect(page.getByText('No files.')).toBeVisible()
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
  await page.route('**/sharex-config/file.sxcu?raw=1', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{}',
    })
  })

  await page.goto('/#/preview?p=/sharex-config/file.sxcu')
  await expect(page.locator('iframe[title="File preview"]')).toBeVisible()
  const openButton = page.getByRole('link', { name: 'Open in app' })
  await expect(openButton).toHaveAttribute('href', /download=true$/)
  await expect(openButton).toHaveAttribute('download', 'yaemipaste.sxcu')
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
  await page.route('**/redirect-check/file.txt?raw=1', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/plain',
      body: 'preview',
    })
  })

  await page.goto('/redirect-check/file.txt')
  await expect(page).toHaveURL(/#\/preview\?p=/)
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
  await page.route('**/png-check/file.png?raw=1', async (route) => {
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
  await expect(page).toHaveURL(/#\/preview\?p=/)
  await expect(page.getByText('png-check.png')).toBeVisible()
  await expect(page.locator('.preview-frame img')).toBeVisible()
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
      body: `http://127.0.0.1:5173/notify-${uploadCount}.txt`,
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
  await page.route('**/api/list', async (route) => {
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

  page.on('dialog', (dialog) => dialog.accept())

  await page.goto('/#/files')
  await page.getByRole('button', { name: 'History' }).click()
  await page.getByRole('button', { name: 'Delete All' }).click()

  await expect(page.getByTestId('notification-row')).toHaveCount(5)
  await expect(page.getByTestId('notification-list')).toContainText('history-file-6.txt')
  await expect(page.getByTestId('notification-list')).not.toContainText('history-file-0.txt')
})

test('history hover preview clears immediately when deleting the hovered file', async ({ page }) => {
  const supportsHover = await page.evaluate(() => window.matchMedia('(hover: hover) and (pointer: fine)').matches)
  test.skip(!supportsHover, 'Hover previews are only available on pointer/hover devices')
  await signInWithToken(page)

  await page.route('**/api/list', async (route) => {
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
  await page.route('**/api/hover-delete.png?raw=1', async (route) => {
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
  await row.getByRole('button', { name: 'Delete' }).click()
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

  await page.route('**/api/list', async (route) => {
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

  await page.goto('/#/files')
  await page.getByRole('button', { name: 'History' }).click()
  await expect(page.getByText('history-check.txt')).toBeVisible()
  await page.getByRole('button', { name: 'Copy' }).click()
  await expect.poll(() => page.evaluate(() => (navigator.clipboard as any).__written())).toContain('/history-check/file.txt')
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.locator('.modal-backdrop')).toHaveCount(0)
  await expect(page.getByText('history-check.txt')).toBeHidden()

  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByLabel('API Base URL')).toBeVisible()
  await page.getByLabel('API Base URL').fill('https://papi.example.test/')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('rp_api_base'))).toBe('https://papi.example.test')
  await expect(page.locator('.settings-panel')).toBeHidden()

  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.locator('.settings-panel')).toBeHidden()
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
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByText('♥ yaemipaste + rustypaste')).toBeVisible()
  await expect(page.getByTestId('open-passkey-modal')).toBeVisible()
  await page.getByTestId('open-passkey-modal').click()
  await expect(page.getByTestId('passkey-modal')).toBeVisible()
  await expect(page.getByTestId('passkey-add-btn')).toBeVisible()
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
  await page.getByRole('button', { name: 'Settings' }).click()
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
  await page.getByRole('button', { name: 'Settings' }).click()
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
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByTestId('open-passkey-modal').click()
  await page.getByTestId('passkey-add-btn').click()

  await expect(page.locator('.passkey-error')).toContainText('Passkey response is missing challenge')
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

    await page.getByRole('button', { name: 'Settings' }).click()
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
    await expect(page).toHaveURL(/#\/login$/)
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
      body: 'http://127.0.0.1:5173/never-check.txt',
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
  await page.route('**/api/list', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  })

  await page.goto('/#/login')
  await page.locator('input[autocomplete="username"]').fill('session-user')
  await page.locator('input[autocomplete="current-password"]').fill('password123')
  await page.getByLabel('remember me').uncheck()
  await page.getByRole('button', { name: 'Login' }).click()

  await expect(page).toHaveURL(/#\/files$/)
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

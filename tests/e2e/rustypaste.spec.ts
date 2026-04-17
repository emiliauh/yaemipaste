import { expect, test, type Page } from '@playwright/test'

async function signInWithToken(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('rp_token', 'test-token')
    localStorage.setItem('rp_username', 'test-user')
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

function extractMultipartFile(body: Buffer, contentType: string): Buffer {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2]
  if (!boundary) throw new Error('Missing multipart boundary')

  const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'))
  if (headerEnd === -1) throw new Error('Missing multipart file headers')

  const fileStart = headerEnd + 4
  const fileEnd = body.indexOf(Buffer.from(`\r\n--${boundary}`), fileStart)
  if (fileEnd === -1) throw new Error('Missing multipart file boundary')

  return body.subarray(fileStart, fileEnd)
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
    uploadedEncryptedBody = extractMultipartFile(body, route.request().headers()['content-type'] ?? '')
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
  await page.getByTestId('expiry-trigger').click()
  await page.getByTestId('expiry-option-12h').click()
  await page.locator('input[type="file"]').setInputFiles({
    name: 'expiry-check.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('expires soon'),
  })

  await expect.poll(() => uploadExpiry).toBe('12h')
  const shareUrl = await page.evaluate(() => (navigator.clipboard as any).__written())
  expect(shareUrl).toContain(`${encryptedName}#/file?`)

  await page.route(`**/${encryptedName}?raw=1`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/octet-stream',
      body: uploadedEncryptedBody ?? Buffer.from(''),
    })
  })

  const previewUrl = new URL(shareUrl)
  await page.goto(`http://127.0.0.1:5173/#/file?${previewUrl.hash.split('?')[1]}`)
  await expect(page.locator('h1')).toHaveText('expiry-check.txt')
  await expect(page.getByText('expires soon')).toBeVisible()

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
      body: 'http://127.0.0.1:5173/progress-check.bin.rpenc',
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
  await expect(page.getByText('Latest encrypted link')).toBeVisible()
  await expect(page.getByText(/progress-check\.bin\.rpenc#\/file/)).toBeVisible()
  await expect(page.getByTestId('upload-progress')).toBeHidden()
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
  await expect.poll(() => page.evaluate(() => (navigator.clipboard as any).__written())).toContain('history-check.txt')
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.getByText('history-check.txt')).toBeHidden()

  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByLabel('API Base URL').fill('/api')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.locator('.settings-panel')).toBeHidden()

  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.locator('.settings-panel')).toBeHidden()
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

    await page.getByTestId('expiry-trigger').click()
    await expect(page.getByTestId('expiry-options')).toBeVisible()
    await page.getByTestId('expiry-option-7d').click()
    await expect(page.getByTestId('expiry-trigger')).toContainText('7 days')

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

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

  await page.route('https://api.example.invalid/', async (route) => {
    uploadExpiry = route.request().headers().expire ?? ''
    const body = route.request().postDataBuffer()
    if (!body) throw new Error('Missing upload body')
    uploadedEncryptedBody = extractMultipartFile(body, route.request().headers()['content-type'] ?? '')
    await route.fulfill({
      status: 200,
      contentType: 'text/plain',
      body: `https://example.invalid/${encryptedName}`,
    })
  })

  await page.route('https://api.example.invalid/list', async (route) => {
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
  expect(shareUrl).toContain('/#/file?')

  await page.route(`https://example.invalid/${encryptedName}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/octet-stream',
      body: uploadedEncryptedBody ?? Buffer.from(''),
    })
  })

  await page.goto(shareUrl)
  await expect(page.getByText('expiry-check.txt')).toBeVisible()
  await expect(page.getByText('expires soon')).toBeVisible()

  await page.goto('/#/files')
  await page.getByRole('button', { name: 'History' }).click()
  await expect(page.getByText(encryptedName)).toBeVisible()

  expired = true
  await page.reload()
  await page.getByRole('button', { name: 'History' }).click()
  await expect(page.getByText('No files.')).toBeVisible()
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

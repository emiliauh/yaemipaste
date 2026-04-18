import { expect, test } from '@playwright/test'

const liveToken = process.env.PLAYWRIGHT_LIVE_PASTE_TOKEN?.trim() ?? ''
const liveBaseUrl = process.env.PLAYWRIGHT_LIVE_BASE_URL?.replace(/\/$/, '') ?? ''
const liveApiBaseUrl = process.env.PLAYWRIGHT_LIVE_API_BASE_URL?.replace(/\/$/, '') ?? ''

function decodeFileToken(token: string): string {
  try {
    const b64 = token.replace(/-/g, '+').replace(/_/g, '/')
    return atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  } catch { return token }
}

function filenameFromPreviewHref(href: string): string {
  const match = href.match(/\/file\/([^/+]+)(?:\+[^/]+)?\/preview$/)
  return match ? decodeFileToken(match[1]) : ''
}

test.describe('live backend integration', () => {
  test('upload -> preview -> raw download -> delete works against a real backend', async ({ page, request }) => {
    test.skip(!liveToken, 'Set PLAYWRIGHT_LIVE_PASTE_TOKEN to run live integration tests')
    test.skip(!liveBaseUrl, 'Set PLAYWRIGHT_LIVE_BASE_URL to run live integration tests')

    const consoleErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })

    await page.addInitScript((token) => {
      localStorage.setItem('rp_token', token)
      localStorage.setItem('rp_username', 'live-e2e')
    }, liveToken)

    await page.goto(`${liveBaseUrl}/`)
    await page.waitForURL('**/files')
    const fileName = `live-e2e-${Date.now()}.txt`
    const body = `live check ${fileName}`
    await page.locator('input[type="file"]').setInputFiles({
      name: fileName,
      mimeType: 'text/plain',
      buffer: Buffer.from(body),
    })

    const shareLink = page.locator('[data-testid="share-row"] a').first()
    await expect(shareLink).toBeVisible()
    const href = await shareLink.getAttribute('href')
    expect(href ?? '').toMatch(/\/file\/[A-Za-z0-9_-]+\/preview$/)

    await page.goto(href ?? `${liveBaseUrl}/`)
    await expect(page.getByRole('heading', { name: 'File preview' })).toBeVisible()
    await expect(page.locator('.text-preview')).toContainText(body)
    const downloadHref = await page.getByRole('link', { name: 'Download file' }).getAttribute('href')
    expect(downloadHref ?? '').toContain('download=true')
    const downloadResponse = await request.get(downloadHref ?? '')
    expect(downloadResponse.ok()).toBeTruthy()
    expect(await downloadResponse.text()).toBe(body)

    const uploadedName = filenameFromPreviewHref(href ?? '')
    expect(uploadedName).toBeTruthy()
    const deleteBase = liveApiBaseUrl || `${liveBaseUrl}/api`
    const deleteResponse = await request.delete(`${deleteBase}/${encodeURIComponent(uploadedName)}`, {
      headers: { Authorization: liveToken },
    })
    expect(deleteResponse.ok()).toBeTruthy()

    await page.goto(`${liveBaseUrl}/`)
    await page.waitForURL('**/files')
    await page.getByRole('button', { name: 'History' }).click()
    await expect(page.getByText(uploadedName)).toHaveCount(0)
    expect(consoleErrors.some((line) => line.includes('Upload endpoint returned unexpected JSON'))).toBeFalsy()
  })
})

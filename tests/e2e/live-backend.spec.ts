import { expect, test } from '@playwright/test'

const liveToken = process.env.PLAYWRIGHT_LIVE_PASTE_TOKEN?.trim() ?? ''
const liveBaseUrl = process.env.PLAYWRIGHT_LIVE_BASE_URL?.replace(/\/$/, '') ?? ''
const liveApiBaseUrl = process.env.PLAYWRIGHT_LIVE_API_BASE_URL?.replace(/\/$/, '') ?? ''
const liveResolveBaseUrl = process.env.PLAYWRIGHT_LIVE_RESOLVE_BASE_URL?.replace(/\/$/, '') ?? (liveBaseUrl ? `${liveBaseUrl}/api/resolve` : '')

function tokenFromPreviewHref(href: string): string {
  const match = href.match(/\/file\/([^/+]+)(?:\+[^/]+)?\/preview(?:\?.*)?$/)
  return match ? decodeURIComponent(match[1]) : ''
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
    const token = tokenFromPreviewHref(href ?? '')
    const resolveResponse = await request.get(`${liveResolveBaseUrl}/${encodeURIComponent(token)}`)
    expect(resolveResponse.ok()).toBeTruthy()
    const resolvePayload = await resolveResponse.json() as { file_name?: string }
    const uploadedName = resolvePayload.file_name ?? ''
    expect(uploadedName).toBeTruthy()
    const apiBase = liveApiBaseUrl || `${liveBaseUrl}/api`
    const rawPublicUrl = `${liveBaseUrl}/file/${encodeURIComponent(token)}/raw`

    await page.goto(href ?? `${liveBaseUrl}/`)
    await expect(page.getByRole('heading', { name: 'File preview' })).toBeVisible()
    const rawResponse = await request.get(rawPublicUrl)
    expect(rawResponse.ok()).toBeTruthy()
    expect(await rawResponse.text()).toBe(body)

    const deleteResponse = await request.delete(`${apiBase}/${encodeURIComponent(uploadedName)}`, {
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

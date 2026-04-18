import { expect, test } from '@playwright/test'

const liveToken = process.env.PLAYWRIGHT_LIVE_PASTE_TOKEN?.trim() ?? ''
const liveBaseUrl = process.env.PLAYWRIGHT_LIVE_BASE_URL?.replace(/\/$/, '') ?? ''
const liveApiBaseUrl = process.env.PLAYWRIGHT_LIVE_API_BASE_URL?.replace(/\/$/, '') ?? ''

function rawFileNameFromPublicPath(pathname: string): string {
  const cleaned = pathname.replace(/^\/+/, '').trim()
  const [idSegment = '', tailSegment = ''] = cleaned.split('/', 2)
  const id = decodeURIComponent(idSegment)
  const tail = decodeURIComponent(tailSegment)
  if (!id) return ''
  if (!tail) return id
  if (tail === 'file') return id
  if (tail.startsWith('file.')) return `${id}.${tail.slice(5)}`
  return `${id}.${tail}`
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

    await page.goto(`${liveBaseUrl}/#/files`)
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
    expect(href ?? '').toMatch(/\/[^/]+\/file\.txt$/)

    await page.goto(href ?? `${liveBaseUrl}/#/files`)
    await expect(page.getByRole('heading', { name: 'File preview' })).toBeVisible()
    await expect(page.locator('.text-preview')).toContainText(body)
    const downloadHref = await page.getByRole('link', { name: 'Download file' }).getAttribute('href')
    expect(downloadHref ?? '').toContain('download=true')
    const downloadResponse = await request.get(downloadHref ?? '')
    expect(downloadResponse.ok()).toBeTruthy()
    expect(await downloadResponse.text()).toBe(body)

    const uploadedName = rawFileNameFromPublicPath(new URL(href ?? '').pathname)
    expect(uploadedName).toBeTruthy()
    const deleteBase = liveApiBaseUrl || `${liveBaseUrl}/api`
    const deleteResponse = await request.delete(`${deleteBase}/${encodeURIComponent(uploadedName)}`, {
      headers: { Authorization: liveToken },
    })
    expect(deleteResponse.ok()).toBeTruthy()

    await page.goto(`${liveBaseUrl}/#/files`)
    await page.getByRole('button', { name: 'History' }).click()
    await expect(page.getByText(uploadedName)).toHaveCount(0)
    expect(consoleErrors.some((line) => line.includes('Upload endpoint returned unexpected JSON'))).toBeFalsy()
  })
})

import { expect, test } from '@playwright/test'

const liveToken = process.env.PLAYWRIGHT_LIVE_PASTE_TOKEN?.trim() ?? ''
const liveBaseUrl = process.env.PLAYWRIGHT_LIVE_BASE_URL?.replace(/\/$/, '') ?? ''
const liveApiBaseUrl = process.env.PLAYWRIGHT_LIVE_API_BASE_URL?.replace(/\/$/, '') ?? ''
const liveResolveBaseUrl = process.env.PLAYWRIGHT_LIVE_RESOLVE_BASE_URL?.replace(/\/$/, '') ?? (liveBaseUrl ? `${liveBaseUrl}/resolve` : '')

function tokenFromPreviewHref(href: string): string {
  const match = href.match(/\/file\/([^/+]+)(?:\+[^/]+)?\/preview(?:\?.*)?$/)
  return match ? decodeURIComponent(match[1]) : ''
}

test('production: password encryption upload + preview + history thumbnail', async ({ page, request }) => {
  test.skip(!liveToken, 'Set PLAYWRIGHT_LIVE_PASTE_TOKEN to run production live verification')
  test.skip(!liveBaseUrl, 'Set PLAYWRIGHT_LIVE_BASE_URL to run production live verification')
  test.skip(!liveApiBaseUrl, 'Set PLAYWRIGHT_LIVE_API_BASE_URL to run production live verification')

  const uploadRequestUrls: string[] = []
  const uploadResponseBodies: string[] = []

  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().startsWith(liveApiBaseUrl)) {
      uploadRequestUrls.push(req.url())
    }
  })

  page.on('response', async (resp) => {
    if (resp.request().method() === 'POST' && resp.url().startsWith(liveApiBaseUrl)) {
      try {
        uploadResponseBodies.push(await resp.text())
      } catch {
        uploadResponseBodies.push('')
      }
    }
  })

  await page.addInitScript((token) => {
    localStorage.setItem('rp_token', token)
    localStorage.setItem('rp_username', 'prod-live-e2e')
  }, liveToken)

  await page.goto('/#/files')
  await page.waitForURL('**/files')

  await page.getByTestId('encrypt-toggle').click()
  await page.getByTestId('encrypt-toggle').click()
  await page.locator('input.pw-input').fill('ProdPass!123')

  const passwordText = `password encrypted check ${Date.now()}`
  await page.locator('input[type="file"]').setInputFiles({
    name: `prod-password-${Date.now()}.txt`,
    mimeType: 'text/plain',
    buffer: Buffer.from(passwordText),
  })

  const passwordShare = page.locator('[data-testid="share-row"] a').first()
  await expect(passwordShare).toBeVisible()
  const passwordHref = await passwordShare.getAttribute('href')
  expect(passwordHref ?? '').toMatch(new RegExp(`^${liveBaseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/file/[A-Za-z0-9_-]+\\+pw:[A-Za-z0-9_-]+/preview$`))
  const passwordToken = tokenFromPreviewHref(passwordHref ?? '')
  const passwordResolve = await request.get(`${liveResolveBaseUrl}/${encodeURIComponent(passwordToken)}`)
  expect(passwordResolve.ok()).toBeTruthy()
  const passwordFileName = ((await passwordResolve.json()) as { file_name?: string }).file_name ?? ''
  expect(passwordFileName).toBeTruthy()

  await page.goto(passwordHref ?? '/')
  await page.getByPlaceholder('Enter password…').fill('ProdPass!123')
  await page.getByRole('button', { name: 'Decrypt' }).click()
  await expect(page.getByText('Password-protected file')).toBeVisible()
  await expect(page.getByText(passwordText)).toBeVisible()

  await page.goto('/#/files')
  await page.waitForURL('**/files')

  const imageName = `prod-thumb-${Date.now()}.png`
  await page.locator('input[type="file"]').setInputFiles({
    name: imageName,
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7fM7cAAAAASUVORK5CYII=',
      'base64',
    ),
  })

  const imageShare = page.locator('[data-testid="share-row"] a').first()
  await expect(imageShare).toBeVisible()
  const imageHref = await imageShare.getAttribute('href')
  expect(imageHref ?? '').toMatch(new RegExp(`^${liveBaseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/file/[A-Za-z0-9_-]+/preview$`))
  const imageToken = tokenFromPreviewHref(imageHref ?? '')
  const imageResolve = await request.get(`${liveResolveBaseUrl}/${encodeURIComponent(imageToken)}`)
  expect(imageResolve.ok()).toBeTruthy()
  const imageFileName = ((await imageResolve.json()) as { file_name?: string }).file_name ?? ''
  expect(imageFileName).toBeTruthy()

  await page.goto(imageHref ?? '/')
  await expect(page.getByRole('heading', { name: 'File preview' })).toBeVisible()
  const previewFrame = page.locator('iframe[title="File preview"]')
  if (await previewFrame.count()) await expect(previewFrame).toBeVisible()
  else await expect(page.locator('img')).toBeVisible()
  await expect(page.getByRole('link', { name: 'View raw' })).toHaveAttribute(
    'href',
    new RegExp(`^${liveBaseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/file/[A-Za-z0-9_-]+/raw$`),
  )

  await page.goto('/#/files')
  await page.waitForURL('**/files')
  await page.getByRole('button', { name: 'History' }).click()
  const firstHistoryRow = page.locator('tr.file-row').first()
  await expect(firstHistoryRow).toBeVisible()
  await expect(firstHistoryRow.getByRole('img').first()).toBeVisible()

  expect(uploadRequestUrls.length).toBeGreaterThanOrEqual(2)
  for (const url of uploadRequestUrls) expect(url).toBe(`${liveApiBaseUrl}/`)
  expect(uploadResponseBodies.some((body) => body.toLowerCase().includes('rustypaste api root'))).toBeFalsy()

  await request.delete(`${liveApiBaseUrl}/${encodeURIComponent(imageFileName)}`, {
    headers: { Authorization: liveToken },
  })
  await request.delete(`${liveApiBaseUrl}/${encodeURIComponent(passwordFileName)}`, {
    headers: { Authorization: liveToken },
  })
})

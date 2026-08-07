import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'

const liveToken = process.env.PLAYWRIGHT_LIVE_PASTE_TOKEN?.trim() ?? ''
const publicFileToken = process.env.PLAYWRIGHT_LIVE_PUBLIC_FILE_TOKEN?.trim() ?? ''
const liveBaseUrl = process.env.PLAYWRIGHT_LIVE_BASE_URL?.replace(/\/$/, '') ?? ''
const liveApiBaseUrl = process.env.PLAYWRIGHT_LIVE_API_BASE_URL?.replace(/\/$/, '') ?? ''
const liveResolveBaseUrl = process.env.PLAYWRIGHT_LIVE_RESOLVE_BASE_URL?.replace(/\/$/, '') ?? (liveBaseUrl ? `${liveBaseUrl}/api/resolve` : '')
const liveBrowserBaseUrl = process.env.PLAYWRIGHT_BROWSER_BASE_URL?.replace(/\/$/, '') ?? liveBaseUrl
const liveBrowserApiBaseUrl = liveBrowserBaseUrl ? `${liveBrowserBaseUrl}/api` : ''

function tokenFromPreviewHref(href: string): string {
  const match = href.match(/\/file\/([^/+]+)(?:\+[^/]+)?\/preview(?:\?.*)?$/)
  return match ? decodeURIComponent(match[1]) : ''
}

function rewritePreviewOrigin(href: string): string {
  return href.replace(/^https?:\/\/[^/]+/, liveBrowserBaseUrl)
}

test('production: anonymous public preview resolves, renders, and downloads', async ({ page, request }) => {
  test.skip(!publicFileToken, 'Set PLAYWRIGHT_LIVE_PUBLIC_FILE_TOKEN to run public preview verification')
  test.skip(!liveBrowserBaseUrl, 'Set PLAYWRIGHT_BROWSER_BASE_URL to run public preview verification')

  const apiRequests: Array<{ url: string; authorization: string | undefined }> = []
  page.on('request', (req) => {
    if (req.url().includes('/api/')) {
      apiRequests.push({ url: req.url(), authorization: req.headers().authorization })
    }
  })

  await page.goto(`${liveBrowserBaseUrl}/file/${encodeURIComponent(publicFileToken)}/preview`)
  await expect(page.getByRole('heading', { name: 'File preview' })).toBeVisible()
  await expect(page.getByText('File not found')).toHaveCount(0)

  const rawLink = page.getByRole('link', { name: 'View raw' })
  const rawHref = await rawLink.getAttribute('href')
  expect(rawHref).toContain('?raw=1')
  const rawResponse = await request.get(new URL(rawHref ?? '', liveBrowserBaseUrl).toString())
  expect(rawResponse.ok()).toBeTruthy()
  expect((await rawResponse.body()).length).toBeGreaterThan(0)

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Download file' }).click()
  const download = await downloadPromise
  expect(await download.path()).not.toBeNull()

  expect(apiRequests.filter((entry) => entry.url.includes('/api/resolve/')).every((entry) => !entry.authorization)).toBeTruthy()
})

test('production: password encryption upload + preview + history thumbnail', async ({ page, request }) => {
  test.skip(!liveToken, 'Set PLAYWRIGHT_LIVE_PASTE_TOKEN to run production live verification')
  test.skip(!liveBaseUrl, 'Set PLAYWRIGHT_LIVE_BASE_URL to run production live verification')
  test.skip(!liveApiBaseUrl, 'Set PLAYWRIGHT_LIVE_API_BASE_URL to run production live verification')
  test.skip(!liveBrowserBaseUrl, 'Set PLAYWRIGHT_BROWSER_BASE_URL when the browser must use a different origin')

  const uploadRequestUrls: string[] = []
  const uploadResponseBodies: string[] = []
  const browserRawRequestUrls: string[] = []

  page.on('request', (req) => {
    if (req.method() === 'POST' && (req.url().startsWith(liveApiBaseUrl) || req.url().startsWith(liveBrowserApiBaseUrl))) {
      uploadRequestUrls.push(req.url())
    }
    if (req.method() === 'GET' && req.url().startsWith(liveBrowserApiBaseUrl) && req.url().includes('?raw=1')) {
      browserRawRequestUrls.push(req.url())
    }
  })

  page.on('response', async (resp) => {
    if (resp.request().method() === 'POST' && (resp.url().startsWith(liveApiBaseUrl) || resp.url().startsWith(liveBrowserApiBaseUrl))) {
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

  await page.goto(`${liveBrowserBaseUrl}/#/files`)
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

  await page.goto(rewritePreviewOrigin(passwordHref ?? `${liveBrowserBaseUrl}/`))
  await page.getByPlaceholder('Enter password…').fill('ProdPass!123')
  await page.getByRole('button', { name: 'Decrypt' }).click()
  await expect(page.getByText('Password-protected file')).toBeVisible()
  await expect(page.getByText(passwordText)).toBeVisible()

  await page.goto(`${liveBrowserBaseUrl}/#/files`)
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

  await page.goto(rewritePreviewOrigin(imageHref ?? `${liveBrowserBaseUrl}/`))
  await expect(page.getByRole('heading', { name: 'File preview' })).toBeVisible()
  const image = page.locator('.preview-frame img')
  await expect(image).toBeVisible()
  await expect.poll(() => image.evaluate((element) => element.naturalWidth)).toBeGreaterThan(0)
  const rawHref = await page.getByRole('link', { name: 'View raw' }).getAttribute('href')
  const rawUrl = new URL(rawHref ?? '', liveBrowserBaseUrl).toString()
  expect(rawUrl).toMatch(new RegExp(`^${liveBrowserApiBaseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[^?]+\\?raw=1$`))
  const rawResponse = await request.get(rawUrl)
  expect(rawResponse.ok()).toBeTruthy()
  expect(rawResponse.headers()['content-type']).toContain('image/png')
  expect(await rawResponse.body()).toEqual(Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7fM7cAAAAASUVORK5CYII=',
    'base64',
  ))

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Download file' }).click()
  const download = await downloadPromise
  const downloadPath = await download.path()
  expect(downloadPath).toBeTruthy()
  if (downloadPath) expect(await readFile(downloadPath)).toEqual(Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7fM7cAAAAASUVORK5CYII=',
    'base64',
  ))

  await page.goto(`${liveBrowserBaseUrl}/#/files`)
  await page.waitForURL('**/files')
  await page.getByRole('button', { name: 'History' }).click()
  const firstHistoryRow = page.locator('tr.file-row').first()
  await expect(firstHistoryRow).toBeVisible()
  await expect(firstHistoryRow).toContainText(imageName)

  expect(uploadRequestUrls.length).toBeGreaterThanOrEqual(2)
  for (const url of uploadRequestUrls) {
    expect([`${liveApiBaseUrl}/`, `${liveBrowserApiBaseUrl}/`]).toContain(url)
  }
  expect(uploadResponseBodies.some((body) => body.toLowerCase().includes('legacy api root'))).toBeFalsy()
  expect(browserRawRequestUrls.some((url) => url.includes(encodeURIComponent(imageFileName)))).toBeTruthy()

  await request.delete(`${liveApiBaseUrl}/${encodeURIComponent(imageFileName)}`, {
    headers: { Authorization: liveToken },
  })
  await request.delete(`${liveApiBaseUrl}/${encodeURIComponent(passwordFileName)}`, {
    headers: { Authorization: liveToken },
  })
})

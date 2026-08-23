import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { isInstallerSecret } from '../src/auth.service.js'
import { blockedAddress } from '../src/safe-http.js'

const root = mkdtempSync(join(tmpdir(), 'yaemipaste-nest-'))
process.env.YAEMIPASTE_START = '0'
process.env.CONFIG = '/dev/null'
process.env.DB_PATH = join(root, 'users.db')
process.env.SERVER__UPLOAD_PATH = join(root, 'uploads')
process.env.SERVER__ADDRESS = '127.0.0.1:0'
process.env.PASTE_URL = 'http://localhost:8080'
process.env.ALLOW_ANONYMOUS_UPLOADS = '1'
process.env.REMOTE_UPLOADS_ENABLED = '1'
process.env.JWT_SECRET = 'test-only-secret-with-more-than-32-characters'
process.env.AUTH_ADMIN_BEARER = 'installer-test-bearer'
process.env.CORS_ALLOWED_ORIGINS = 'https://allowed.example'
process.env.PASTE_API = 'https://upload.example/api'
process.env.PASSKEYS_ENABLED = '0'

const { createApp } = await import('../src/main.js')
const { app, config } = await createApp()
await app.listen(0, '127.0.0.1')
const base = `http://127.0.0.1:${(app.getHttpServer().address() as any).port}`
let adminJwt = ''
let pasteToken = ''

async function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set('Connection', 'close')
  const response = await fetch(base + path, { redirect: 'manual', ...init, headers })
  const text = await response.text()
  let json: any = undefined
  try { json = JSON.parse(text) } catch { /* plain-text endpoint */ }
  return { response, text, json }
}

type ChunkedUpload = {
  end: () => void
  response: Promise<{ status: number; body: string }>
  write: (chunk: string) => void
}

function chunkedMultipartUpload(name: string, headers: Record<string, string> = {}): ChunkedUpload {
  const boundary = `----yaemipaste-test-${name}`
  let resolveResponse: (value: { status: number; body: string }) => void
  let rejectResponse: (reason?: unknown) => void
  const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
    resolveResponse = resolve
    rejectResponse = reject
  })
  const upload = httpRequest(base, {
    method: 'POST',
    headers: {
      Connection: 'close',
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      ...headers,
    },
  }, incoming => {
    let body = ''
    incoming.setEncoding('utf8')
    incoming.on('data', (chunk: string) => { body += chunk })
    incoming.on('end', () => resolveResponse!({ status: incoming.statusCode ?? 0, body }))
  })
  upload.once('error', rejectResponse!)
  upload.write(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}.txt"\r\nContent-Type: text/plain\r\n\r\n`)
  return {
    response,
    write: chunk => { upload.write(chunk) },
    end: () => { upload.end(`\r\n--${boundary}--\r\n`) },
  }
}

after(async () => {
  const server = app.getHttpServer()
  server.closeAllConnections?.()
  server.closeIdleConnections?.()
  server.unref?.()
  await Promise.race([app.close(), new Promise(resolve => setTimeout(resolve, 250))])
})

describe('NestJS API compatibility', { concurrency: false }, () => {
  test('accepts only installer-format production secrets', () => {
    assert.equal(isInstallerSecret('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'), true)
    assert.equal(isInstallerSecret('a'.repeat(64)), false)
    assert.equal(isInstallerSecret('A'.repeat(64)), false)
    assert.equal(isInstallerSecret('abc123'), false)
  })

  test('uploads, serves, resolves, previews, and reports metadata', async () => {
    const form = new FormData()
    form.append('meta', JSON.stringify({ keepFileName: true, originalName: 'hello.txt', uploader: 'Anonymous', source: 'WebUI' }))
    form.append('file', new Blob(['hello nest']), 'hello.txt')
    const upload = await request('/', { method: 'POST', body: form })
    assert.equal(upload.response.status, 200)
    assert.match(upload.text, /hello\/file\.txt/)

    const raw = await request('/hello.txt?raw=1')
    assert.equal(raw.response.status, 200)
    assert.equal(raw.text, 'hello nest')

    const htmlRedirect = await request('/hello.txt', { headers: { Accept: 'text/html' } })
    assert.equal(htmlRedirect.response.status, 302)
    assert.equal(htmlRedirect.response.headers.get('location'), 'http://localhost:8080/file/hello/preview')

    const meta = await request('/meta/hello.txt')
    assert.equal(meta.response.status, 200)
    assert.equal(meta.response.headers.get('cache-control'), 'no-store')
    assert.equal(meta.json.file_name, 'hello.txt')
    assert.equal(meta.json.display_name, 'hello.txt')

    const resolved = await request('/resolve/hello')
    assert.equal(resolved.response.status, 200)
    assert.equal(resolved.json.file_name, 'hello.txt')

    const preview = await request('/file/hello/preview')
    assert.equal(preview.response.status, 302)
    assert.equal(preview.response.headers.get('location'), '/hello/file.txt')

    const tokenRaw = await request('/file/hello/raw')
    assert.equal(tokenRaw.response.status, 200)
    assert.equal(tokenRaw.text, 'hello nest')
    assert.match(tokenRaw.response.headers.get('content-type') ?? '', /^text\/plain/)

    const embed = await request('/file/hello/preview', { headers: { Accept: '*/*', 'X-Preview-Embed': '1' } })
    assert.equal(embed.response.status, 200)
    assert.match(embed.response.headers.get('content-type') ?? '', /^text\/html/)
    assert.equal(embed.response.headers.get('cache-control'), 'no-store')
    assert.match(embed.text, /property="og:title" content="hello\.txt"/)
    assert.doesNotMatch(embed.text, /property="og:image"/)
  })

  test('admin claim, JWT auth, settings, and admin listing work', async () => {
    const initialClaimStatus = await request('/auth/admin/claim/status')
    assert.equal(initialClaimStatus.response.status, 200)
    assert.equal(initialClaimStatus.json.admin_exists, false)

    const init = await request('/auth/admin/claim/init', { method: 'POST', headers: { Authorization: 'Bearer installer-test-bearer', 'Content-Type': 'application/json' }, body: '{}' })
    assert.equal(init.response.status, 200)
    const claim = await request('/auth/admin/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ claim_token: init.json.token, username: 'admin', password: 'secret123' }) })
    assert.equal(claim.response.status, 200)
    const jwt = claim.json.access_token
    adminJwt = jwt
    pasteToken = claim.json.paste_token

    const me = await request('/auth/me', { headers: { Authorization: `Bearer ${jwt}` } })
    assert.equal(me.response.status, 200)
    assert.equal(me.json.is_admin, true)
    assert.equal(me.json.avatar_color, null)
    assert.equal(me.json.avatar_image, null)

    // Avatar is stored server-side per-account so it follows the user across devices.
    const avatarUpdate = await request('/auth/me/avatar', { method: 'PUT', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ color: '#1d4ed8', image: 'data:image/png;base64,iVBORw0KGgo=' }) })
    assert.equal(avatarUpdate.response.status, 200)
    assert.equal(avatarUpdate.json.avatar_color, '#1d4ed8')
    assert.equal(avatarUpdate.json.avatar_image, 'data:image/png;base64,iVBORw0KGgo=')
    const avatarMe = await request('/auth/me', { headers: { Authorization: `Bearer ${jwt}` } })
    assert.equal(avatarMe.json.avatar_color, '#1d4ed8')
    assert.equal(avatarMe.json.avatar_image, 'data:image/png;base64,iVBORw0KGgo=')
    const badAvatar = await request('/auth/me/avatar', { method: 'PUT', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ color: '#zzz', image: 'not-a-data-url' }) })
    assert.equal(badAvatar.response.status, 400)
    // Clearing the image is allowed (falls back to initials).
    const clearAvatar = await request('/auth/me/avatar', { method: 'PUT', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ color: '#1d4ed8', image: null }) })
    assert.equal(clearAvatar.response.status, 200)
    assert.equal(clearAvatar.json.avatar_image, null)
    const owner = await request('/token-owner', { headers: { Authorization: `Basic ${pasteToken}` } })
    assert.equal(owner.response.status, 200)
    assert.equal(owner.json.username, 'admin')

    const settings = await request('/auth/admin/settings', { headers: { Authorization: `Bearer ${jwt}` } })
    assert.equal(settings.response.status, 200)
    assert.equal(settings.json.upload_access_mode, 'public')
    assert.equal(settings.json.passkeys_enabled, 'false')

    const dashboard = await request('/auth/admin/dashboard', { headers: { Authorization: `Bearer ${jwt}` } })
    assert.equal(dashboard.response.status, 200)
    assert.equal(dashboard.json.upload_count, 1)

    const imageForm = new FormData()
    imageForm.append('file', new Blob(['preview image']), 'preview.png')
    const imageUpload = await request('/', { method: 'POST', body: imageForm })
    assert.equal(imageUpload.response.status, 200)
    const imageEmbed = await request('/file/preview/preview', { headers: { Accept: '*/*', 'X-Preview-Embed': '1' } })
    assert.equal(imageEmbed.response.status, 200)
    assert.match(imageEmbed.text, /property="og:image" content="http:\/\/localhost:8080\/api\/preview\.png\?raw=1"/)
    assert.match(imageEmbed.text, /property="og:image:secure_url" content="http:\/\/localhost:8080\/api\/preview\.png\?raw=1"/)
    assert.match(imageEmbed.text, /property="og:image:type" content="image\/png"/)
    assert.match(imageEmbed.text, /name="twitter:card" content="summary_large_image"/)
    const imageRaw = await request('/preview/file.png?raw=1')
    assert.equal(imageRaw.response.status, 200)
    assert.match(imageRaw.response.headers.get('content-type') ?? '', /^image\/png/)

    const gifForm = new FormData()
    gifForm.append('file', new Blob(['GIF89a']), 'animated.gif')
    const gifUpload = await request('/', { method: 'POST', body: gifForm })
    assert.equal(gifUpload.response.status, 200)
    const gifEmbed = await request('/file/animated/preview', { headers: { Accept: '*/*', 'X-Preview-Embed': '1' } })
    assert.equal(gifEmbed.response.status, 200)
    assert.match(gifEmbed.text, /property="og:image:type" content="image\/gif"/)
    assert.match(gifEmbed.text, /property="og:image" content="http:\/\/localhost:8080\/api\/animated\.gif\?raw=1"/)

    const videoForm = new FormData()
    videoForm.append('file', new Blob(['video payload']), 'clip.mp4')
    const videoUpload = await request('/', { method: 'POST', body: videoForm })
    assert.equal(videoUpload.response.status, 200)
    const videoEmbed = await request('/file/clip/preview', { headers: { Accept: '*/*', 'X-Preview-Embed': '1' } })
    assert.equal(videoEmbed.response.status, 200)
    assert.match(videoEmbed.text, /property="og:type" content="video\.other"/)
    assert.match(videoEmbed.text, /property="og:video" content="http:\/\/localhost:8080\/api\/clip\.mp4\?raw=1"/)
    assert.match(videoEmbed.text, /property="og:video:type" content="video\/mp4"/)
    assert.doesNotMatch(videoEmbed.text, /property="og:image"/)
    const videoRaw = await request('/clip/file.mp4?raw=1')
    assert.equal(videoRaw.response.status, 200)
    assert.match(videoRaw.response.headers.get('content-type') ?? '', /^video\/mp4/)
    // Media browsers (iOS Safari, Firefox) need HTTP Range support to play/seek.
    const range = await request('/clip/file.mp4?raw=1', { headers: { Range: 'bytes=0-4' } })
    assert.equal(range.response.status, 206)
    assert.equal(range.response.headers.get('accept-ranges'), 'bytes')
    assert.equal(range.response.headers.get('content-range'), 'bytes 0-4/13')
    assert.equal(range.text, 'video')
    const suffix = await request('/clip/file.mp4?raw=1', { headers: { Range: 'bytes=-3' } })
    assert.equal(suffix.response.status, 206)
    assert.equal(suffix.response.headers.get('content-range'), 'bytes 10-12/13')
    const badRange = await request('/clip/file.mp4?raw=1', { headers: { Range: 'bytes=100-' } })
    assert.equal(badRange.response.status, 416)

    const expiringForm = new FormData()
    expiringForm.append('meta', JSON.stringify({ keepFileName: true, originalName: 'expiring-original.txt', uploader: 'admin', source: 'WebUI' }))
    expiringForm.append('file', new Blob(['expiring metadata']), 'expiring-original.txt')
    const expiringUpload = await request('/', { method: 'POST', headers: { Authorization: pasteToken, Expire: '1d' }, body: expiringForm })
    assert.equal(expiringUpload.response.status, 200)
    const expiringMeta = await request('/meta/expiring-original.txt')
    assert.equal(expiringMeta.response.status, 200)
    assert.equal(expiringMeta.json.display_name, 'expiring-original.txt')

    const oneSecondForm = new FormData()
    oneSecondForm.append('file', new Blob(['one second']), 'one-second-expiry.txt')
    const oneSecondUpload = await request('/', { method: 'POST', headers: { Authorization: pasteToken, Expire: '1s' }, body: oneSecondForm })
    assert.equal(oneSecondUpload.response.status, 200)
    assert.equal((await request('/one-second-expiry.txt?raw=1')).response.status, 200)
    await new Promise(resolve => setTimeout(resolve, 1_100))
    assert.equal((await request('/one-second-expiry.txt?raw=1')).response.status, 404)

    const passwordOnlyForm = new FormData()
    passwordOnlyForm.append('meta', JSON.stringify({ passwordSalt: '0123456789abcdefghijkl' }))
    passwordOnlyForm.append('file', new Blob(['password-only metadata']), 'password-only.txt')
    const passwordOnlyUpload = await request('/', { method: 'POST', headers: { Authorization: pasteToken }, body: passwordOnlyForm })
    assert.equal(passwordOnlyUpload.response.status, 200)
    const adminUploads = await request('/auth/admin/uploads', { headers: { Authorization: `Bearer ${adminJwt}` } })
    const passwordOnlyRow = adminUploads.json.find((row: any) => row.password_salt === '0123456789abcdefghijkl')
    assert.ok(passwordOnlyRow, JSON.stringify(adminUploads.json))

    const duplicateClaim = await request('/auth/admin/claim/init', { method: 'POST', headers: { Authorization: 'Bearer installer-test-bearer', 'Content-Type': 'application/json' }, body: '{}' })
    assert.equal(duplicateClaim.response.status, 409)
    const resetAfterAdmin = await request('/auth/admin/claim/init', { method: 'POST', headers: { Authorization: 'Bearer installer-test-bearer', 'Content-Type': 'application/json' }, body: JSON.stringify({ reset: true }) })
    assert.equal(resetAfterAdmin.response.status, 409)
    assert.match(resetAfterAdmin.text, /administrator already exists/)
    const claimStatus = await request('/auth/admin/claim/status')
    assert.equal(claimStatus.response.status, 200)
    assert.equal(claimStatus.json.admin_exists, true)
    assert.equal(claimStatus.json.claim_available, false)
  })

  test('covers token lifecycle, account operations, and one-shot semantics', async () => {
    const used = await request('/auth/token/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: pasteToken }) })
    assert.equal(used.json.status, 'used')

    const created = await request('/auth/admin/tokens', { method: 'POST', headers: { Authorization: 'Bearer installer-test-bearer', 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'integration-user' }) })
    assert.equal(created.response.status, 200, created.text)
    const registrationToken = created.json.token
    const available = await request('/auth/token/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: registrationToken }) })
    assert.equal(available.json.status, 'available')
    const registered = await request('/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'secret123', token: registrationToken }) })
    assert.equal(registered.response.status, 200)
    const revokedRegistration = await request(`/auth/admin/tokens/${encodeURIComponent(registrationToken)}`, { method: 'DELETE', headers: { Authorization: 'Bearer installer-test-bearer' } })
    assert.equal(revokedRegistration.response.status, 200)
    const usedAfterRevoke = await request('/auth/token/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: registrationToken }) })
    assert.equal(usedAfterRevoke.json.status, 'used')
    const expiringRegistration = await request('/auth/admin/registration-tokens', { method: 'POST', headers: { Authorization: `Bearer ${adminJwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'one-second-registration', ttl_seconds: 1 }) })
    assert.equal(expiringRegistration.response.status, 200, expiringRegistration.text)
    assert.equal(expiringRegistration.json.label, 'one-second-registration')
    const expiringToken = expiringRegistration.json.token
    assert.equal((await request('/auth/token/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: expiringToken }) })).json.status, 'available')
    const listedRegistrationTokens = await request('/auth/admin/registration-tokens', { headers: { Authorization: `Bearer ${adminJwt}` } })
    assert.equal(listedRegistrationTokens.response.status, 200, listedRegistrationTokens.text)
    const listedExpiringToken = listedRegistrationTokens.json.find((row: any) => row.label === 'one-second-registration')
    assert.match(listedExpiringToken.token_ref, /^[a-f0-9]{64}$/)
    assert.equal('token' in listedExpiringToken, false)
    assert.equal(listedExpiringToken.status, 'available')
    const revocableRegistration = await request('/auth/admin/registration-tokens', { method: 'POST', headers: { Authorization: `Bearer ${adminJwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'revocable-registration', ttl_seconds: 3600 }) })
    assert.equal(revocableRegistration.response.status, 200, revocableRegistration.text)
    const refreshedRegistrationTokens = await request('/auth/admin/registration-tokens', { headers: { Authorization: `Bearer ${adminJwt}` } })
    const revocableRow = refreshedRegistrationTokens.json.find((row: any) => row.label === 'revocable-registration')
    const revokeRegistration = await request(`/auth/admin/registration-tokens/${revocableRow.token_ref}`, { method: 'DELETE', headers: { Authorization: `Bearer ${adminJwt}` } })
    assert.equal(revokeRegistration.response.status, 200, revokeRegistration.text)
    assert.equal((await request('/auth/token/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: revocableRegistration.json.token }) })).json.status, 'invalid')
    await new Promise(resolve => setTimeout(resolve, 1_100))
    assert.equal((await request('/auth/token/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: expiringToken }) })).json.status, 'invalid')
    const clearedHistory = await request('/auth/admin/registration-tokens/history', { method: 'DELETE', headers: { Authorization: `Bearer ${adminJwt}` } })
    assert.equal(clearedHistory.response.status, 200, clearedHistory.text)
    assert.ok(clearedHistory.json.removed >= 3)
    const afterClear = await request('/auth/admin/registration-tokens', { headers: { Authorization: `Bearer ${adminJwt}` } })
    assert.equal(afterClear.json.some((row: any) => ['integration-user', 'one-second-registration', 'revocable-registration'].includes(row.label)), false)
    const aliceLogin = await request('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'secret123' }) })
    assert.equal(aliceLogin.response.status, 200)
    const aliceJwt = aliceLogin.json.access_token
    const sharex = await request('/auth/sharex', { headers: { Authorization: `Bearer ${aliceJwt}` } })
    assert.equal(sharex.response.status, 200)
    assert.match(sharex.response.headers.get('content-disposition') ?? '', /yaemipaste\.sxcu/)
    assert.equal(sharex.json.RequestURL, 'https://upload.example/api/')

    const passkeys = await request('/auth/passkeys', { headers: { Authorization: `Bearer ${aliceJwt}` } })
    assert.equal(passkeys.response.status, 200)
    assert.deepEqual(passkeys.json, [])
    const beginPasskey = await request('/auth/passkeys/register/begin', { method: 'POST', headers: { Authorization: `Bearer ${aliceJwt}` } })
    assert.equal(beginPasskey.response.status, 400)
    const enabledSettings = await request('/auth/admin/settings', { method: 'PUT', headers: { Authorization: 'Bearer ' + adminJwt, 'Content-Type': 'application/json' }, body: JSON.stringify({ passkeys_enabled: true }) })
    assert.equal(enabledSettings.response.status, 200)
    assert.equal(enabledSettings.json.passkeys_enabled, 'true')
    const enabledPublicSettings = await request('/auth/admin/public-settings')
    assert.equal(enabledPublicSettings.json.passkeys_enabled, true)
    const enabledBeginPasskey = await request('/auth/passkeys/register/begin', { method: 'POST', headers: { Authorization: 'Bearer ' + aliceJwt } })
    assert.equal(enabledBeginPasskey.response.status, 200)
    assert.equal(typeof enabledBeginPasskey.json.challenge, 'string')
    // The user handle must be a valid 16-byte WebAuthn user ID (required by
    // iOS/Safari and hardware security keys such as YubiKey).
    const userIdDecoded = atob(enabledBeginPasskey.json.user.id.replace(/-/g, '+').replace(/_/g, '/'))
    assert.equal(userIdDecoded.length, 16)
    // Renaming a passkey the user does not own must 404.
    const renameMissing = await request('/auth/passkeys/99999', { method: 'PATCH', headers: { Authorization: 'Bearer ' + aliceJwt, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'My YubiKey' }) })
    assert.equal(renameMissing.response.status, 404)
    const disabledSettings = await request('/auth/admin/settings', { method: 'PUT', headers: { Authorization: 'Bearer ' + adminJwt, 'Content-Type': 'application/json' }, body: JSON.stringify({ passkeys_enabled: false }) })
    assert.equal(disabledSettings.response.status, 200)
    const disabledPasskeys = await request('/auth/passkeys', { headers: { Authorization: 'Bearer ' + aliceJwt } })
    assert.equal(disabledPasskeys.response.status, 200)
    assert.deepEqual(disabledPasskeys.json, [])
    const disabledBeginPasskey = await request('/auth/passkeys/register/begin', { method: 'POST', headers: { Authorization: 'Bearer ' + aliceJwt } })
    assert.equal(disabledBeginPasskey.response.status, 400)
    const disabledDeletePasskey = await request('/auth/passkeys/1', { method: 'DELETE', headers: { Authorization: 'Bearer ' + aliceJwt } })
    assert.equal(disabledDeletePasskey.response.status, 404)
    const reenabledSettings = await request('/auth/admin/settings', { method: 'PUT', headers: { Authorization: 'Bearer ' + adminJwt, 'Content-Type': 'application/json' }, body: JSON.stringify({ passkeys_enabled: true }) })
    assert.equal(reenabledSettings.response.status, 200)
    const staleRegistration = await request('/auth/passkeys/register/finish', { method: 'POST', headers: { Authorization: 'Bearer ' + aliceJwt, 'Content-Type': 'application/json' }, body: JSON.stringify({ credential: { id: 'stale-credential' } }) })
    assert.equal(staleRegistration.response.status, 400)
    assert.equal(staleRegistration.json.detail, 'No passkey registration is pending')

    const aliceForm = new FormData(); aliceForm.append('file', new Blob(['alice file']), 'alice.txt')
    const aliceUpload = await request('/', { method: 'POST', headers: { Authorization: aliceLogin.json.paste_token }, body: aliceForm })
    assert.equal(aliceUpload.response.status, 200)

    const suspended = await request('/auth/admin/users/alice', { method: 'PATCH', headers: { Authorization: `Bearer ${adminJwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ suspended: true, suspension_reason: 'test' }) })
    assert.equal(suspended.response.status, 200)
    const suspendedLogin = await request('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'secret123' }) })
    assert.equal(suspendedLogin.response.status, 403)
    const unsuspended = await request('/auth/admin/users/alice', { method: 'PATCH', headers: { Authorization: `Bearer ${adminJwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ suspended: false }) })
    assert.equal(unsuspended.response.status, 200)

    const changed = await request('/auth/password/change', { method: 'POST', headers: { Authorization: `Bearer ${aliceJwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ old_password: 'secret123', new_password: 'newsecret123' }) })
    assert.equal(changed.response.status, 200)
    const revokedSession = await request('/auth/me', { headers: { Authorization: `Bearer ${aliceJwt}` } })
    assert.equal(revokedSession.response.status, 401)
    const newLogin = await request('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'newsecret123' }) })
    assert.equal(newLogin.response.status, 200)
    const loggedOut = await request('/auth/logout-all-devices', { method: 'POST', headers: { Authorization: `Bearer ${newLogin.json.access_token}` } })
    assert.equal(loggedOut.response.status, 200)
    const loggedOutSession = await request('/auth/me', { headers: { Authorization: `Bearer ${newLogin.json.access_token}` } })
    assert.equal(loggedOutSession.response.status, 401)

    const urlForm = new FormData(); urlForm.append('url', 'https://example.com/resource')
    const urlUpload = await request('/', { method: 'POST', headers: { Authorization: pasteToken }, body: urlForm })
    assert.equal(urlUpload.response.status, 200)
    const urlRedirect = await request('/url', { headers: { Authorization: pasteToken } })
    assert.equal(urlRedirect.response.status, 302)
    assert.equal(urlRedirect.response.headers.get('location'), 'https://example.com/resource')

    const oneShotForm = new FormData(); oneShotForm.append('oneshot', new Blob(['one shot']), 'one-shot.txt')
    const oneShotUpload = await request('/', { method: 'POST', headers: { Authorization: pasteToken }, body: oneShotForm })
    assert.equal(oneShotUpload.response.status, 200)
    const firstRead = await request('/one-shot.txt?raw=1', { headers: { Authorization: pasteToken } })
    assert.equal(firstRead.response.status, 200)
    assert.equal(firstRead.text, 'one shot')
    const secondRead = await request('/one-shot.txt?raw=1', { headers: { Authorization: pasteToken } })
    assert.equal(secondRead.response.status, 404)

    const privateForm = new FormData(); privateForm.append('file', new Blob(['delete me']), 'delete-me.txt')
    const privateUpload = await request('/', { method: 'POST', headers: { Authorization: pasteToken }, body: privateForm })
    assert.equal(privateUpload.response.status, 200)
    const privatePath = new URL(privateUpload.text.trim(), base).pathname
    assert.match(privatePath, /\/delete-me\/file\.txt$/)
    const deleted = await request(privatePath, { method: 'DELETE', headers: { Authorization: pasteToken } })
    assert.equal(deleted.response.status, 200)
    const missing = await request(`${privatePath}?raw=1`)
    assert.equal(missing.response.status, 404)
  })

  test('protects admin surfaces and keeps secrets out of settings responses', async () => {
    const unauthorized = await request('/auth/admin/dashboard')
    assert.equal(unauthorized.response.status, 401)
    assert.equal((await request('/version')).response.status, 401)
    assert.equal((await request('/list')).response.status, 401)
    const malformed = await request('/auth/me', { headers: { Authorization: 'Bearer malformed.jwt' } })
    assert.equal(malformed.response.status, 401)

    const secret = await request('/auth/admin/settings', { method: 'PUT', headers: { Authorization: `Bearer ${adminJwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ turnstile_secret_key: 'super-secret', turnstile_enabled: false }) })
    assert.equal(secret.response.status, 200)
    assert.equal(secret.json.turnstile_secret_key, undefined)
    assert.equal(secret.json.turnstile_secret_configured, 'true')

    const invalidWebhook = await request('/auth/admin/webhooks', { method: 'POST', headers: { Authorization: `Bearer ${adminJwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'http://127.0.0.1:8080/hook', events: ['file.uploaded'] }) })
    assert.equal(invalidWebhook.response.status, 400)
    const webhook = await request('/auth/admin/webhooks', { method: 'POST', headers: { Authorization: `Bearer ${adminJwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://example.com/hook', events: ['file.uploaded'], secret: 'hook-secret', enabled: false }) })
    assert.equal(webhook.response.status, 200)
    const webhookId = webhook.json.id
    const webhookList = await request('/auth/admin/webhooks', { headers: { Authorization: `Bearer ${adminJwt}` } })
    assert.equal(webhookList.response.status, 200)
    assert.equal(webhookList.json.find((item: any) => item.id === webhookId).secret_configured, true)
    const webhookTest = await request(`/auth/admin/webhooks/${webhookId}/test`, { method: 'POST', headers: { Authorization: `Bearer ${adminJwt}` } })
    assert.equal(webhookTest.response.status, 200)
    const webhookUpdate = await request(`/auth/admin/webhooks/${webhookId}`, { method: 'PATCH', headers: { Authorization: `Bearer ${adminJwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ events: ['admin.settings.updated'], enabled: false }) })
    assert.equal(webhookUpdate.response.status, 200)
    const deliveries = await request('/auth/admin/webhooks/deliveries', { headers: { Authorization: `Bearer ${adminJwt}` } })
    assert.equal(deliveries.response.status, 200)
    const webhookDelete = await request(`/auth/admin/webhooks/${webhookId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${adminJwt}` } })
    assert.equal(webhookDelete.response.status, 200)

    const traversal = await request('/auth/admin/uploads/content?path=../users.db', { headers: { Authorization: `Bearer ${adminJwt}` } })
    assert.ok([400, 404].includes(traversal.response.status))

    const created = await request('/auth/admin/users', { method: 'POST', headers: { Authorization: `Bearer ${adminJwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'bob', password: 'secret123' }) })
    assert.equal(created.response.status, 200)
    const rotated = await request('/auth/admin/users/bob/token', { method: 'POST', headers: { Authorization: `Bearer ${adminJwt}`, 'Content-Type': 'application/json' }, body: '{}' })
    assert.equal(rotated.response.status, 200)
    const bobForm = new FormData(); bobForm.append('file', new Blob(['admin flow']), 'admin-flow.txt')
    const bobUpload = await request('/', { method: 'POST', headers: { Authorization: rotated.json.upload_token }, body: bobForm })
    assert.equal(bobUpload.response.status, 200)
    const users = await request('/auth/admin/users', { headers: { Authorization: `Bearer ${adminJwt}` } })
    assert.equal(users.response.status, 200)
    const bobUploads = await request('/auth/admin/users/bob/uploads', { headers: { Authorization: `Bearer ${adminJwt}` } })
    assert.equal(bobUploads.response.status, 200)
    assert.equal(bobUploads.json.length, 1)
    const uploadRows = await request('/auth/admin/uploads', { headers: { Authorization: `Bearer ${adminJwt}` } })
    assert.equal(uploadRows.response.status, 200)
    const bobPath = bobUploads.json[0].path
    const uploadContent = await request(`/auth/admin/uploads/content?path=${encodeURIComponent(bobPath)}`, { headers: { Authorization: `Bearer ${adminJwt}` } })
    assert.equal(uploadContent.response.status, 200)
    assert.equal(uploadContent.text, 'admin flow')
    const deletedUpload = await request(`/auth/admin/uploads?path=${encodeURIComponent(bobPath)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${adminJwt}` } })
    assert.equal(deletedUpload.response.status, 200)
    const bulk = await request('/auth/admin/uploads/bulk-delete', { method: 'POST', headers: { Authorization: `Bearer ${adminJwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmation: 'PURGE UPLOADS', paths: ['does-not-exist.txt'] }) })
    assert.equal(bulk.response.status, 200)
    const purged = await request('/auth/admin/users/bob/purge', { method: 'POST', headers: { Authorization: `Bearer ${adminJwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmation: 'PURGE UPLOADS' }) })
    assert.equal(purged.response.status, 200)
    const expired = await request('/auth/admin/uploads/purge-expired', { method: 'POST', headers: { Authorization: `Bearer ${adminJwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmation: 'PURGE EXPIRED' }) })
    assert.equal(expired.response.status, 200)
    const deletedUser = await request('/auth/admin/users/bob', { method: 'DELETE', headers: { Authorization: `Bearer ${adminJwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmation: 'DELETE USER' }) })
    assert.equal(deletedUser.response.status, 200)
    const audit = await request('/auth/admin/audit', { headers: { Authorization: `Bearer ${adminJwt}` } })
    assert.equal(audit.response.status, 200)
  })
  test('persists and validates branding accent/logo settings', async () => {
    const bearer = 'Bearer ' + adminJwt
    const jwtHeader = { Authorization: bearer, 'Content-Type': 'application/json' }
    const tiny = 'data:image/png;base64,' + Buffer.from('logo-bytes').toString('base64')

    const saved = await request('/auth/admin/settings', { method: 'PUT', headers: jwtHeader, body: JSON.stringify({ accent_color: '#4ade80', logo_type: 'preset', logo_preset: 'zap', branding_logo: tiny }) })
    assert.equal(saved.response.status, 200)
    assert.equal(saved.json.accent_color, '#4ade80')
    assert.equal(saved.json.logo_type, 'preset')
    assert.equal(saved.json.logo_preset, 'zap')
    assert.equal(saved.json.branding_logo, tiny)

    const pub = await request('/auth/admin/public-settings')
    assert.equal(pub.response.status, 200)
    assert.equal(pub.json.accent_color, '#4ade80')
    assert.equal(pub.json.logo_type, 'preset')
    assert.equal(pub.json.logo_preset, 'zap')
    assert.equal(pub.json.branding_logo, tiny)
    // The resolved branding must be exposed as headers for server-side SPA injection.
    assert.equal(pub.response.headers.get('x-branding-title'), 'yaemipaste')
    assert.equal(pub.response.headers.get('x-branding-accent'), '#4ade80')

    // The globally-configured accent color should drive the embed's theme-color tag
    // so services like Discord color the embed bar to match the site branding.
    const accentForm = new FormData()
    accentForm.append('file', new Blob(['accent color image']), 'accent.png')
    const accentUpload = await request('/', { method: 'POST', body: accentForm })
    assert.equal(accentUpload.response.status, 200)
    const accentEmbed = await request('/file/accent/preview', { headers: { Accept: '*/*', 'X-Preview-Embed': '1' } })
    assert.equal(accentEmbed.response.status, 200)
    assert.match(accentEmbed.text, /name="theme-color" content="#4ade80"/)

    const badAccent = await request('/auth/admin/settings', { method: 'PUT', headers: jwtHeader, body: JSON.stringify({ accent_color: 'not-a-color' }) })
    assert.equal(badAccent.response.status, 400)
    const badType = await request('/auth/admin/settings', { method: 'PUT', headers: jwtHeader, body: JSON.stringify({ logo_type: 'nonsense' }) })
    assert.equal(badType.response.status, 400)
    const badPreset = await request('/auth/admin/settings', { method: 'PUT', headers: jwtHeader, body: JSON.stringify({ logo_preset: 'UPPER bad!' }) })
    assert.equal(badPreset.response.status, 400)
    const nonImage = await request('/auth/admin/settings', { method: 'PUT', headers: jwtHeader, body: JSON.stringify({ branding_logo: 'data:text/plain;base64,' + Buffer.from('x').toString('base64') }) })
    assert.equal(nonImage.response.status, 400)
    const tooBig = await request('/auth/admin/settings', { method: 'PUT', headers: jwtHeader, body: JSON.stringify({ branding_logo: 'data:image/png;base64,' + 'A'.repeat(1_500_001) }) })
    assert.equal(tooBig.response.status, 400)

    const reset = await request('/auth/admin/settings', { method: 'PUT', headers: jwtHeader, body: JSON.stringify({ accent_color: '', logo_type: '', logo_preset: '', branding_logo: '' }) })
    assert.equal(reset.response.status, 200)
  })
  test('pins are stored and read back per user', async () => {
    const auth = { Authorization: pasteToken }
    const initial = await request('/pins', { headers: auth })
    assert.equal(initial.response.status, 200)
    assert.deepEqual(initial.json.pins, [])
    const saved = await request('/pins', { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ pins: ['hello.txt', 'clip.mp4'] }) })
    assert.equal(saved.response.status, 200)
    assert.deepEqual(saved.json.pins, ['hello.txt', 'clip.mp4'])
    const read = await request('/pins', { headers: auth })
    assert.deepEqual(read.json.pins, ['hello.txt', 'clip.mp4'])
    const cleared = await request('/pins', { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ pins: [] }) })
    assert.deepEqual(cleared.json.pins, [])
    const unauth = await request('/pins')
    assert.equal(unauth.response.status, 401)
  })
})

describe('outbound address policy', { concurrency: false }, () => {
  test('permits only globally routable unicast addresses', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(blockedAddress(address), false, address)
    for (const address of [
      '0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.1.1', '172.16.0.1', '192.0.0.1',
      '192.0.2.1', '192.168.1.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '240.0.0.1',
      '::', '::1', '::ffff:192.168.1.1', 'fc00::1', 'fe80::1', 'ff02::1', '2001::1', '2001:db8::1', '2001:2::1', '2002::1', '3fff::1',
    ]) assert.equal(blockedAddress(address), true, address)
  })
})

describe('NestJS API security boundaries', { concurrency: false }, () => {
  test('rejects chunked multipart bodies beyond the configured maximum', async () => {
    const originalMaximum = config.value.maxContentLength
    config.value.maxContentLength = 192
    try {
      const upload = chunkedMultipartUpload('chunked-limit')
      upload.write('x'.repeat(256))
      upload.end()
      const rejected = await upload.response
      assert.equal(rejected.status, 413)
      assert.deepEqual(JSON.parse(rejected.body), { code: 'payload_too_large', detail: 'payload too large' })
    } finally {
      config.value.maxContentLength = originalMaximum
    }
  })

  test('limits concurrent chunked uploads per client and releases their leases', async () => {
    const clientHeaders = { 'X-Forwarded-For': '198.51.100.25' }
    const heldRequestIds = new Set(Array.from({ length: 4 }, (_, index) => `held-${index}`))
    const server = app.getHttpServer()
    let resolveHeldRequests: () => void
    const heldRequestsReceived = new Promise<void>(resolve => { resolveHeldRequests = resolve })
    const observeHeldRequest = (incoming: import('node:http').IncomingMessage) => {
      const requestId = incoming.headers['x-test-held-upload']
      if (typeof requestId !== 'string' || !heldRequestIds.delete(requestId)) return
      if (!heldRequestIds.size) {
        server.off('request', observeHeldRequest)
        resolveHeldRequests!()
      }
    }
    server.prependListener('request', observeHeldRequest)
    const held = Array.from({ length: 4 }, (_, index) => {
      const requestId = `held-${index}`
      return chunkedMultipartUpload(requestId, { ...clientHeaders, 'X-Test-Held-Upload': requestId })
    })
    try {
      // Express processes its request listener synchronously after this observer,
      // so this confirms all four leases have been acquired before probing.
      await heldRequestsReceived
      const form = new FormData()
      form.append('file', new Blob(['probe']), 'probe.txt')
      const rejected = await request('/', { method: 'POST', headers: clientHeaders, body: form })
      assert.equal(rejected.response.status, 429)
      assert.deepEqual(rejected.json, { code: 'rate_limited', detail: 'too many concurrent uploads' })
    } finally {
      server.off('request', observeHeldRequest)
      held.forEach(upload => {
        upload.write('held upload')
        upload.end()
      })
    }

    for (const upload of held) assert.equal((await upload.response).status, 200)
    const form = new FormData()
    form.append('file', new Blob(['released']), 'released.txt')
    const released = await request('/', { method: 'POST', headers: clientHeaders, body: form })
    assert.equal(released.response.status, 200)
  })

  test('rejects unauthorized upload after access is switched to private', async () => {
    const jwt = adminJwt
    const updated = await request('/auth/admin/settings', { method: 'PUT', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ upload_access_mode: 'private' }) })
    assert.equal(updated.response.status, 200)
    const form = new FormData(); form.append('file', new Blob(['nope']), 'private.txt')
    const upload = await request('/', { method: 'POST', body: form })
    assert.equal(upload.response.status, 401)
  })

  test('blocks traversal and private remote-upload targets', async () => {
    const traversal = await request('/%2e%2e%2fetc%2fpasswd?raw=1')
    assert.ok([400, 404].includes(traversal.response.status))
    const publicSettings = await request('/auth/admin/settings', { method: 'PUT', headers: { Authorization: `Bearer ${adminJwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ upload_access_mode: 'public' }) })
    assert.equal(publicSettings.response.status, 200)
    const form = new FormData(); form.append('remote', 'http://127.0.0.1:9/private.txt')
    const remote = await request('/', { method: 'POST', headers: { Authorization: pasteToken }, body: form })
    assert.equal(remote.response.status, 403)
  })

  test('does not reflect an unapproved CORS origin', async () => {
    const response = await request('/auth/admin/public-settings', { headers: { Origin: 'https://evil.example' } })
    assert.equal(response.response.headers.get('access-control-allow-origin'), null)
  })
})

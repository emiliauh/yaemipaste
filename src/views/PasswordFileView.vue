<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useRoute } from 'vue-router'
import { decodeFileToken, formatBytes, publicApiFileUrl, publicFileUrl, publicSiteOrigin, resolveFileName } from '../lib/api'
import { decryptBlobWithPassword, isRustypasteEncryptedBlob, rememberEncryptedFile, type EncryptedMetadata } from '../lib/e2ee'

const route = useRoute()

const filekey = computed(() => String(route.params.filekey ?? ''))
const fileName = computed(() => {
  try { return decodeFileToken(filekey.value.split('+')[0]) } catch { return '' }
})
const salt = computed(() => {
  const keyPart = filekey.value.split('+').slice(1).join('+')
  return keyPart.startsWith('pw:') ? keyPart.slice(3) : ''
})

const password = ref('')
const decrypting = ref(false)
const decryptStatus = ref('')
const error = ref('')
const objectUrl = ref('')
const textPreview = ref('')
const metadata = ref<EncryptedMetadata | null>(null)
const decrypted = ref(false)
const resolvedFileName = ref('')

const isImage = computed(() => metadata.value?.type.startsWith('image/') ?? false)
const isVideo = computed(() => metadata.value?.type.startsWith('video/') ?? false)
const isText = computed(() => metadata.value?.type.startsWith('text/') ?? false)

function clearObjectUrl() {
  if (objectUrl.value) URL.revokeObjectURL(objectUrl.value)
  objectUrl.value = ''
}

async function downloadPayload(): Promise<Blob> {
  const publicUrl = publicFileUrl(resolvedFileName.value)
  const apiUrl = publicApiFileUrl(resolvedFileName.value)
  const attempts = [publicUrl, `${apiUrl}?raw=1`, `${apiUrl}?download=true`, apiUrl]
  const timeoutMs = 12_000
  let sawNotFound = false

  for (const url of attempts) {
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    try {
      response = await fetch(url, { cache: 'no-store', signal: controller.signal })
    } catch (fetchError) {
      window.clearTimeout(timeout)
      if (fetchError instanceof DOMException && fetchError.name === 'AbortError') continue
      throw fetchError
    }
    window.clearTimeout(timeout)

    if (!response.ok) {
      if (response.status === 404) sawNotFound = true
      continue
    }

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
    if (contentType.includes('text/html') || contentType.includes('application/json')) continue

    const payload = await response.blob()
    if (await isRustypasteEncryptedBlob(payload)) return payload
  }
  if (sawNotFound) throw new Error('File not found or expired')
  throw new Error('Could not load encrypted payload. Please try again.')
}

async function decrypt() {
  if (!password.value.trim()) {
    error.value = 'Password is required'
    return
  }
  if (!salt.value) {
    error.value = 'Invalid link: missing password salt'
    return
  }
  error.value = ''
  decrypting.value = true
  decryptStatus.value = 'Downloading encrypted payload…'
  try {
    resolvedFileName.value = await resolveFileName(fileName.value)
    const payload = await downloadPayload()
    decryptStatus.value = 'Deriving decryption key…'
    await new Promise((resolve) => window.setTimeout(resolve, 0))
    decryptStatus.value = 'Decrypting file…'
    const result = await decryptBlobWithPassword(payload, password.value, salt.value)
    clearObjectUrl()
    metadata.value = result.metadata
    rememberEncryptedFile(resolvedFileName.value, `pw:${salt.value}`, result.metadata, publicSiteOrigin())
    objectUrl.value = URL.createObjectURL(result.blob)
    if (result.metadata.type.startsWith('text/')) {
      textPreview.value = await result.blob.text()
    }
    decrypted.value = true
  } catch (e: any) {
    error.value = e.message ?? 'Decryption failed'
  } finally {
    decrypting.value = false
    decryptStatus.value = ''
  }
}

onBeforeUnmount(clearObjectUrl)
</script>

<template>
  <main class="pw-page">
    <section class="pw-panel">
      <div class="pw-topline">
        <div class="seal-mark">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
          </svg>
        </div>
        <div>
          <div class="eyebrow">Password-protected file</div>
          <div class="subline">Enter the password to decrypt and view this file.</div>
        </div>
      </div>

      <template v-if="!decrypted">
        <form class="pw-form" @submit.prevent="decrypt">
          <div class="field">
            <label for="pw-password-input">Password</label>
            <input
              id="pw-password-input"
              v-model="password"
              type="password"
              autocomplete="current-password"
              placeholder="Enter password…"
              autofocus
              :disabled="decrypting"
            />
          </div>
          <div v-if="error" class="error-msg">{{ error }}</div>
          <div v-else-if="decrypting && decryptStatus" class="status-msg">{{ decryptStatus }}</div>
          <button type="submit" class="btn-primary" :disabled="decrypting || !password.trim()">
            {{ decrypting ? 'Decrypting…' : 'Decrypt' }}
          </button>
        </form>
      </template>

      <template v-else-if="metadata && objectUrl">
        <div class="details-grid">
          <div>
            <span>File name</span>
            <strong>{{ metadata.name }}</strong>
          </div>
          <div>
            <span>File size</span>
            <strong>{{ formatBytes(metadata.size) }}</strong>
          </div>
          <div>
            <span>Type</span>
            <strong>{{ metadata.type }}</strong>
          </div>
          <div>
            <span>Uploader</span>
            <strong>{{ metadata.uploader || 'Unknown' }}</strong>
          </div>
        </div>

        <div v-if="isImage" class="preview-frame">
          <img :src="objectUrl" :alt="metadata.name" />
        </div>
        <div v-else-if="isVideo" class="preview-frame">
          <video :src="objectUrl" controls />
        </div>
        <pre v-else-if="isText" class="text-preview">{{ textPreview }}</pre>
        <p v-else class="state">Ready to download.</p>

        <div class="actions">
          <a class="btn-link btn-primary" :href="objectUrl" :download="metadata.name">Download file</a>
          <a class="btn-link btn-ghost" :href="objectUrl" target="_blank" rel="noopener">Open</a>
        </div>
      </template>
    </section>
  </main>
</template>

<style scoped>
.pw-page {
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
}
.pw-panel {
  position: relative;
  width: min(640px, 100%);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg1);
  padding: var(--space-5);
  animation: panel-in var(--duration-base) var(--ease-out) both;
}
.pw-topline {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: var(--space-5);
}
.seal-mark {
  width: 34px;
  height: 34px;
  border: 1px solid var(--border2);
  border-radius: var(--radius-sm);
  background: var(--bg2);
  color: var(--accent);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.eyebrow {
  color: var(--accent);
  font-size: var(--fs-sm);
}
.subline {
  color: var(--text2);
  font-size: var(--fs-xs);
  line-height: var(--lh-body);
}
.pw-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.field label {
  color: var(--text);
  font-size: var(--fs-sm);
}
.field input {
  width: 100%;
  min-height: 40px;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
}
.error-msg {
  color: var(--red-h);
  font-size: var(--fs-sm);
}
.status-msg {
  color: var(--text2);
  font-size: var(--fs-sm);
}
.pw-form .btn-primary {
  border-radius: var(--radius-sm);
  min-height: 40px;
  transition: transform var(--duration-fast) var(--ease-out),
    background var(--duration-fast) var(--ease-out),
    border-color var(--duration-fast) var(--ease-out);
}
.pw-form .btn-primary:hover:not(:disabled) { transform: translateY(-1px); }
.pw-form .btn-primary:active:not(:disabled) { transform: translateY(0) scale(0.97); }
.details-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}
.details-grid div {
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg);
  padding: var(--space-2) var(--space-3);
}
.details-grid span {
  display: block;
  color: var(--text2);
  font-size: var(--fs-xs);
  text-transform: uppercase;
  margin-bottom: var(--space-1);
}
.details-grid strong {
  color: var(--text);
  font-size: var(--fs-sm);
  font-weight: 400;
  line-height: var(--lh-body);
  overflow-wrap: anywhere;
}
.state {
  color: var(--text2);
  font-size: var(--fs-sm);
  line-height: var(--lh-body);
  padding: var(--space-5) 0;
  text-align: center;
}
.preview-frame {
  margin: var(--space-3) 0;
  display: flex;
  justify-content: center;
  max-height: 65vh;
}
.preview-frame img,
.preview-frame video {
  max-width: 100%;
  max-height: 65vh;
  object-fit: contain;
  border-radius: var(--radius-md);
}
.text-preview {
  margin-bottom: var(--space-3);
  max-height: 45vh;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg);
  color: var(--text2);
  padding: var(--space-3);
  font-family: var(--font);
  font-size: var(--fs-sm);
  line-height: var(--lh-body);
  white-space: pre-wrap;
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-1);
}
.btn-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 40px;
  padding: var(--space-2) var(--space-4);
  border-radius: var(--radius-sm);
  font-size: var(--fs-sm);
  text-decoration: none;
  transition: transform var(--duration-fast) var(--ease-out),
    background var(--duration-fast) var(--ease-out),
    border-color var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}
.btn-link:hover { transform: translateY(-1px); }
.btn-link:active { transform: translateY(0) scale(0.97); }

@keyframes panel-in {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}

@media (max-width: 560px) {
  .details-grid { grid-template-columns: 1fr; }
  .preview-frame img,
  .preview-frame video { max-height: 46vh; }
  .actions { flex-direction: column; align-items: stretch; }
}
</style>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useRoute } from 'vue-router'
import { decodeFileToken, formatBytes, publicApiFileUrl } from '../lib/api'
import { decryptBlobWithPassword, isRustypasteEncryptedBlob, type EncryptedMetadata } from '../lib/e2ee'

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
const error = ref('')
const objectUrl = ref('')
const textPreview = ref('')
const metadata = ref<EncryptedMetadata | null>(null)
const decrypted = ref(false)

const isImage = computed(() => metadata.value?.type.startsWith('image/') ?? false)
const isVideo = computed(() => metadata.value?.type.startsWith('video/') ?? false)
const isText = computed(() => metadata.value?.type.startsWith('text/') ?? false)

function clearObjectUrl() {
  if (objectUrl.value) URL.revokeObjectURL(objectUrl.value)
  objectUrl.value = ''
}

async function downloadPayload(): Promise<Blob> {
  const apiUrl = publicApiFileUrl(fileName.value)
  const attempts = [apiUrl, `${apiUrl}?download=true`, `${apiUrl}?raw=1`]
  for (const url of attempts) {
    const response = await fetch(url, { cache: 'no-store' })
    if (!response.ok) continue
    const payload = await response.blob()
    if (await isRustypasteEncryptedBlob(payload)) return payload
  }
  throw new Error('File not found or could not be downloaded')
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
  try {
    const payload = await downloadPayload()
    const result = await decryptBlobWithPassword(payload, password.value, salt.value)
    clearObjectUrl()
    metadata.value = result.metadata
    objectUrl.value = URL.createObjectURL(result.blob)
    if (result.metadata.type.startsWith('text/')) {
      textPreview.value = await result.blob.text()
    }
    decrypted.value = true
  } catch (e: any) {
    error.value = e.message ?? 'Decryption failed'
  } finally {
    decrypting.value = false
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
            <label>Password</label>
            <input
              v-model="password"
              type="password"
              autocomplete="current-password"
              placeholder="Enter password…"
              autofocus
              :disabled="decrypting"
            />
          </div>
          <div v-if="error" class="error-msg">{{ error }}</div>
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
  padding: 16px;
}
.pw-panel {
  width: min(640px, 100%);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg1);
  padding: 20px;
}
.pw-topline {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 20px;
}
.seal-mark {
  width: 34px;
  height: 34px;
  border: 1px solid var(--border2);
  border-radius: var(--radius);
  background: var(--bg2);
  color: var(--accent);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.eyebrow {
  color: var(--accent);
  font-size: 12px;
}
.subline {
  color: var(--text3);
  font-size: 11px;
}
.pw-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.field label {
  color: var(--text);
  font-size: 12px;
}
.field input {
  width: 100%;
}
.error-msg {
  color: var(--red-h);
  font-size: 12px;
}
.details-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 14px;
}
.details-grid div {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  padding: 9px 10px;
}
.details-grid span {
  display: block;
  color: var(--text3);
  font-size: 10px;
  text-transform: uppercase;
  margin-bottom: 3px;
}
.details-grid strong {
  color: var(--text2);
  font-size: 12px;
  font-weight: 400;
  overflow-wrap: anywhere;
}
.state {
  color: var(--text2);
  font-size: 12px;
  padding: 20px 0;
  text-align: center;
}
.preview-frame {
  margin: 14px 0;
  display: flex;
  justify-content: center;
  max-height: 65vh;
}
.preview-frame img,
.preview-frame video {
  max-width: 100%;
  max-height: 65vh;
  object-fit: contain;
}
.text-preview {
  margin-bottom: 14px;
  max-height: 45vh;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--text2);
  padding: 12px;
  font-family: var(--font);
  font-size: 12px;
  white-space: pre-wrap;
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}
.btn-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 30px;
  padding: 5px 12px;
  border-radius: var(--radius);
  font-size: 12px;
  text-decoration: none;
}
@media (max-width: 560px) {
  .details-grid { grid-template-columns: 1fr; }
  .actions { flex-direction: column; }
}
</style>

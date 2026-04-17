<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import {
  decryptEncryptedBlob,
  isRustypasteEncryptedBlob,
  rawFileNameFromPublicPath,
  type EncryptedMetadata,
} from '../lib/e2ee'
import { formatBytes, publicApiFileUrl } from '../lib/api'
import { useNotificationStore } from '../stores/notifications'

const route = useRoute()
const notificationStore = useNotificationStore()
const loading = ref(true)
const error = ref('')
const objectUrl = ref('')
const textPreview = ref('')
const metadata = ref<EncryptedMetadata | null>(null)
const status = ref('Preparing secure download…')

const fileName = computed(() => {
  const fromQuery = String(route.query.f ?? '')
  if (fromQuery) return fromQuery
  const fromPath = rawFileNameFromPublicPath(window.location.pathname)
  if (fromPath) return fromPath
  return ''
})
const key = computed(() => String(route.query.k ?? ''))
const isImage = computed(() => metadata.value?.type.startsWith('image/') ?? false)
const isVideo = computed(() => metadata.value?.type.startsWith('video/') ?? false)
const isText = computed(() => metadata.value?.type.startsWith('text/') ?? false)

function clearObjectUrl() {
  if (objectUrl.value) URL.revokeObjectURL(objectUrl.value)
  objectUrl.value = ''
}

async function downloadEncryptedPayload(name: string): Promise<Blob> {
  const apiUrl = publicApiFileUrl(name)
  const attempts = [apiUrl, `${apiUrl}?download=true`, `${apiUrl}?raw=1`]
  let sawHtmlPayload = false
  let sawNotFound = false

  for (const url of attempts) {
    const response = await fetch(url, { cache: 'no-store' })
    if (!response.ok) {
      if (response.status === 404) sawNotFound = true
      continue
    }
    const payload = await response.blob()
    if (await isRustypasteEncryptedBlob(payload)) return payload
    const contentType = response.headers.get('content-type') ?? payload.type
    if (contentType.includes('text/html')) {
      sawHtmlPayload = true
      continue
    }
    throw new Error('This file is not a rustypaste encrypted file')
  }

  if (sawNotFound) throw new Error('File not found or expired')
  if (sawHtmlPayload) throw new Error('Could not load encrypted payload on this device. Try opening the same link in your browser.')
  throw new Error('Download failed')
}

async function load() {
  clearObjectUrl()
  metadata.value = null
  textPreview.value = ''
  error.value = ''

  if (!fileName.value || !key.value) {
    error.value = 'Missing encrypted file or key'
    loading.value = false
    return
  }

  loading.value = true
  status.value = 'Downloading encrypted file…'
  try {
    status.value = 'Decrypting in your browser…'
    const payload = await downloadEncryptedPayload(fileName.value)
    const decrypted = await decryptEncryptedBlob(payload, key.value)
    metadata.value = decrypted.metadata
    objectUrl.value = URL.createObjectURL(decrypted.blob)
    if (decrypted.metadata.type.startsWith('text/')) {
      textPreview.value = await decrypted.blob.text()
    }
    status.value = 'Decrypted locally. No plaintext was stored on the host.'
    notificationStore.push(status.value)
  } catch (e: any) {
    error.value = e.message ?? 'Could not decrypt file'
  } finally {
    loading.value = false
  }
}

watch([fileName, key], () => void load(), { immediate: true })

onBeforeUnmount(clearObjectUrl)
</script>

<template>
  <main class="decrypt-page">
    <section class="decrypt-panel">
      <div class="decrypt-topline">
        <div class="seal-mark">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M12 3 4 7v5c0 5 3.4 8 8 9 4.6-1 8-4 8-9V7l-8-4Z"/>
            <path d="M9.5 12.5 11 14l3.5-4"/>
          </svg>
        </div>
        <div>
          <div class="eyebrow">Encrypted paste</div>
          <div class="subline">Decrypting in your browser</div>
        </div>
      </div>

      <div v-if="loading" class="state">Decrypting…</div>
      <div v-else-if="error" class="state error">{{ error }}</div>

      <template v-else-if="metadata && objectUrl">
        <div class="file-heading">
          <div>
            <h1>{{ metadata.name }}</h1>
            <p class="meta">{{ metadata.type }} · {{ formatBytes(metadata.size) }}</p>
          </div>
          <span class="key-pill">key local</span>
        </div>

        <div class="details-grid">
          <div>
            <span>File size</span>
            <strong>{{ formatBytes(metadata.size) }}</strong>
          </div>
          <div>
            <span>Uploader</span>
            <strong>{{ metadata.uploader || 'Unknown (token user)' }}</strong>
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
          <a class="btn-link btn-primary" :href="objectUrl" :download="metadata.name">Download decrypted file</a>
          <a class="btn-link btn-ghost" :href="objectUrl" target="_blank" rel="noopener">Open</a>
        </div>
      </template>
    </section>
  </main>
</template>

<style scoped>
.decrypt-page {
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.decrypt-panel {
  width: min(720px, 100%);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg1);
  padding: 20px;
}
.decrypt-topline {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 16px;
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
.file-heading {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
}
h1 {
  color: var(--text);
  font-size: 16px;
  overflow-wrap: anywhere;
}
.key-pill {
  border: 1px solid var(--border2);
  border-radius: var(--radius);
  color: var(--text3);
  font-size: 11px;
  padding: 3px 7px;
  white-space: nowrap;
}
.details-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin-top: 14px;
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
.meta {
  color: var(--text3);
  font-size: 12px;
  margin-top: 4px;
}
.state {
  color: var(--text2);
  font-size: 12px;
  padding: 20px 0;
  text-align: center;
}
.error { color: var(--red-h); }
.preview-frame {
  margin: 16px 0;
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
  margin-top: 16px;
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
  margin-top: 16px;
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
  .details-grid {
    grid-template-columns: 1fr;
  }
  .actions {
    justify-content: stretch;
    flex-direction: column;
  }
}
</style>

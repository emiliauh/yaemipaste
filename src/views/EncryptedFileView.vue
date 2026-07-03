<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import {
  decryptEncryptedBlob,
  isRustypasteEncryptedBlob,
  rememberEncryptedFile,
  rawFileNameFromPublicPath,
  type EncryptedMetadata,
} from '../lib/e2ee'
import { decodeFileToken, formatBytes, publicApiFileUrl, publicFileUrl, publicSiteOrigin, resolveFileName } from '../lib/api'
import { useNotificationStore } from '../stores/notifications'

const route = useRoute()
const notificationStore = useNotificationStore()
const loading = ref(true)
const error = ref('')
const objectUrl = ref('')
const textPreview = ref('')
const metadata = ref<EncryptedMetadata | null>(null)
const status = ref('Preparing encrypted paste…')
const resolvedFileName = ref('')

const fileName = computed(() => {
  const pk = String(route.params.filekey ?? '')
  if (pk) return decodeFileToken(pk.split('+')[0])
  // backward compat: old query params
  const fromQuery = String(route.query.f ?? '')
  if (fromQuery) return fromQuery
  return rawFileNameFromPublicPath(window.location.pathname) || ''
})
const key = computed(() => {
  const pk = String(route.params.filekey ?? '')
  if (pk.includes('+')) return pk.split('+')[1]
  return String(route.query.k ?? '')
})
const isImage = computed(() => metadata.value?.type.startsWith('image/') ?? false)
const isVideo = computed(() => metadata.value?.type.startsWith('video/') ?? false)
const isText = computed(() => metadata.value?.type.startsWith('text/') ?? false)

function clearObjectUrl() {
  if (objectUrl.value) URL.revokeObjectURL(objectUrl.value)
  objectUrl.value = ''
}

async function downloadEncryptedPayload(name: string): Promise<Blob> {
  const publicUrl = publicFileUrl(name)
  const apiUrl = publicApiFileUrl(name)
  const attempts = [publicUrl, `${apiUrl}?raw=1`, `${apiUrl}?download=true`, apiUrl]
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
  resolvedFileName.value = ''

  if (!fileName.value || !key.value) {
    error.value = 'Missing encrypted file or key'
    loading.value = false
    return
  }

  loading.value = true
  status.value = 'Downloading encrypted file…'
  try {
    const resolvedName = await resolveFileName(fileName.value)
    resolvedFileName.value = resolvedName
    const startedAt = performance.now()
    const payload = await downloadEncryptedPayload(resolvedName)
    const decrypted = await decryptEncryptedBlob(payload, key.value)
    metadata.value = decrypted.metadata
    rememberEncryptedFile(resolvedName, key.value, decrypted.metadata, publicSiteOrigin())
    objectUrl.value = URL.createObjectURL(decrypted.blob)
    if (decrypted.metadata.type.startsWith('text/')) {
      textPreview.value = await decrypted.blob.text()
    }
    const seconds = Math.max(0.1, (performance.now() - startedAt) / 1000)
    status.value = `Decrypted in ${seconds.toFixed(1)} seconds`
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
          <div class="subline">{{ status }}</div>
        </div>
      </div>

      <div v-if="loading" class="state">Decrypting…</div>
      <div v-else-if="error" class="state error">{{ error }}</div>

      <template v-else-if="metadata && objectUrl">
        <div class="file-heading">
          <div>
            <h1>Encrypted paste</h1>
            <p class="meta">{{ metadata.name }} · {{ metadata.type }} · {{ formatBytes(metadata.size) }}</p>
          </div>
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
  padding: var(--space-4);
}
.decrypt-panel {
  width: min(720px, 100%);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg1);
  padding: var(--space-5);
  animation: panel-in var(--duration-base) var(--ease-out) both;
}
.decrypt-topline {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
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
.file-heading {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--space-4);
}
h1 {
  color: var(--text);
  font-size: var(--fs-h1);
  line-height: var(--lh-tight);
  overflow-wrap: anywhere;
}
.key-pill {
  border: 1px solid var(--border2);
  border-radius: var(--radius-sm);
  color: var(--text2);
  font-size: var(--fs-xs);
  padding: var(--space-1) var(--space-2);
  white-space: nowrap;
}
.details-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-2);
  margin-top: var(--space-3);
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
.meta {
  color: var(--text2);
  font-size: var(--fs-sm);
  line-height: var(--lh-body);
  margin-top: var(--space-1);
}
.state {
  color: var(--text2);
  font-size: var(--fs-sm);
  line-height: var(--lh-body);
  padding: var(--space-5) 0;
  text-align: center;
}
.error { color: var(--red-h); }
.preview-frame {
  margin: var(--space-4) 0;
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
  margin-top: var(--space-4);
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
  margin-top: var(--space-4);
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
  .details-grid {
    grid-template-columns: 1fr;
  }
  .preview-frame img,
  .preview-frame video {
    max-height: 46vh;
  }
  .actions {
    align-items: stretch;
    flex-direction: column;
  }
}
</style>

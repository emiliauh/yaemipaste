<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { type PasteFile, formatBytes, publicFileUrl, shareUrl } from '../lib/api'
import { encryptedShareUrl, getStoredEncryptedFile } from '../lib/e2ee'
import { useNotificationStore } from '../stores/notifications'

const props = defineProps<{
  file: PasteFile
  sourceUrl?: string
  displayName?: string
  mimeType?: string
  textContent?: string
  loading?: boolean
}>()
const emit = defineEmits<{ close: []; download: [file: PasteFile] }>()
const notificationStore = useNotificationStore()

const url = computed(() => props.sourceUrl ?? publicFileUrl(props.file.file_name))
const storedEncrypted = computed(() => getStoredEncryptedFile(props.file.file_name))
function isRpencFileName(value: string): boolean {
  return /\.rpenc(?:$|[?#])/i.test(value.trim())
}
const hasEncryptedSuffix = computed(() =>
  isRpencFileName(props.file.file_name)
  || isRpencFileName(props.displayName ?? '')
  || isRpencFileName(url.value),
)
const isEncrypted = computed(() => !!storedEncrypted.value || hasEncryptedSuffix.value)
const isDecryptedBlobSource = computed(() => url.value.startsWith('blob:'))
const encryptedPreviewLocked = computed(() => isEncrypted.value && !isDecryptedBlobSource.value)
const copyUrl = computed(() => {
  if (storedEncrypted.value) {
    return encryptedShareUrl(props.file.file_name, storedEncrypted.value.key, storedEncrypted.value.origin)
  }
  return url.value.startsWith('blob:') ? shareUrl(props.file.file_name) : url.value
})
const name = computed(() => props.displayName ?? props.file.file_name)
const isImage = computed(() => props.mimeType?.startsWith('image/') ?? /\.(jpe?g|png|gif|webp|avif|svg|bmp|tiff?|ico)$/i.test(name.value))
const isVideo = computed(() => props.mimeType?.startsWith('video/') ?? /\.(mp4|webm|mov|avi|mkv|ogv|m4v|3gp)$/i.test(name.value))
const isText = computed(() => props.mimeType?.startsWith('text/') ?? /\.(txt|md|markdown|csv|log|json|xml|ya?ml|toml|ini|conf|cfg|js|ts|tsx|jsx|py|rs|go|java|c|cc|cpp|h|hpp|css|html?)$/i.test(name.value))
const isFallbackPreview = computed(() => !isImage.value && !isVideo.value && !isText.value)
const sizeLabel = computed(() => formatBytes(props.file.file_size ?? 0))
const textPreview = ref('')
const textError = ref('')
let lastCopySignature = ''
let lastCopyAt = 0

function getAuthToken(): string {
  return localStorage.getItem('rp_token') ?? sessionStorage.getItem('rp_token') ?? ''
}

async function loadTextPreview() {
  textPreview.value = ''
  textError.value = ''
  if (!isText.value || props.loading || encryptedPreviewLocked.value) return
  if (typeof props.textContent === 'string') {
    textPreview.value = props.textContent.length > 32_000 ? `${props.textContent.slice(0, 32_000)}\n\n…` : props.textContent
    return
  }
  try {
    const headers: Record<string, string> = {}
    if (url.value.includes('/api/')) {
      const token = getAuthToken().trim()
      if (token) headers.Authorization = token
    }
    const response = await fetch(url.value, {
      cache: 'no-store',
      headers,
    })
    if (!response.ok) throw new Error('Could not load text preview')
    const payload = await response.text()
    textPreview.value = payload.length > 32_000 ? `${payload.slice(0, 32_000)}\n\n…` : payload
  } catch {
    textError.value = 'Could not load text preview'
  }
}

watch([url, isText, () => props.loading, encryptedPreviewLocked], () => {
  void loadTextPreview()
}, { immediate: true })

async function copyToClipboard(value: string, label: string) {
  const signature = `${label}:${value}`
  const now = Date.now()
  if (signature === lastCopySignature && now - lastCopyAt < 750) return
  lastCopySignature = signature
  lastCopyAt = now
  try {
    await navigator.clipboard.writeText(value)
    notificationStore.push(`Copied ${label}`)
  } catch {
    notificationStore.push(`Could not copy ${label}`, 'error')
  }
}
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <div class="modal">
      <div class="modal-header">
        <span class="modal-title">{{ name }}</span>
        <button class="btn-ghost btn-icon-close" aria-label="Close preview" @click="emit('close')">✕</button>
      </div>
      <div class="modal-body">
        <div v-if="props.loading" class="preview-loading">
          <span class="loading-spinner" aria-hidden="true"></span>
          <span>Loading preview…</span>
        </div>
        <div v-else-if="encryptedPreviewLocked" class="fallback-preview">
          <div class="fallback-title">No inline preview available</div>
          <div class="fallback-note">This is an encrypted file. Add the decryption key/password to preview it.</div>
          <div class="fallback-meta">File size: {{ sizeLabel }}</div>
          <button class="btn-primary fallback-download" @click="emit('download', props.file)">Download file</button>
        </div>
        <img v-else-if="isImage" :src="url" class="preview-img" />
        <video v-else-if="isVideo" :src="url" controls class="preview-video" />
        <pre v-else-if="isText" class="text-preview">{{ textError || textPreview }}</pre>
        <div v-else class="fallback-preview">
          <div class="fallback-title">No inline preview available</div>
          <div class="fallback-meta">File size: {{ sizeLabel }}</div>
          <button class="btn-primary fallback-download" @click="emit('download', props.file)">Download file</button>
        </div>
      </div>
      <div class="modal-footer">
        <span class="footer-size">Size: {{ sizeLabel }}</span>
        <div class="footer-actions">
          <a v-if="!isFallbackPreview" :href="url" target="_blank" rel="noopener" class="link">Open in tab</a>
          <button class="btn-ghost btn-copy" @click="copyToClipboard(copyUrl, 'URL')">
            Copy
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: var(--modal-bg);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
  animation: backdrop-in var(--duration-fast) var(--ease-out) both;
}
.modal {
  background: var(--bg1);
  border: 1px solid var(--border2);
  border-radius: var(--radius-lg);
  max-width: 90vw;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 300px;
  animation: modal-in var(--duration-base) var(--ease-out) both;
}
.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border);
  font-size: var(--fs-sm);
  color: var(--text2);
}
.modal-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 400px; }
.modal-body {
  flex: 1;
  overflow: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
}
.preview-img { max-width: 100%; max-height: 70vh; object-fit: contain; border-radius: var(--radius-md); }
.preview-video { max-width: 100%; max-height: 70vh; border-radius: var(--radius-md); }
.text-preview {
  width: min(680px, 100%);
  max-height: 56vh;
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
.preview-loading {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--fs-body);
  color: var(--text2);
}
.loading-spinner {
  width: 14px;
  height: 14px;
  border-radius: var(--radius-full);
  border: 2px solid var(--border2);
  border-top-color: var(--orange);
  animation: spin 0.8s linear infinite;
}
.fallback-preview {
  min-width: min(360px, 100%);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  align-items: flex-start;
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: var(--space-4);
}
.fallback-title {
  font-size: var(--fs-body);
  font-weight: 600;
  line-height: var(--lh-tight);
  color: var(--text);
}
.fallback-meta {
  font-size: var(--fs-sm);
  color: var(--text2);
}
.fallback-note {
  font-size: var(--fs-sm);
  line-height: var(--lh-body);
  color: var(--accent-h);
}
.fallback-download {
  font-size: var(--fs-sm);
  border-radius: var(--radius-sm);
  text-decoration: none;
  transition: transform var(--duration-fast) var(--ease-out);
}
.fallback-download:hover:not(:disabled) { transform: translateY(-1px); }
.fallback-download:active:not(:disabled) { transform: translateY(0) scale(0.97); }
.modal-footer {
  padding: var(--space-2) var(--space-4);
  border-top: 1px solid var(--border);
  font-size: var(--fs-sm);
  display: flex;
  justify-content: space-between;
  gap: var(--space-2);
  align-items: center;
}
.footer-size { color: var(--text2); }
.footer-actions {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
}
.link {
  color: var(--text2);
  text-decoration: none;
  transition: color var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out);
}
.link:hover { color: var(--text); transform: translateY(-1px); }
.link:active { transform: translateY(0) scale(0.97); }
.btn-icon-close {
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-sm);
  transition: transform var(--duration-fast) var(--ease-out),
    border-color var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}
.btn-icon-close:hover { transform: translateY(-1px); }
.btn-icon-close:active { transform: translateY(0) scale(0.9); }
.btn-copy {
  padding: var(--space-1) var(--space-3);
  font-size: var(--fs-sm);
  border-radius: var(--radius-sm);
  transition: transform var(--duration-fast) var(--ease-out),
    border-color var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}
.btn-copy:hover { transform: translateY(-1px); }
.btn-copy:active { transform: translateY(0) scale(0.97); }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes backdrop-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes modal-in {
  from { opacity: 0; transform: translateY(12px) scale(0.98); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

@media (max-width: 600px) {
  .modal {
    max-width: 96vw;
    max-height: 92dvh;
  }
  .modal-header {
    padding: var(--space-2) var(--space-3);
  }
  .modal-body {
    padding: var(--space-3);
  }
  .preview-img,
  .preview-video {
    max-height: 50vh;
  }
  .fallback-preview {
    width: 100%;
  }
  .modal-footer {
    flex-direction: column;
    align-items: stretch;
    gap: var(--space-2);
  }
  .footer-actions {
    flex-direction: column;
    align-items: stretch;
  }
  .footer-actions .link,
  .footer-actions .btn-copy {
    width: 100%;
    min-height: 40px;
  }
}
</style>

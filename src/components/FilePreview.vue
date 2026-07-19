<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { getAuthJwt, type PasteFile, fileUrl, formatBytes, shareUrl } from '../lib/api'
import { decryptBlobWithPassword, decryptEncryptedBlob, encryptedShareUrl, getStoredEncryptedFile, isRustypasteEncryptedBlob } from '../lib/e2ee'
import { useNotificationStore } from '../stores/notifications'
import { usePublicSettings } from '../lib/publicSettings'

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
const { publicSettings, refreshPublicSettings } = usePublicSettings()

const decryptedUrl = ref('')
const decryptedName = ref('')
const detectedEncrypted = ref(false)
const encryptedPayload = ref<Blob | null>(null)
const decryptionKey = ref('')
const decryptionBusy = ref(false)
const decryptionError = ref('')
const url = computed(() => decryptedUrl.value || props.sourceUrl || fileUrl(props.file.file_name))
const isAdminContentUrl = computed(() => url.value.includes('/auth/admin/uploads/content'))
// Admin upload records may use a server-side storage name while the local
// encryption record is keyed by the original display name.
const storedEncrypted = computed(() =>
  getStoredEncryptedFile(props.file.file_name)
  ?? (props.displayName ? getStoredEncryptedFile(props.displayName) : null),
)
function isRpencFileName(value: string): boolean {
  return /\.rpenc(?:$|[?#])/i.test(value.trim())
}
const hasEncryptedSuffix = computed(() =>
  isRpencFileName(props.file.file_name)
  || isRpencFileName(props.displayName ?? '')
  || isRpencFileName(url.value),
)
const isEncrypted = computed(() => !!storedEncrypted.value || hasEncryptedSuffix.value || detectedEncrypted.value)
const isDecryptedBlobSource = computed(() => url.value.startsWith('blob:'))
const encryptedPreviewLocked = computed(() => isEncrypted.value && !isDecryptedBlobSource.value)
const previewPageUrl = computed(() => shareUrl(props.file.file_name))
const rawFileUrl = computed(() => {
  // Track the live server setting so copied raw links update from /api to its configured API origin.
  void publicSettings.value.base_api_url
  return new URL(fileUrl(props.file.file_name), window.location.origin).toString()
})
const copyUrl = computed(() => {
  if (storedEncrypted.value) {
    return encryptedShareUrl(props.file.file_name, storedEncrypted.value.key, storedEncrypted.value.origin)
  }
  return isAdminContentUrl.value || url.value.startsWith('blob:') ? shareUrl(props.file.file_name) : url.value
})
const name = computed(() => decryptedName.value || props.displayName || props.file.file_name)
const EXPIRY_SUFFIX = '(?:\\.\\d{6,})?'
const isImage = computed(() => props.mimeType?.startsWith('image/') ?? new RegExp(`\\.(jpe?g|png|gif|webp|avif|svg|bmp|tiff?|ico)${EXPIRY_SUFFIX}$`, 'i').test(name.value))
const isVideo = computed(() => props.mimeType?.startsWith('video/') ?? new RegExp(`\\.(mp4|webm|mov|avi|mkv|ogv|m4v|3gp)${EXPIRY_SUFFIX}$`, 'i').test(name.value))
const isText = computed(() => props.mimeType?.startsWith('text/') ?? new RegExp(`\\.(txt|md|markdown|csv|log|json|xml|ya?ml|toml|ini|conf|cfg|js|ts|tsx|jsx|py|rs|go|java|c|cc|cpp|h|hpp|css|html?)${EXPIRY_SUFFIX}$`, 'i').test(name.value))
const isFallbackPreview = computed(() => !isImage.value && !isVideo.value && !isText.value)
const sizeLabel = computed(() => formatBytes(props.file.file_size ?? 0))
const textPreview = ref('')
const textError = ref('')
const textLoading = ref(false)
const textPreviewTruncated = ref(false)
const previewImage = ref<HTMLImageElement | null>(null)
const mediaUrl = ref('')
const copyMenuOpen = ref(false)
const openMenuOpen = ref(false)
const TEXT_PREVIEW_BYTES = 256 * 1024
const TEXT_PREVIEW_CHARS = 32_000

function getAuthToken(): string {
  return localStorage.getItem('rp_token') ?? sessionStorage.getItem('rp_token') ?? ''
}

function contentHeaders(): Record<string, string> {
  if (isAdminContentUrl.value) {
    const jwt = getAuthJwt().trim()
    return jwt ? { Authorization: `Bearer ${jwt}` } : {}
  }
  const token = getAuthToken().trim()
  return token ? { Authorization: token } : {}
}

function clearDecryptedUrl() {
  if (decryptedUrl.value.startsWith('blob:')) URL.revokeObjectURL(decryptedUrl.value)
  decryptedUrl.value = ''
  decryptedName.value = ''
}

async function decryptPreview() {
  const key = decryptionKey.value.trim()
  if (!key) {
    decryptionError.value = 'Decryption key is required.'
    return
  }
  decryptionBusy.value = true
  decryptionError.value = ''
  try {
    let payload = encryptedPayload.value
    if (!payload) {
      const response = await fetch(props.sourceUrl ?? fileUrl(props.file.file_name), { cache: 'no-store', headers: contentHeaders() })
      if (!response.ok) throw new Error('Could not download encrypted payload')
      payload = await response.blob()
    }
    if (!(await isRustypasteEncryptedBlob(payload))) throw new Error('File payload is not encrypted')
    const stored = storedEncrypted.value
    const decrypted = stored?.key.startsWith('pw:')
      ? await decryptBlobWithPassword(payload, key, stored.key.slice(3))
      : await decryptEncryptedBlob(payload, key)
    clearDecryptedUrl()
    decryptedUrl.value = URL.createObjectURL(decrypted.blob)
    decryptedName.value = decrypted.metadata.name
  } catch (error) {
    decryptionError.value = error instanceof Error ? error.message : 'Could not decrypt file'
  } finally {
    decryptionBusy.value = false
    // Keys belong only in memory for the single decryption operation.
    decryptionKey.value = ''
  }
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

function truncateText(value: string, forceTruncated = false) {
  const truncated = forceTruncated || value.length > TEXT_PREVIEW_CHARS
  return {
    text: truncated ? `${value.slice(0, TEXT_PREVIEW_CHARS)}\n\n…` : value,
    truncated,
  }
}

async function readTextPreviewFromResponse(response: Response) {
  const reader = response.body?.getReader()
  if (!reader) {
    const payload = await response.clone().blob()
    return truncateText(
      await payload.slice(0, TEXT_PREVIEW_BYTES).text(),
      payload.size > TEXT_PREVIEW_BYTES,
    )
  }

  const decoder = new TextDecoder()
  let text = ''
  let bytes = 0
  let truncated = false

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    text += decoder.decode(value, { stream: true })
    if (bytes >= TEXT_PREVIEW_BYTES || text.length >= TEXT_PREVIEW_CHARS) {
      truncated = true
      await reader.cancel()
      break
    }
    await yieldToBrowser()
  }
  text += decoder.decode()
  return truncateText(text, truncated)
}

async function loadTextPreview() {
  textPreview.value = ''
  textError.value = ''
  textPreviewTruncated.value = false
  textLoading.value = false
  if (!isText.value || props.loading || encryptedPreviewLocked.value) return
  textLoading.value = true
  try {
    if (typeof props.textContent === 'string') {
      await yieldToBrowser()
      const preview = truncateText(props.textContent)
      textPreview.value = preview.text
      textPreviewTruncated.value = preview.truncated
      return
    }
    const response = await fetch(url.value, {
      cache: 'no-store',
      headers: contentHeaders(),
    })
    if (!response.ok) throw new Error('Could not load text preview')
    const payload = await response.clone().blob()
    if (await isRustypasteEncryptedBlob(payload)) {
      encryptedPayload.value = payload
      detectedEncrypted.value = true
      return
    }
    const preview = await readTextPreviewFromResponse(response)
    textPreview.value = preview.text
    textPreviewTruncated.value = preview.truncated
  } catch {
    textError.value = 'Could not load text preview'
  } finally {
    textLoading.value = false
  }
}

function clearMediaUrl() {
  if (mediaUrl.value.startsWith('blob:')) URL.revokeObjectURL(mediaUrl.value)
  mediaUrl.value = ''
}

let mediaRequest = 0
async function loadMediaPreview() {
  const request = ++mediaRequest
  clearMediaUrl()
  if (!isImage.value && !isVideo.value) return
  if (!isAdminContentUrl.value) {
    mediaUrl.value = url.value
    return
  }
  try {
    const response = await fetch(url.value, {
      cache: 'no-store',
      headers: contentHeaders(),
    })
    if (!response.ok) throw new Error('Could not load media preview')
    const payload = await response.blob()
    if (await isRustypasteEncryptedBlob(payload)) {
      encryptedPayload.value = payload
      detectedEncrypted.value = true
      return
    }
    const objectUrl = URL.createObjectURL(payload)
    if (request !== mediaRequest) {
      URL.revokeObjectURL(objectUrl)
      return
    }
    mediaUrl.value = objectUrl
  } catch {
    if (request === mediaRequest) mediaUrl.value = ''
  }
}

watch([url, isText, () => props.loading, encryptedPreviewLocked], () => {
  void loadTextPreview()
}, { immediate: true })
watch([url, isImage, isVideo], () => {
  void loadMediaPreview()
}, { immediate: true })

async function copyPreviewContent() {
  copyMenuOpen.value = false
  openMenuOpen.value = false
  try {
    if (isText.value) {
      if (textLoading.value || textError.value) throw new Error('Text preview is not ready')
      await writeTextToClipboard(textPreview.value)
    } else if (isImage.value) {
      if (!previewImage.value?.complete || !previewImage.value.naturalWidth) throw new Error('Image preview is not ready')
      if (!('ClipboardItem' in window) || !navigator.clipboard?.write) throw new Error('This browser does not allow image clipboard access')
      const canvas = document.createElement('canvas')
      canvas.width = previewImage.value.naturalWidth
      canvas.height = previewImage.value.naturalHeight
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Could not prepare image')
      context.drawImage(previewImage.value, 0, 0)
      const png = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((value) => value ? resolve(value) : reject(new Error('Could not encode image')), 'image/png')
      })
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
    } else {
      await writeTextToClipboard(copyUrl.value)
    }
    notificationStore.push('Copied!')
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not copy preview content'
    notificationStore.push(message, 'error')
  }
}

async function copyUrlValue(value: string) {
  copyMenuOpen.value = false
  openMenuOpen.value = false
  try {
    await writeTextToClipboard(value)
    notificationStore.push('Copied!')
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not copy URL'
    notificationStore.push(message, 'error')
  }
}

async function writeTextToClipboard(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value)
    return
  }
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  const copied = document.execCommand('copy')
  textarea.remove()
  if (!copied) throw new Error('Could not copy preview content')
}

function onWindowKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    if (openMenuOpen.value) {
      openMenuOpen.value = false
      return
    }
    if (copyMenuOpen.value) {
      copyMenuOpen.value = false
      return
    }
    emit('close')
    return
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
    event.preventDefault()
    void copyPreviewContent()
  }
}

function onWindowClick() {
  copyMenuOpen.value = false
  openMenuOpen.value = false
}

onMounted(() => {
  void refreshPublicSettings()
  window.addEventListener('keydown', onWindowKeydown)
  window.addEventListener('click', onWindowClick)
})
onBeforeUnmount(() => {
  mediaRequest += 1
  clearMediaUrl()
  clearDecryptedUrl()
  window.removeEventListener('keydown', onWindowKeydown)
  window.removeEventListener('click', onWindowClick)
})
</script>

<template>
  <div v-if="encryptedPreviewLocked" class="modal-backdrop" @click.self="emit('close')">
    <div class="password-modal" role="dialog" aria-modal="true" aria-labelledby="encrypted-preview-title">
      <div class="password-modal-header"><strong id="encrypted-preview-title">Preview encrypted file</strong><button class="modal-close btn-ghost" :disabled="decryptionBusy" aria-label="Close key prompt" @click="emit('close')">✕</button></div>
      <div class="password-modal-copy">Enter the decryption {{ storedEncrypted?.key.startsWith('pw:') ? 'password' : 'key' }} to preview this file in-app.</div>
      <div class="password-form"><label>Decryption {{ storedEncrypted?.key.startsWith('pw:') ? 'password' : 'key' }}<input v-model="decryptionKey" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" :placeholder="storedEncrypted?.key.startsWith('pw:') ? 'Enter decryption password' : 'Paste decryption key'" :disabled="decryptionBusy" @keydown.enter.prevent="decryptPreview" /></label></div>
      <div v-if="decryptionError" class="password-modal-error">{{ decryptionError }}</div>
      <div class="password-modal-actions"><button class="btn-ghost" :disabled="decryptionBusy" @click="emit('close')">Cancel</button><button class="btn-primary" :disabled="decryptionBusy || !decryptionKey.trim()" @click="decryptPreview">{{ decryptionBusy ? 'Decrypting…' : 'Preview file' }}</button></div>
    </div>
  </div>
  <div v-else class="modal-backdrop" @click.self="emit('close')">
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
      :aria-label="`Preview ${name}`"
      :class="{
        'modal-text': isText,
        'modal-media': isImage || isVideo,
        'modal-fallback': isFallbackPreview || encryptedPreviewLocked,
      }"
    >
      <div class="modal-header">
        <span class="modal-title">{{ name }}</span>
        <button class="btn-ghost btn-icon-close" aria-label="Close preview" @click="emit('close')">✕</button>
      </div>
      <div class="modal-body">
        <div v-if="props.loading" class="preview-loading" aria-live="polite">
          <div class="loading-copy">
            <span class="loading-kicker">Loading preview</span>
            <span>Fetching the file details and reserving the preview space.</span>
          </div>
          <div class="preview-skeleton" aria-hidden="true">
            <span></span>
            <span></span>
            <span></span>
          </div>
        </div>
        <img v-else-if="isImage && mediaUrl" ref="previewImage" :src="mediaUrl" class="preview-img" />
        <video v-else-if="isVideo && mediaUrl" :src="mediaUrl" controls class="preview-video" />
        <div v-else-if="isImage || isVideo" class="preview-loading" aria-live="polite">
          <span class="loading-kicker">Preparing media preview</span>
        </div>
        <div v-else-if="isText" class="text-preview-shell">
          <div v-if="textLoading" class="text-loading" aria-live="polite">
            <span class="loading-kicker">Preparing text preview</span>
            <div class="preview-skeleton" aria-hidden="true">
              <span></span>
              <span></span>
              <span></span>
            </div>
          </div>
          <pre v-else class="text-preview" :class="{ error: textError }">{{ textError || textPreview }}</pre>
          <p v-if="textPreviewTruncated && !textError" class="preview-note">Preview truncated for performance. Open in a tab or download to view the full file.</p>
        </div>
        <div v-else class="fallback-preview">
          <div class="fallback-title">No inline preview available</div>
          <div class="fallback-meta">File size: {{ sizeLabel }}</div>
          <button class="btn-primary fallback-download" @click="emit('download', props.file)">Download file</button>
        </div>
      </div>
      <div class="modal-footer">
        <span class="footer-size">Size: {{ sizeLabel }}</span>
        <div class="footer-actions">
          <div class="open-actions">
            <button
              class="btn-ghost btn-open"
              aria-label="Open file preview or raw content"
              aria-haspopup="menu"
              :aria-expanded="openMenuOpen"
              @click.stop="openMenuOpen = !openMenuOpen; copyMenuOpen = false"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M6.5 3.5H3.75A1.25 1.25 0 0 0 2.5 4.75v7.5a1.25 1.25 0 0 0 1.25 1.25h7.5a1.25 1.25 0 0 0 1.25-1.25V9.5" />
                <path d="M9 2.5h4.5V7M13.25 2.75 7.5 8.5" />
              </svg>
              <span>Open</span>
              <svg class="copy-chevron" viewBox="0 0 16 16" aria-hidden="true">
                <path d="m4.5 6 3.5 3.5L11.5 6" />
              </svg>
            </button>
            <div v-if="openMenuOpen" class="copy-menu open-menu" role="menu" aria-label="Open options">
              <a :href="previewPageUrl" target="_blank" rel="noopener" role="menuitem" class="copy-menu-item">
                <span class="copy-menu-title">Open preview</span>
                <span class="copy-menu-note">Share page in a new tab</span>
              </a>
              <a :href="rawFileUrl" target="_blank" rel="noopener" role="menuitem" class="copy-menu-item">
                <span class="copy-menu-title">Open raw</span>
                <span class="copy-menu-note">Direct file in a new tab</span>
              </a>
            </div>
          </div>
          <div class="copy-actions">
            <button
              class="btn-ghost btn-copy"
              aria-label="Copy file content or URL"
              aria-haspopup="menu"
              :aria-expanded="copyMenuOpen"
              @click.stop="copyMenuOpen = !copyMenuOpen; openMenuOpen = false"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <rect x="5.25" y="5.25" width="7.25" height="8.25" rx="1" />
                <path d="M10.25 5.25V3.5a1 1 0 0 0-1-1H3.5a1 1 0 0 0-1 1v7.25a1 1 0 0 0 1 1h1.75" />
              </svg>
              <span>Copy</span>
              <svg class="copy-chevron" viewBox="0 0 16 16" aria-hidden="true">
                <path d="m4.5 6 3.5 3.5L11.5 6" />
              </svg>
            </button>
            <div v-if="copyMenuOpen" class="copy-menu" role="menu" aria-label="Copy options">
              <button role="menuitem" @click="copyPreviewContent">
                <span class="copy-menu-title">Copy content</span>
                <span class="copy-menu-note">{{ isImage ? 'Image' : isText ? 'Preview text' : 'File link' }}</span>
              </button>
              <button role="menuitem" @click="copyUrlValue(previewPageUrl)">
                <span class="copy-menu-title">Copy preview URL</span>
                <span class="copy-menu-note">Share page</span>
              </button>
              <button role="menuitem" @click="copyUrlValue(rawFileUrl)">
                <span class="copy-menu-title">Copy raw URL</span>
                <span class="copy-menu-note">Direct file</span>
              </button>
            </div>
          </div>
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
  position: relative;
  background: linear-gradient(180deg, color-mix(in srgb, var(--bg1) 94%, white 6%), var(--bg1));
  border: 1px solid color-mix(in srgb, var(--border2) 78%, transparent);
  border-radius: var(--radius-lg);
  box-shadow:
    0 28px 90px rgb(0 0 0 / 0.34),
    0 0 0 1px rgb(255 255 255 / 0.03) inset;
  width: min(520px, 90vw);
  max-width: 90vw;
  max-height: min(640px, 84dvh);
  display: flex;
  flex-direction: column;
  /* Menus belong to the modal's action bar but must be able to escape the
     card so they are not clipped at the card edge or by the mobile footer. */
  overflow: visible;
  min-width: 300px;
  animation: modal-in var(--duration-base) var(--ease-out) both;
}
.modal.modal-text {
  width: min(720px, 90vw);
  max-height: min(560px, 78dvh);
}
.modal.modal-media {
  width: auto;
  max-width: 90vw;
  max-height: 90dvh;
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
.modal-text .modal-body {
  flex: 0 1 auto;
  align-items: stretch;
}
.preview-img { max-width: 100%; max-height: 70vh; object-fit: contain; border-radius: var(--radius-md); }
.preview-video { max-width: 100%; max-height: 70vh; border-radius: var(--radius-md); }
.text-preview-shell {
  display: grid;
  gap: var(--space-2);
  width: min(680px, 100%);
}
.text-preview {
  max-height: min(380px, 50dvh);
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
.text-preview.error {
  color: var(--red-h);
  border-color: color-mix(in srgb, var(--red-h) 30%, var(--border));
  background: color-mix(in srgb, var(--red-h) 8%, var(--bg));
}
.preview-note {
  color: var(--accent-h);
  font-size: var(--fs-xs);
  line-height: var(--lh-body);
}
.preview-loading,
.text-loading {
  width: min(520px, 100%);
  display: grid;
  gap: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg2);
  color: var(--text2);
  padding: var(--space-4);
  font-size: var(--fs-sm);
  line-height: var(--lh-body);
}
.loading-copy {
  display: grid;
  gap: var(--space-1);
}
.loading-kicker {
  color: var(--text);
  font-size: var(--fs-body);
  font-weight: 600;
}
.preview-skeleton {
  display: grid;
  gap: var(--space-2);
}
.preview-skeleton span {
  display: block;
  height: 12px;
  border-radius: var(--radius-full);
  background: linear-gradient(90deg, var(--bg), var(--bg1), var(--bg));
  background-size: 220% 100%;
  animation: skeleton-sweep 1.4s var(--ease-out) infinite;
}
.preview-skeleton span:first-child { width: 92%; }
.preview-skeleton span:nth-child(2) { width: 74%; }
.preview-skeleton span:last-child { width: 46%; }
.fallback-preview {
  width: min(440px, 100%);
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  align-items: flex-start;
  background: linear-gradient(145deg, var(--bg2), var(--bg1));
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: calc(var(--space-4) + var(--space-1));
}
.encrypted-preview-heading { display: flex; align-items: flex-start; gap: var(--space-2); }
.encrypted-preview-icon { display: grid; place-items: center; width: 28px; height: 28px; border: 1px solid var(--border2); border-radius: 50%; color: var(--accent-h); font-size: 20px; }
.fallback-key { display: grid; width: 100%; gap: 6px; font-size: var(--fs-sm); font-weight: 600; color: var(--text); }
.fallback-key input { width: 100%; box-sizing: border-box; }
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
.password-modal { width: min(440px, 100%); box-sizing: border-box; border: 1px solid var(--border2); border-radius: var(--radius-lg); background: radial-gradient(circle at 100% 0%, color-mix(in srgb, var(--bg3) 34%, transparent), transparent 34%), var(--bg1); padding: var(--space-4); box-shadow: 0 24px 64px color-mix(in srgb, var(--shadow) 90%, transparent); }
.password-modal-header { display: flex; justify-content: space-between; align-items: center; gap: var(--space-3); margin-bottom: var(--space-2); }
.password-modal-header strong { color: var(--text); font-size: var(--fs-h2); }
.password-modal-copy { color: var(--text2); font-size: var(--fs-sm); line-height: var(--lh-body); margin-bottom: var(--space-2); }
.password-form { display: flex; flex-direction: column; gap: var(--space-2); margin-top: var(--space-3); }
.password-form label { display: flex; flex-direction: column; gap: var(--space-1); color: var(--text2); font-size: var(--fs-xs); }
.password-form input { background: var(--bg); border-color: var(--border); }
.password-modal-error { margin-top: var(--space-2); padding: var(--space-2) var(--space-3); border: 1px solid var(--error-border); border-radius: var(--radius-sm); background: var(--danger-bg); color: var(--red-h); font-size: var(--fs-sm); }
.password-modal-actions { margin-top: var(--space-4); display: flex; justify-content: flex-end; gap: var(--space-2); }
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
  gap: var(--space-1);
}
.open-actions {
  position: relative;
}
.btn-open {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 92px;
  box-sizing: border-box;
  padding: var(--space-1) var(--space-2);
  font-size: var(--fs-sm);
  border-radius: var(--radius-sm);
}
.btn-open,
.btn-copy {
  height: 32px;
  min-height: 32px;
}
.btn-open:focus-visible,
.btn-copy:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.btn-open svg,
.btn-copy svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.35;
}
.copy-actions {
  position: relative;
}
.copy-chevron {
  width: 12px !important;
  height: 12px !important;
  margin-left: 2px;
}
.copy-menu {
  position: absolute;
  right: 0;
  bottom: calc(100% + 8px);
  z-index: 20;
  width: 220px;
  padding: 4px;
  border: 1px solid var(--border2);
  border-radius: var(--radius-md);
  background: var(--bg1);
  box-shadow: 0 14px 34px rgb(0 0 0 / 0.28);
  animation: copy-menu-in var(--duration-fast) var(--ease-out) both;
}
.open-menu { left: 0; right: auto; }
.copy-actions .copy-menu { left: auto; right: 0; }
.copy-menu button,
.copy-menu-item {
  display: grid;
  width: 100%;
  gap: 2px;
  padding: 8px 10px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text);
  text-align: left;
  cursor: pointer;
  text-decoration: none;
}
.copy-menu button:hover,
.copy-menu button:focus-visible,
.copy-menu-item:hover,
.copy-menu-item:focus-visible {
  background: var(--surface2);
  outline: none;
}
.copy-menu-title {
  font-size: var(--fs-sm);
  font-weight: 500;
}
.copy-menu-note {
  color: var(--text3);
  font-size: var(--fs-xs);
}
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
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 92px;
  box-sizing: border-box;
  padding: var(--space-1) var(--space-2);
  font-size: var(--fs-sm);
  border-radius: var(--radius-sm);
  transition: transform var(--duration-fast) var(--ease-out),
    border-color var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}
.btn-copy:hover { transform: none; }
.btn-copy:active { transform: translateY(0) scale(0.97); }

@keyframes skeleton-sweep {
  from { background-position: 120% 0; }
  to { background-position: -120% 0; }
}
@keyframes backdrop-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes modal-in {
  from { opacity: 0; transform: translateY(12px) scale(0.98); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes copy-menu-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}

@media (prefers-reduced-motion: reduce) {
  .modal-backdrop,
  .modal,
  .preview-skeleton span,
  .copy-menu {
    animation: none;
  }
}

@media (max-width: 600px) {
  .modal {
    width: min(520px, 96vw);
    max-width: 96vw;
    max-height: 92dvh;
  }
  .modal.modal-text {
    width: min(680px, 96vw);
    max-height: 84dvh;
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
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    align-items: stretch;
    gap: var(--space-1);
  }
  .open-actions {
    min-width: 0;
  }
  .footer-actions .btn-open,
  .footer-actions .btn-copy {
    width: 100%;
    height: 40px;
    min-height: 40px;
  }
  .copy-menu {
    right: 0;
    width: min(220px, calc(100vw - 32px));
    max-width: calc(100vw - 32px);
    box-sizing: border-box;
  }
  .open-menu {
    left: 0;
    right: auto;
  }
  .copy-actions .copy-menu {
    left: auto;
    right: 0;
  }
}
</style>

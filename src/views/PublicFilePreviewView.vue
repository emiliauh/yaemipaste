<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { decodeFileToken, effectivePublicMimeType, encodeFileToken, formatBytes, getAuthUsername, getPublicFileMeta, preferredPublicFileName, publicDownloadUrl, publicFileUrl, resolveFileLookup, type PublicFileMeta } from '../lib/api'
import { rawFileNameFromPublicPath } from '../lib/e2ee'

const route = useRoute()
const loading = ref(true)
const error = ref('')
const textPreview = ref('')
const meta = ref<PublicFileMeta | null>(null)
const resolvedFileName = ref('')
const resolvedOwner = ref('')
const routeFileKey = computed(() => String(route.params.filekey ?? ''))

const requestedFileName = computed(() => {
  const pk = String(route.params.filekey ?? '')
  if (pk) return decodeFileToken(pk.split('+')[0])
  // backward compat: old query params
  const fromPath = rawFileNameFromPublicPath(window.location.pathname)
  if (fromPath) return fromPath
  const publicPath = String(route.query.p ?? '')
  if (publicPath) return rawFileNameFromPublicPath(publicPath)
  return String(route.query.f ?? '').replace(/^\/+/, '')
})

const rawUrl = computed(() => (resolvedFileName.value ? publicFileUrl(resolvedFileName.value) : ''))
const rawRouteUrl = computed(() => {
  const token = routeFileKey.value.split('+')[0]
  if (token) return `/file/${token}/raw`
  return resolvedFileName.value ? `/file/${encodeFileToken(resolvedFileName.value)}/raw` : ''
})
const downloadUrl = computed(() => {
  const token = routeFileKey.value.split('+')[0]
  if (token) return `/file/${token}/download`
  return resolvedFileName.value ? publicDownloadUrl(resolvedFileName.value) : ''
})
const mediaUrl = computed(() => rawUrl.value)
const displayFileName = computed(() => preferredPublicFileName(meta.value, resolvedFileName.value || requestedFileName.value))
const effectiveMimeType = computed(() => effectivePublicMimeType(meta.value, resolvedFileName.value || requestedFileName.value))
const isImage = computed(() => effectiveMimeType.value.startsWith('image/'))
const isVideo = computed(() => effectiveMimeType.value.startsWith('video/'))
const isText = computed(() => effectiveMimeType.value.startsWith('text/'))
const isPdf = computed(() => effectiveMimeType.value === 'application/pdf')
const canPreviewInline = computed(() => isImage.value || isVideo.value || isText.value || isPdf.value)
const resolvedUploader = computed(() => {
  const apiUploader = meta.value?.uploader?.trim() ?? ''
  if (apiUploader && apiUploader !== 'Unknown (token user)' && apiUploader !== 'Unknown') return apiUploader
  const tokenOwner = resolvedOwner.value.trim()
  if (tokenOwner && tokenOwner !== 'Unknown (token user)' && tokenOwner !== 'Unknown') return tokenOwner
  const localUser = getAuthUsername().trim()
  return localUser && localUser !== 'token-user' ? localUser : apiUploader || 'Unknown'
})

const openInAppExtensions = new Set([
  'sxcu',
  'exe',
  'msi',
  'dmg',
  'pkg',
  'appimage',
  'deb',
  'rpm',
  'apk',
  'ipa',
  'jar',
  'ps1',
  'bat',
  'cmd',
  'reg',
])

const shouldPreferAppOpen = computed(() => {
  const name = meta.value?.download_name || resolvedFileName.value || requestedFileName.value
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return openInAppExtensions.has(ext)
})
const shouldShowSecondaryAction = computed(() => shouldPreferAppOpen.value || canPreviewInline.value)

const openActionHref = computed(() => {
  if (shouldPreferAppOpen.value) return downloadUrl.value
  return rawRouteUrl.value
})

async function loadTextPreview() {
  textPreview.value = ''
  if (!isText.value || !rawUrl.value) return
  const response = await fetch(rawUrl.value, { cache: 'no-store' })
  if (!response.ok) {
    console.error('Text preview fetch failed', {
      fileName: resolvedFileName.value,
      url: rawUrl.value,
      status: response.status,
      statusText: response.statusText,
    })
    throw new Error('Could not load text preview')
  }
  const payload = await response.text()
  textPreview.value = payload.length > 32_000 ? `${payload.slice(0, 32_000)}\n\n…` : payload
}

async function load() {
  error.value = ''
  loading.value = true
  meta.value = null
  textPreview.value = ''
  resolvedFileName.value = ''
  resolvedOwner.value = ''
  if (!requestedFileName.value) {
    error.value = 'Missing file name'
    loading.value = false
    return
  }

  try {
    const resolved = await resolveFileLookup(requestedFileName.value)
    const fileName = resolved.fileName
    if (fileName.toLowerCase().endsWith('.rpenc')) {
      throw new Error("This file is encrypted but the link doesn't include a decryption key. Ask whoever shared this file for the full link.")
    }
    resolvedFileName.value = fileName
    resolvedOwner.value = resolved.uploader ?? ''
    meta.value = await getPublicFileMeta(fileName)
    await loadTextPreview()
  } catch (e: any) {
    error.value = e.message ?? 'Could not load preview'
  } finally {
    loading.value = false
  }
}

watch(requestedFileName, () => void load(), { immediate: true })
</script>

<template>
  <main class="preview-page">
    <section class="preview-card">
      <h1>File preview</h1>

      <div v-if="loading" class="state">Loading…</div>
      <div v-else-if="error" class="state error">{{ error }}</div>

      <template v-else-if="meta">
        <div class="meta-grid">
          <div>
            <span>File name</span>
            <strong>{{ displayFileName }}</strong>
          </div>
          <div>
            <span>Upload date</span>
            <strong>{{ meta.upload_date_utc ?? 'Unknown' }}</strong>
          </div>
          <div>
            <span>Owner</span>
            <strong>{{ resolvedUploader }}</strong>
          </div>
          <div>
            <span>Type</span>
            <strong>{{ effectiveMimeType }} · {{ formatBytes(meta.file_size) }}</strong>
          </div>
        </div>

        <div v-if="isImage" class="preview-frame">
          <img :src="mediaUrl" :alt="displayFileName" />
        </div>
        <div v-else-if="isVideo" class="preview-frame">
          <video :src="mediaUrl" controls />
        </div>
        <pre v-else-if="isText" class="text-preview">{{ textPreview }}</pre>
        <iframe
          v-else-if="isPdf"
          class="preview-pdf"
          :src="rawUrl"
          title="PDF preview"
        />
        <div v-else class="no-preview">
          <p>No preview available for this file type.</p>
          <p>Use <strong>Download file</strong> to open it locally.</p>
        </div>

        <div class="actions">
          <a class="btn-link btn-primary" :href="downloadUrl">Download file</a>
          <a
            v-if="shouldShowSecondaryAction"
            class="btn-link btn-ghost"
            :href="openActionHref"
            :target="shouldPreferAppOpen ? undefined : '_blank'"
            rel="noopener"
            :download="shouldPreferAppOpen ? meta.download_name : undefined"
          >
            {{ shouldPreferAppOpen ? 'Open in app' : 'View raw' }}
          </a>
        </div>
      </template>
    </section>
  </main>
</template>

<style scoped>
.preview-page {
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}

.preview-card {
  width: min(820px, 100%);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg1);
  padding: 20px;
}

h1 {
  font-size: 16px;
  color: var(--text);
  margin-bottom: 14px;
}

.meta-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.meta-grid > div {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  padding: 9px 10px;
}

.meta-grid span {
  display: block;
  color: var(--text3);
  font-size: 10px;
  text-transform: uppercase;
  margin-bottom: 4px;
}

.meta-grid strong {
  color: var(--text2);
  font-size: 12px;
  font-weight: 400;
  overflow-wrap: anywhere;
}

.preview-frame {
  margin-top: 14px;
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

.preview-pdf {
  margin-top: 14px;
  width: 100%;
  min-height: 65vh;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
}

.no-preview {
  margin-top: 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--text2);
  padding: 14px;
  font-size: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.text-preview {
  margin-top: 14px;
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

.state {
  color: var(--text2);
  font-size: 12px;
  padding: 14px 0;
}

.state.error {
  color: var(--red-h);
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
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

@media (max-width: 620px) {
  .meta-grid {
    grid-template-columns: 1fr;
  }

  .actions {
    flex-direction: column;
  }
}
</style>

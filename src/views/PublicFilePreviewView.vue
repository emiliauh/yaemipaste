<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { decodeFileToken, formatBytes, getPublicFileMeta, publicFileUrl, type PublicFileMeta } from '../lib/api'
import { rawFileNameFromPublicPath } from '../lib/e2ee'

const route = useRoute()
const loading = ref(true)
const error = ref('')
const textPreview = ref('')
const meta = ref<PublicFileMeta | null>(null)

const fileName = computed(() => {
  const pk = String(route.params.filekey ?? '')
  if (pk) return decodeFileToken(pk.split('+')[0])
  // backward compat: old query params
  const fromPath = rawFileNameFromPublicPath(window.location.pathname)
  if (fromPath) return fromPath
  const publicPath = String(route.query.p ?? '')
  if (publicPath) return rawFileNameFromPublicPath(publicPath)
  return String(route.query.f ?? '').replace(/^\/+/, '')
})

const publicUrl = computed(() => (fileName.value ? publicFileUrl(fileName.value) : ''))
const previewUrl = computed(() => (publicUrl.value ? `${publicUrl.value}?raw=1` : ''))
const downloadUrl = computed(() => (publicUrl.value ? `${publicUrl.value}?download=true` : ''))
const isImage = computed(() => meta.value?.mime_type.startsWith('image/') ?? false)
const isVideo = computed(() => meta.value?.mime_type.startsWith('video/') ?? false)
const isText = computed(() => meta.value?.mime_type.startsWith('text/') ?? false)
const isPdf = computed(() => meta.value?.mime_type === 'application/pdf')

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
  const name = meta.value?.download_name || fileName.value
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return openInAppExtensions.has(ext)
})

const openActionHref = computed(() => (shouldPreferAppOpen.value ? downloadUrl.value : previewUrl.value))

async function loadTextPreview() {
  textPreview.value = ''
  if (!isText.value || !previewUrl.value) return
  const response = await fetch(previewUrl.value, { cache: 'no-store' })
  if (!response.ok) throw new Error('Could not load text preview')
  const payload = await response.text()
  textPreview.value = payload.length > 32_000 ? `${payload.slice(0, 32_000)}\n\n…` : payload
}

async function load() {
  error.value = ''
  loading.value = true
  meta.value = null
  textPreview.value = ''
  if (!fileName.value) {
    error.value = 'Missing file name'
    loading.value = false
    return
  }

  try {
    meta.value = await getPublicFileMeta(fileName.value)
    await loadTextPreview()
  } catch (e: any) {
    error.value = e.message ?? 'Could not load preview'
  } finally {
    loading.value = false
  }
}

watch(fileName, () => void load(), { immediate: true })
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
            <strong>{{ meta.display_name }}</strong>
          </div>
          <div>
            <span>Upload date</span>
            <strong>{{ meta.upload_date_utc ?? 'Unknown' }}</strong>
          </div>
          <div>
            <span>Owner</span>
            <strong>{{ meta.uploader }}</strong>
          </div>
          <div>
            <span>Type</span>
            <strong>{{ meta.mime_type }} · {{ formatBytes(meta.file_size) }}</strong>
          </div>
        </div>

        <div v-if="isImage" class="preview-frame">
          <img :src="previewUrl" :alt="meta.display_name" />
        </div>
        <div v-else-if="isVideo" class="preview-frame">
          <video :src="previewUrl" controls />
        </div>
        <pre v-else-if="isText" class="text-preview">{{ textPreview }}</pre>
        <iframe
          v-else-if="isPdf"
          class="preview-pdf"
          :src="previewUrl"
          title="PDF preview"
        />
        <iframe
          v-else
          class="preview-pdf"
          :src="previewUrl"
          title="File preview"
        />

        <div class="actions">
          <a class="btn-link btn-primary" :href="downloadUrl" :download="meta.download_name">Download file</a>
          <a
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

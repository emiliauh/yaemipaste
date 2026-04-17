<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { decryptEncryptedBlob, encryptedDownloadUrl, type EncryptedMetadata } from '../lib/e2ee'

const route = useRoute()
const loading = ref(true)
const error = ref('')
const objectUrl = ref('')
const metadata = ref<EncryptedMetadata | null>(null)

const fileName = computed(() => String(route.query.f ?? ''))
const key = computed(() => String(route.query.k ?? ''))
const isImage = computed(() => metadata.value?.type.startsWith('image/') ?? false)
const isVideo = computed(() => metadata.value?.type.startsWith('video/') ?? false)

function clearObjectUrl() {
  if (objectUrl.value) URL.revokeObjectURL(objectUrl.value)
  objectUrl.value = ''
}

async function load() {
  clearObjectUrl()
  metadata.value = null
  error.value = ''

  if (!fileName.value || !key.value) {
    error.value = 'Missing encrypted file or key'
    loading.value = false
    return
  }

  loading.value = true
  try {
    const response = await fetch(encryptedDownloadUrl(fileName.value))
    if (!response.ok) throw new Error(response.status === 404 ? 'File not found or expired' : 'Download failed')
    const decrypted = await decryptEncryptedBlob(await response.blob(), key.value)
    metadata.value = decrypted.metadata
    objectUrl.value = URL.createObjectURL(decrypted.blob)
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
      <div class="eyebrow">Encrypted paste</div>

      <div v-if="loading" class="state">Decrypting…</div>
      <div v-else-if="error" class="state error">{{ error }}</div>

      <template v-else-if="metadata && objectUrl">
        <h1>{{ metadata.name }}</h1>
        <p class="meta">{{ metadata.type }} · {{ metadata.size }} bytes</p>

        <div v-if="isImage" class="preview-frame">
          <img :src="objectUrl" :alt="metadata.name" />
        </div>
        <div v-else-if="isVideo" class="preview-frame">
          <video :src="objectUrl" controls />
        </div>
        <p v-else class="state">Ready to download.</p>

        <div class="actions">
          <a class="btn-link btn-primary" :href="objectUrl" :download="metadata.name">Download</a>
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
.eyebrow {
  color: var(--orange);
  font-size: 12px;
  margin-bottom: 10px;
}
h1 {
  color: var(--text);
  font-size: 16px;
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
</style>

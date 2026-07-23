<script setup lang="ts">
import { useRoute } from 'vue-router'
import { fileUrl, resolveFileName } from '../lib/api'
import { usePublicSettings } from '../lib/publicSettings'

const route = useRoute()
const { refreshPublicSettings } = usePublicSettings()
const fileKey = String(route.params.filekey ?? '')
const filePart = fileKey.split('+')[0]

async function redirect() {
  try {
    await refreshPublicSettings()
    const fileName = await resolveFileName(filePart)
    if (fileName.endsWith('.rpenc')) {
      window.location.replace(`/file/${encodeURIComponent(fileKey)}/preview${window.location.hash}`)
      return
    }
    window.location.replace(fileUrl(fileName))
  } catch {
    // Keep public-link failures out of the authenticated workspace fallback.
    window.location.replace(`/file/${encodeURIComponent(fileKey)}/preview`)
  }
}

void redirect()
</script>

<template></template>

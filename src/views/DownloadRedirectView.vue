<script setup lang="ts">
import { useRoute } from 'vue-router'
import { encodeFileToken, publicDownloadFileUrl, resolveFileName } from '../lib/api'
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
    const rawUrl = publicDownloadFileUrl(fileName)
    const previewUrl = `/file/${encodeFileToken(fileName)}/preview`
    const link = document.createElement('a')
    link.href = rawUrl
    link.download = fileName
    link.rel = 'noopener'
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => window.location.replace(previewUrl), 150)
  } catch {
    window.location.replace('/files')
  }
}

void redirect()
</script>

<template></template>

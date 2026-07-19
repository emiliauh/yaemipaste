<script setup lang="ts">
import { useRoute } from 'vue-router'
import { encodeFileToken, publicFileUrl, resolveFileName } from '../lib/api'

const route = useRoute()
const filePart = String(route.params.filekey ?? '').split('+')[0]

async function redirect() {
  try {
    const fileName = await resolveFileName(filePart)
    const rawUrl = publicFileUrl(fileName)
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

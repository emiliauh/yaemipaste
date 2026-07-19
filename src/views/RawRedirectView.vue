<script setup lang="ts">
import { useRoute } from 'vue-router'
import { fileUrl, resolveFileName } from '../lib/api'
import { usePublicSettings } from '../lib/publicSettings'

const route = useRoute()
const { refreshPublicSettings } = usePublicSettings()
const filePart = String(route.params.filekey ?? '').split('+')[0]

async function redirect() {
  try {
    await refreshPublicSettings()
    const fileName = await resolveFileName(filePart)
    window.location.replace(fileUrl(fileName))
  } catch {
    window.location.replace('/files')
  }
}

void redirect()
</script>

<template></template>

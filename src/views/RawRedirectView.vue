<script setup lang="ts">
import { useRoute } from 'vue-router'
import { fileUrl, resolveFileName } from '../lib/api'

const route = useRoute()
const filePart = String(route.params.filekey ?? '').split('+')[0]

async function redirect() {
  try {
    const fileName = await resolveFileName(filePart)
    window.location.replace(fileUrl(fileName))
  } catch {
    window.location.replace('/files')
  }
}

void redirect()
</script>

<template></template>
